// Web Audio: the reference piano (Salamander samples, tuned to exact pitch,
// with a synth fallback) and the microphone → pitch-frame pipeline.

import { PitchDetector } from './pitch.js';
import { SAMPLES } from './samples.js';
import { midiToFreq } from './music.js';

const SAMPLE_DIR = new URL('../samples/', import.meta.url);
const WINDOW = 2048;
const HOP = 512;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map(); // sample midi → AudioBuffer
    this.voices = new Set();
  }

  get running() {
    return !!this.ctx;
  }

  now() {
    return this.ctx.currentTime;
  }

  /** Must be called from a user gesture. onFrame gets { t, freq, clarity, rms }. */
  async start(onFrame) {
    if (!navigator.mediaDevices || !window.AudioWorkletNode) {
      throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    try {
      ctx.resume(); // inside the gesture, before any await
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(ctx.destination);

      // Raw mic: the browser's voice processing bends and gates pitch.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });

      await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
      const decim = Math.max(1, Math.round(ctx.sampleRate / 48000));
      const rate = ctx.sampleRate / decim;
      this.frameDt = HOP / rate;
      const detector = new PitchDetector(rate, WINDOW);
      const win = new Float32Array(WINDOW);
      let hops = 0;

      const src = ctx.createMediaStreamSource(this.stream);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 55;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      const tap = new AudioWorkletNode(ctx, 'pm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { decim, hop: HOP },
      });
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(hp).connect(lp).connect(tap).connect(mute).connect(ctx.destination);

      tap.port.onmessage = (e) => {
        win.copyWithin(0, HOP);
        win.set(e.data, WINDOW - HOP);
        hops++;
        const r = detector.detect(win);
        r.t = hops * this.frameDt;
        onFrame(r);
      };

      // Give the samples a moment; anything not loaded in time falls back to the synth.
      await Promise.race([this._loadSamples(), new Promise((res) => setTimeout(res, 4000))]);
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.buffers.clear();
    this.voices.clear();
  }

  _loadSamples() {
    const ctx = this.ctx;
    return Promise.all(
      SAMPLES.map(async (s) => {
        try {
          const res = await fetch(new URL(s.file, SAMPLE_DIR));
          if (!res.ok) throw new Error(res.status);
          const buf = await ctx.decodeAudioData(await res.arrayBuffer());
          if (this.ctx === ctx) this.buffers.set(s.midi, buf);
        } catch {
          /* synth fallback covers it */
        }
      }),
    );
  }

  /** Schedule one note. `at` is an AudioContext time. */
  playNote(midi, { at = this.now() + 0.05, dur = 1.3, vel = 0.8, timbre = 'piano' } = {}) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.connect(this.master);
    const sources = [];

    const key = SAMPLES.reduce((best, s) => (Math.abs(s.midi - midi) < Math.abs(best.midi - midi) ? s : best));
    const buffer = timbre === 'piano' ? this.buffers.get(key.midi) : null;

    if (buffer) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      // Transpose from the nearest sample and cancel that sample's measured detune.
      src.playbackRate.value = Math.pow(2, (midi - key.midi) / 12 - key.cents / 1200);
      out.gain.setValueAtTime(vel, at);
      src.connect(out);
      sources.push(src);
    } else if (timbre === 'sine') {
      const osc = ctx.createOscillator();
      osc.frequency.value = midiToFreq(midi);
      out.gain.setValueAtTime(0, at);
      out.gain.linearRampToValueAtTime(vel * 0.5, at + 0.02);
      osc.connect(out);
      sources.push(osc);
    } else {
      // Synth piano: exact harmonics, upper partials dying faster.
      out.gain.setValueAtTime(vel * 0.45, at);
      [1, 0.5, 0.28, 0.16, 0.09, 0.05].forEach((amp, i) => {
        const f = midiToFreq(midi) * (i + 1);
        if (f > 9000) return;
        const osc = ctx.createOscillator();
        osc.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(amp, at + 0.008);
        g.gain.setTargetAtTime(amp * 0.12, at + 0.008, 1.1 / (1 + 0.55 * i));
        osc.connect(g).connect(out);
        sources.push(osc);
      });
    }

    out.gain.setTargetAtTime(0, at + dur, 0.05); // release
    const voice = { out, sources };
    this.voices.add(voice);
    sources.forEach((s) => {
      s.start(at);
      s.stop(at + dur + 0.6);
    });
    sources[0].onended = () => {
      out.disconnect();
      this.voices.delete(voice);
    };
    return at + dur;
  }

  /** Cut everything that is sounding or scheduled. */
  stopAll() {
    if (!this.ctx) return;
    const t = this.now();
    for (const v of this.voices) {
      v.out.gain.cancelScheduledValues(t);
      v.out.gain.setTargetAtTime(0, t, 0.015);
      v.sources.forEach((s) => {
        try {
          s.stop(t + 0.12);
        } catch {
          /* not started yet */
        }
      });
    }
  }
}
