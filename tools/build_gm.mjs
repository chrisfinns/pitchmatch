#!/usr/bin/env node
// Builds the extra instrument sounds from the FluidR3 GM SoundFont (Frank Wen,
// MIT licence; the General MIDI set EarMaster's instrument list is based on).
//
// Each instrument is rendered by FluidSynth itself, so layering, envelopes and
// filters are exactly what a SoundFont player does. One note every 3 semitones
// across C2–C6 (the app transposes the rest by at most 1.5 semitones, as with
// the Salamander piano), held for the whole file, dry (no reverb or chorus).
// Each file is then measured with the app's own pitch detector and loudness
// meter, so every sound is in tune on the same ruler and plays at the same
// level, and js/instruments.js is written.
//
// Usage: node tools/build_gm.mjs /path/to/FluidR3_GM.sf2
// Needs: fluidsynth, ffmpeg with libmp3lame. (Debian/Ubuntu: apt install
// fluidsynth; the SoundFont is in the fluid-soundfont-gm package.)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PitchDetector } from '../js/pitch.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'samples', 'gm');
const SR = 44100;
const KEEP = 3.3; // s: a 1.3 s note plus the app's 1.8 s release
const FADE = 0.15;
const KEYS = Array.from({ length: 17 }, (_, i) => 36 + 3 * i); // C2, D#2 … C6
const VELOCITY = 100;
const LOUDNESS = -15; // dBFS weighted RMS, same target as both pianos
const MAX_GAIN = 10;

// [id, name, GM program (0-based)]. Chosen for a clear, stable pitch across
// C2–C6: FluidR3's vibraphone drifts up to +50 cents low in the range, its
// "aah" choir reads inconsistently and its church organ is octave-ambiguous
// (mixture stops), so reed organ, "ooh" voices and harpsichord stand in.
export const INSTRUMENTS = [
  ['epiano', 'Electric piano', 4],
  ['harpsichord', 'Harpsichord', 6],
  ['organ', 'Reed organ', 20],
  ['guitar', 'Nylon guitar', 24],
  ['cello', 'Cello', 42],
  ['strings', 'Strings', 48],
  ['voices', 'Voices "ooh"', 53],
  ['trumpet', 'Trumpet', 56],
  ['sax', 'Tenor sax', 66],
  ['clarinet', 'Clarinet', 71],
  ['flute', 'Flute', 73],
];

const sf2 = process.argv[2];
if (!sf2 || !existsSync(sf2)) {
  console.error('Usage: node tools/build_gm.mjs /path/to/FluidR3_GM.sf2');
  process.exit(1);
}

/** A one-note Standard MIDI File: program change, note held `secs`, then end. */
function midiFile(program, midi, secs) {
  const vlq = (n) => {
    const out = [n & 0x7f];
    while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
    return out;
  };
  const tpq = 480; // at the default 120 bpm, 960 ticks per second
  const hold = Math.round(secs * 960);
  const track = [0, 0xc0, program, 0, 0x90, midi, VELOCITY, ...vlq(hold), 0x80, midi, 0, 0, 0xff, 0x2f, 0];
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return Buffer.from([
    ...Buffer.from('MThd'), ...u32(6), 0, 0, 0, 1, tpq >> 8, tpq & 255,
    ...Buffer.from('MTrk'), ...u32(track.length), ...track,
  ]);
}

function decode(file, filter) {
  const args = ['-v', 'error', '-i', file];
  if (filter) args.push('-af', filter);
  const raw = execFileSync('ffmpeg', [...args, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2;
};
const det = new PitchDetector(SR);
function cents(x, midi) {
  const nominal = 440 * 2 ** ((midi - 69) / 12);
  const reads = [];
  for (let i = Math.round(0.1 * SR); i + det.size <= Math.min(x.length, 1.3 * SR); i += 512) {
    const r = det.detect(x.subarray(i, i + det.size));
    if (r.clarity >= 0.85) reads.push(1200 * Math.log2(r.freq / nominal));
  }
  // Keep readings near the nominal note (a stray octave read is not tuning).
  const near = reads.filter((c) => Math.abs(c) < 60);
  return { cents: near.length >= 10 ? median(near) : null, frames: near.length };
}
function rmsDb(x) {
  let e = 0;
  const n = Math.min(x.length, Math.round(1.3 * SR));
  for (let i = 0; i < n; i++) e += x[i] * x[i];
  return 10 * Math.log10(e / n);
}

const work = mkdtempSync(join(tmpdir(), 'pm-gm-'));
const manifest = [];
for (const [id, name, program] of INSTRUMENTS) {
  mkdirSync(join(OUT, id), { recursive: true });
  const samples = [];
  for (const midi of KEYS) {
    const mid = join(work, 'n.mid');
    const wav = join(work, 'n.wav');
    writeFileSync(mid, midiFile(program, midi, KEEP + 0.2));
    execFileSync('fluidsynth', ['-ni', '-q', '-g', '1.0', '-r', String(SR), '-o', 'synth.reverb.active=0', '-o', 'synth.chorus.active=0',
      '-F', wav, '-T', 'wav', sf2, mid], { stdio: ['ignore', 'ignore', 'pipe'] });
    const file = `${midi}.mp3`;
    const out = join(OUT, id, file);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-t', String(KEEP), '-af', `afade=t=out:st=${KEEP - FADE}:d=${FADE}`,
      '-ar', String(SR), '-c:a', 'libmp3lame', '-b:a', '320k', out]);
    const x = decode(out);
    const { cents: c, frames } = cents(x, midi);
    const level = rmsDb(decode(out, 'highpass=f=250:poles=1'));
    const gain = Math.round(Math.min(MAX_GAIN, 10 ** ((LOUDNESS - level) / 20)) * 100) / 100;
    samples.push({ midi, file, cents: c === null ? null : Math.round(c * 100) / 100, gain });
    if (c === null) console.warn(`  ${id} ${midi}: only ${frames} clear pitch frames; using the instrument's typical tuning`);
  }
  // A sample the detector can't read takes the instrument's median tuning.
  const typical = median(samples.filter((s) => s.cents !== null).map((s) => s.cents));
  for (const s of samples) if (s.cents === null) s.cents = Math.round(typical * 100) / 100;
  const cs = samples.map((s) => s.cents);
  console.log(`${name.padEnd(15)} tuning ${Math.min(...cs).toFixed(1)}…${Math.max(...cs).toFixed(1)}¢  gain ×${Math.min(...samples.map((s) => s.gain))}…×${Math.max(...samples.map((s) => s.gain))}`);
  manifest.push({ id, name, dir: id, samples });
}
rmSync(work, { recursive: true, force: true });

writeFileSync(
  join(ROOT, 'js', 'instruments.js'),
  '// Generated by tools/build_gm.mjs from FluidR3 GM (Frank Wen, MIT licence).\n' +
    "// One sample every 3 semitones, C2–C6. cents = pitch vs 12-TET as read by js/pitch.js (corrected at playback);\n" +
    '// gain = brings every sample to the same loudness.\n' +
    `export const INSTRUMENTS = [\n${manifest
      .map((ins) => `  {"id":${JSON.stringify(ins.id)},"name":${JSON.stringify(ins.name)},"dir":${JSON.stringify(ins.dir)},"samples":[\n    ${ins.samples.map((s) => JSON.stringify(s)).join(',\n    ')}]}`)
      .join(',\n')},\n];\n`,
);
