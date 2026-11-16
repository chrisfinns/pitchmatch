// Web Audio: the reference piano (Salamander samples, tuned to exact pitch,
// with a synth fallback) and the microphone → pitch-frame pipeline.

import { PitchDetector } from './pitch.js';
import { SAMPLES } from './samples.js';
import { midiToFreq } from './music.js';

const SAMPLE_DIR = new URL('../samples/', import.meta.url);
const WINDOW = 2048;
const HOP = 512;

/** iPhone / iPad (every browser there is WebKit). */
export const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

const DRIVE = 3; // gain into the limiter
const TRIM = 1.3; // gain out of it, placing the ceiling just under full scale

/**
 * Output stage: a limiter, then a soft clipper as a safety net. A piano note is
 * a tall spike followed by a quiet tail, so without this the level you can set
 * is capped by the spike. Limiting lets the body of the note sit ~10 dB louder
 * and nothing can clip. Returns { input, side, output }.
 */
export function outputChain(ctx, { drive = DRIVE, trim = TRIM } = {}) {
  const input = ctx.createGain();
  input.gain.value = drive;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -16;
  limiter.knee.value = 6;
  limiter.ratio.value = 16;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.2;

  // Soft clip: linear up to 0.8, then eased to a ceiling just under full scale.
  // The curve spans inputs of ±2, hence the 0.5 pre-gain.
  const pre = ctx.createGain();
  pre.gain.value = 0.5 * trim;
  const clip = ctx.createWaveShaper();
  const curve = new Float32Array(2049);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 4 - 2;
    const a = Math.abs(x);
    curve[i] = Math.sign(x) * (a <= 0.8 ? a : 0.8 + 0.17 * Math.tanh((a - 0.8) / 0.17));
  }
  clip.curve = curve;
  clip.oversample = '2x';

  input.connect(limiter).connect(pre).connect(clip);

  // Clicks and result sounds join after the limiter, so their level is whatever
  // they are given instead of being squashed up to the piano's.
  const side = ctx.createGain();
  side.connect(pre);
  return { input, side, output: clip };
}

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

  /**
   * Must be called from a user gesture. onFrame gets { t, freq, clarity, rms }.
   * speakerFix: on iOS, work around the phone turning playback down while the
   * mic is live (see _connectOutput).
   */
  async start(onFrame, { speakerFix = true } = {}) {
    if (!navigator.mediaDevices || !window.AudioWorkletNode) {
      throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    try {
      ctx.resume(); // inside the gesture, before any await
      const chain = outputChain(ctx);
      this.master = chain.input;
      this.side = chain.side;
      this.fixed = IS_IOS && speakerFix;
      if (this.fixed && navigator.audioSession) {
        try {
          navigator.audioSession.type = 'play-and-record'; // say so up front rather than let iOS switch mid-stream
        } catch {
          /* older Safari */
        }
      }
      this._connectOutput(chain.output);

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

  /**
   * iOS drops Web Audio's volume sharply while the microphone is capturing. Audio
   * played by a media element isn't affected, so on iOS the output is sent to an
   * <audio> element through a MediaStream instead of straight to the speakers.
   * If that can't start, fall back to the normal route.
   */
  _connectOutput(node) {
    const ctx = this.ctx;
    if (this.fixed && ctx.createMediaStreamDestination) {
      try {
        const dest = ctx.createMediaStreamDestination();
        node.connect(dest);
        const el = new Audio();
        el.setAttribute('playsinline', '');
        el.srcObject = dest.stream;
        this.outEl = el;
        const direct = () => {
          if (this.ctx !== ctx || this.outEl !== el) return;
          this.outEl = null;
          node.disconnect(dest);
          node.connect(ctx.destination);
        };
        const playing = el.play(); // still inside the user gesture
        if (playing) playing.catch(direct);
        return;
      } catch {
        this.outEl = null;
      }
    }
    node.connect(ctx.destination);
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.outEl) {
      this.outEl.pause();
      this.outEl.srcObject = null;
      this.outEl = null;
    }
    if (this.fixed && navigator.audioSession) {
      try {
        navigator.audioSession.type = 'auto';
      } catch {
        /* older Safari */
      }
    }
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.buffers.clear();
    this.voices.clear();
    this.clickBuf = null;
    this.noiseBuf = null;
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
      out.gain.setValueAtTime(vel * (key.gain || 1), at); // level-matched across the keyboard
      src.connect(out);
      sources.push(src);
    } else if (timbre === 'sine') {
      const osc = ctx.createOscillator();
      osc.frequency.value = midiToFreq(midi);
      out.gain.setValueAtTime(0, at);
      out.gain.linearRampToValueAtTime(vel * 0.07, at + 0.02);
      osc.connect(out);
      sources.push(osc);
    } else {
      // Synth piano: exact harmonics, upper partials dying faster.
      out.gain.setValueAtTime(vel * 0.14, at);
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

  /**
   * One metronome tick for the count-in. A few milliseconds of high-passed
   * noise: easy to hear on a phone speaker, and with no pitch of its own, so
   * the detector can never mistake it for a voice if the mic picks it up.
   */
  playClick(at) {
    const ctx = this.ctx;
    if (!this.clickBuf) {
      const n = Math.round(ctx.sampleRate * 0.04);
      this.clickBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = this.clickBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.006));
    }
    const src = ctx.createBufferSource();
    src.buffer = this.clickBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const out = ctx.createGain();
    out.gain.value = 0.4;
    src.connect(hp).connect(out).connect(this.side);
    const voice = { out, sources: [src] };
    this.voices.add(voice);
    src.onended = () => {
      out.disconnect();
      this.voices.delete(voice);
    };
    src.start(at);
  }

  /**
   * Result sounds, for practising with your eyes closed. They are built so that
   * nothing with a foreign pitch lands in your ear before the next note:
   *
   *   good    a bright ding — at the target note itself, a few octaves up
   *   great   two dings (a note was locked in)
   *   slide   a noise swoosh that rises (dir 1: scooped up) or falls (dir -1: slid down)
   *   wobble  three quick noise pulses (unsteady)
   *   off     two noise thuds: high→low means you were under, low→high means over
   *   again   one soft tick (not judged: too short, too early, or unreadable)
   */
  earcon(kind, { dir = 1, freq = 880 } = {}) {
    const at = this.now() + 0.04;
    let f = freq;
    while (f < 1400) f *= 2; // above anything the pitch tracker listens for
    if (kind === 'good') this._ding(at, f);
    else if (kind === 'great') {
      this._ding(at, f);
      this._ding(at + 0.17, f * 2);
    } else if (kind === 'slide') this._noise(at, 0.32, dir > 0 ? 450 : 3600, dir > 0 ? 3600 : 450, 2.5, 0.45);
    else if (kind === 'wobble') for (let i = 0; i < 3; i++) this._noise(at + i * 0.12, 0.07, 1600, 1600, 2, 0.55);
    else if (kind === 'off') {
      this._noise(at, 0.11, dir < 0 ? 1500 : 650, dir < 0 ? 1500 : 650, 5, dir < 0 ? 0.8 : 1);
      this._noise(at + 0.16, 0.15, dir < 0 ? 650 : 1500, dir < 0 ? 650 : 1500, 5, dir < 0 ? 1 : 0.8);
    } else if (kind === 'again') this._noise(at, 0.05, 1100, 1100, 3, 0.45);
  }

  _track(out, sources, at, dur) {
    const voice = { out, sources };
    this.voices.add(voice);
    sources.forEach((s) => {
      s.start(at);
      s.stop(at + dur);
    });
    sources[0].onended = () => {
      out.disconnect();
      this.voices.delete(voice);
    };
  }

  _ding(at, freq) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(0.25, at + 0.004);
    out.gain.setTargetAtTime(0, at + 0.004, 0.09);
    out.connect(this.side);
    const sources = [1, 2].map((h) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq * h;
      const g = ctx.createGain();
      g.gain.value = h === 1 ? 1 : 0.25;
      osc.connect(g).connect(out);
      return osc;
    });
    this._track(out, sources, at, 0.6);
  }

  /** A burst of band-passed noise whose centre glides from f0 to f1. */
  _noise(at, dur, f0, f1, q, gain) {
    const ctx = this.ctx;
    if (!this.noiseBuf) {
      this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, at);
    bp.frequency.exponentialRampToValueAtTime(f1, at + dur);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(gain, at + 0.012);
    out.gain.setValueAtTime(gain, at + dur - 0.03);
    out.gain.linearRampToValueAtTime(0, at + dur);
    src.connect(bp).connect(out).connect(this.side);
    this._track(out, [src], at, dur + 0.02);
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
