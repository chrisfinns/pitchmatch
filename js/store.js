// Settings + round log, kept in localStorage. Stats are derived from the log.

import { NOTE_NAMES, pc, noteName, degreeLabel } from './music.js';

const KEY_SETTINGS = 'pitchmatch.settings.v1';
const KEY_LOG = 'pitchmatch.log.v1';
const KEY_PRACTICE = 'pitchmatch.practice.v1';
const KEY_FOCUS = 'pitchmatch.focus.v1';
const MAX_LOG = 3000;

export const DEFAULTS = {
  mode: 'practice', // practice | test | focus | free (analyzer only)
  focusNote: null, // focus mode's note (MIDI); null = start from the practice home note
  focusRotate: true, // focus mode: a different instrument every rep
  pocket: false, // focus mode, hands-free: screen awake and locked, note changes on a timer
  pocketMinutes: 5,
  rangePreset: 'baritone',
  low: 43,
  high: 64,
  anyOctave: false,
  tol: 25, // ± cents that count as in tune
  hold: 1, // seconds the note is judged over
  scoopThr: 30, // cents off at the onset that count as a scoop…
  scoopMs: 120, // …if the note still hasn't arrived after this many ms
  strictOnset: true, // scoops are misses
  landStreak: 5, // practice: clean landings in a row that lock a note in
  gap: 0, // seconds of silence between the reference and singing
  clicks: true, // count-in: metronome clicks after the reference, sing on the next beat
  keyMode: false,
  keyTonic: 'random',
  keyScale: 'major',
  keyIntro: 'scale',
  volume: 100, // master volume, 0–100
  timbre: 'piano', // any id in audio.js SOUNDS
  brightPiano: false, // EarMaster piano without its tone filter
  sounds: true, // result sounds, so practice works with your eyes closed
  playback: 'miss', // play your note back, then the target: off | miss | always
  speakerFix: true, // iOS: route playback so the phone doesn't turn it down while the mic is live
  auto: true,
};

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / full — the app still works for this session */
  }
}

export const hasSettings = () => read(KEY_SETTINGS) !== null;
export const loadSettings = () => ({ ...DEFAULTS, ...(read(KEY_SETTINGS) || {}) });
export const saveSettings = (s) => write(KEY_SETTINGS, s);
export const loadLog = () => (Array.isArray(read(KEY_LOG)) ? read(KEY_LOG) : []);
export const saveLog = (log) => write(KEY_LOG, log.slice(-MAX_LOG));
export function loadPractice() {
  const p = read(KEY_PRACTICE);
  return p && p.v === 1 && p.notes && Array.isArray(p.order) ? p : null;
}
export const savePractice = (p) => write(KEY_PRACTICE, p);
/** Focus results: { [midi]: { [sound id]: { n, clean } } } */
export function loadFocus() {
  const f = read(KEY_FOCUS);
  return f && typeof f === 'object' && !Array.isArray(f) ? f : {};
}
export const saveFocus = (f) => write(KEY_FOCUS, f);

/**
 * A record: { ts, midi, key: {tonic, scale}|null, degree, result: first|second|miss,
 *             tries: [{ v: verdict, cents, spread, scoop: 'up'|'down'|null, from }] }
 */
export function summarize(recs) {
  const s = { n: recs.length, first: 0, second: 0, miss: 0, up: 0, down: 0, streak: 0, best: 0, avgErr: null, pct: null };
  let errSum = 0;
  let errN = 0;
  for (const r of recs) {
    s[r.result]++;
    s.streak = r.result === 'first' ? s.streak + 1 : 0;
    s.best = Math.max(s.best, s.streak);
    const t = r.tries[0];
    if (!t) continue;
    if (t.scoop) s[t.scoop]++;
    if (Math.abs(t.cents) < 600) {
      errSum += Math.abs(t.cents);
      errN++;
    }
  }
  if (s.n) s.pct = s.first / s.n;
  if (errN) s.avgErr = errSum / errN;
  return s;
}

/** Per-note difficulty table, hardest first. mode: 'note' | 'pitch' | 'degree'. */
export function groupStats(recs, mode) {
  const groups = new Map();
  for (const r of recs) {
    let key;
    let label;
    if (mode === 'degree') {
      if (!r.key) continue;
      key = `${r.key.scale}${r.degree}`;
      label = `${degreeLabel(r.key.scale, r.degree)} · ${r.key.scale}`;
    } else if (mode === 'pitch') {
      key = r.midi;
      label = noteName(r.midi);
    } else {
      key = pc(r.midi);
      label = NOTE_NAMES[key];
    }
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, label, n: 0, first: 0, scoops: 0, errSum: 0, biasSum: 0, errN: 0 }));
    g.n++;
    if (r.result === 'first') g.first++;
    const t = r.tries[0];
    if (!t) continue;
    if (t.scoop) g.scoops++;
    if (Math.abs(t.cents) < 600) {
      g.errSum += Math.abs(t.cents);
      g.biasSum += t.cents;
      g.errN++;
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, pct: g.first / g.n, avgErr: g.errN ? g.errSum / g.errN : null, bias: g.errN ? g.biasSum / g.errN : null }))
    .sort((a, b) => a.pct - b.pct || (b.avgErr ?? 0) - (a.avgErr ?? 0) || b.n - a.n);
}
