// Note maths, ranges and round selection. Pure — no DOM, no audio.

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};
const DEGREE_NAMES = {
  major: ['1', '2', '3', '4', '5', '6', '7'],
  minor: ['1', '2', '♭3', '4', '5', '♭6', '♭7'],
};

export const RANGES = {
  bass: { label: 'Bass (E2–C4)', low: 40, high: 60 },
  baritone: { label: 'Baritone (G2–E4)', low: 43, high: 64 },
  tenor: { label: 'Tenor (C3–G4)', low: 48, high: 67 },
  alto: { label: 'Alto (G3–D5)', low: 55, high: 74 },
  soprano: { label: 'Soprano (C4–G5)', low: 60, high: 79 },
};

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const pc = (m) => ((m % 12) + 12) % 12;
export const pcName = (m) => NOTE_NAMES[pc(m)];
export const noteName = (m) => `${pcName(m)}${Math.floor(m / 12) - 1}`;
export const centsBetween = (freq, ref) => 1200 * Math.log2(freq / ref);
export const keyLabel = (key) => `${NOTE_NAMES[key.tonic]} ${key.scale}`;
export const degreeLabel = (scale, degree) => DEGREE_NAMES[scale][degree - 1];

/** Choose the next target. With key mode on, the note is drawn from that key. */
export function pickRound(s, prevMidi = null, rnd = Math.random) {
  let pool = [];
  for (let m = s.low; m <= s.high; m++) pool.push(m);
  let key = null;
  if (s.keyMode) {
    const tonic = s.keyTonic === 'random' ? Math.floor(rnd() * 12) : Number(s.keyTonic);
    key = { tonic, scale: s.keyScale };
    pool = pool.filter((m) => SCALES[key.scale].includes(pc(m - tonic)));
  }
  const choices = pool.length > 1 ? pool.filter((m) => m !== prevMidi) : pool;
  const midi = choices[Math.floor(rnd() * choices.length)];
  const degree = key ? SCALES[key.scale].indexOf(pc(midi - key.tonic)) + 1 : null;
  return { midi, key, degree };
}

/** Notes that establish a key: an ascending scale + tonic chord, or a I–IV–V–I cadence. */
export function keyContext(key, style) {
  const t = 53 + pc(key.tonic - 53); // tonic somewhere in F3–E4
  const third = key.scale === 'major' ? 4 : 3;
  const sixth = key.scale === 'major' ? 9 : 8;
  const tonicChord = [t - 12, t, t + third, t + 7];
  const events = [];

  if (style === 'cadence') {
    const chords = [tonicChord, [t - 7, t, t + 5, t + sixth], [t - 5, t - 1, t + 2, t + 7], tonicChord];
    const step = 0.7;
    chords.forEach((notes, i) => events.push({ notes, at: i * step, dur: i === 3 ? 1.1 : step }));
    return { events, length: 3 * step + 1.1 };
  }

  const steps = [...SCALES[key.scale], 12];
  const step = 0.26;
  steps.forEach((st, i) => events.push({ notes: [t + st], at: i * step, dur: i === steps.length - 1 ? 0.5 : step * 1.1 }));
  const chordAt = steps.length * step + 0.3;
  events.push({ notes: tonicChord, at: chordAt, dur: 1.0 });
  return { events, length: chordAt + 1.0 };
}
