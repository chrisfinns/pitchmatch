// Judges one sung note against the target. Pure.
//
// The note is split in two: the ONSET (first 250 ms) and the SUSTAIN (the rest,
// after it has had time to settle). The sustain decides whether you were on
// pitch; the onset decides whether you landed on it or slid into it.
//
// Every sung note has a short pitch transient at its start — around 120 ms even
// in trained ensemble singers — so an off-pitch start is graded by how long it
// lasts: a brief "lean-in" is reported but passes; a scoop is one that is still
// off after `scoopMs`.

import { noteName } from './music.js';

const ONSET_WIN = 0.25; // seconds examined for a scoop
const SCOOP_START = 0.1; // a scoop must begin this early in the note…
const LEAN_MIN = 0.05; // …and last at least this long to be more than detector noise

const median = (xs) => quantile(xs, 0.5);
function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function median5(cs) {
  return cs.map((_, i) => median(cs.slice(Math.max(0, i - 2), i + 3)));
}

/**
 * frames: voiced [{ t, freq }], t0: onset time, targetFreq in Hz.
 * opts: { tol, scoopThr, scoopMs, strictOnset, anyOctave }
 */
export function evaluateAttempt(frames, t0, targetFreq, opts) {
  const { tol, scoopThr, scoopMs = 120, strictOnset = true, anyOctave = false } = opts;
  if (frames.length < 12) return { valid: false };

  let cs = frames.map((f) => 1200 * Math.log2(f.freq / targetFreq));
  if (anyOctave) cs = cs.map((c) => c - 1200 * Math.round(c / 1200));
  cs = median5(cs); // removes 1–2 frame detector glitches, leaves glides intact
  const pts = frames.map((f, i) => ({ t: f.t - t0, c: cs[i] }));

  const dur = pts[pts.length - 1].t;
  const bodyStart = Math.min(0.4, dur * 0.4);
  const body = pts.filter((p) => p.t >= bodyStart).map((p) => p.c);
  if (body.length < 8) return { valid: false };

  const cents = median(body);
  const spread = (quantile(body, 0.9) - quantile(body, 0.1)) / 2;

  // Scoop: an early, sustained run that sits off to one side of where the note settles.
  let scoop = null;
  for (const sign of [-1, 1]) {
    const off = (p) => sign * (p.c - cents) > scoopThr;
    const i0 = pts.findIndex(off);
    if (i0 < 0 || pts[i0].t > SCOOP_START) continue;
    let i1 = i0;
    while (i1 + 1 < pts.length && off(pts[i1 + 1])) i1++;
    if (pts[i1].t - pts[i0].t < LEAN_MIN) continue;
    const run = pts.slice(i0, i1 + 1).map((p) => p.c - cents);
    const from = sign < 0 ? Math.min(...run) : Math.max(...run);
    const settle = pts[Math.min(i1 + 1, pts.length - 1)].t; // when the note arrived
    scoop = { dir: sign < 0 ? 'up' : 'down', from, settle, minor: settle <= scoopMs / 1000 };
    break;
  }

  const octave = anyOctave ? 0 : Math.round(cents / 1200);
  let verdict;
  if (octave !== 0 && Math.abs(cents - 1200 * octave) <= Math.max(tol, 50)) verdict = 'octave';
  else if (cents < -tol) verdict = 'flat';
  else if (cents > tol) verdict = 'sharp';
  else if (scoop && !scoop.minor && strictOnset) verdict = 'scoop';
  else if (spread > tol + 10) verdict = 'unsteady';
  else verdict = 'hit';

  return {
    valid: true,
    ok: verdict === 'hit',
    verdict,
    cents,
    spread,
    scoop,
    octave,
    pts,
    dur,
    bodyStart,
    onsetWin: Math.min(ONSET_WIN, bodyStart),
  };
}

const fmt = (c) => `${c < 0 ? '−' : '+'}${Math.abs(Math.round(c))}¢`;

/** Human wording for a result. */
export function describe(res, midi) {
  const abs = Math.abs(Math.round(res.cents));
  const lean = res.scoop && res.scoop.minor;
  const scoopNote = res.scoop && !lean
    ? res.scoop.dir === 'up'
      ? `You scooped up into it — started ${Math.abs(Math.round(res.scoop.from))}¢ under.`
      : `You slid down into it — started ${Math.abs(Math.round(res.scoop.from))}¢ over.`
    : '';

  switch (res.verdict) {
    case 'hit':
      return {
        title: `On pitch · ${fmt(res.cents)}`,
        detail: lean
          ? `Slight lean-in: started ${Math.abs(Math.round(res.scoop.from))}¢ ${res.scoop.dir === 'up' ? 'under' : 'over'}, on pitch within ${Math.round(res.scoop.settle * 1000)} ms. That's inside a normal sung onset.`
          : res.scoop
            ? scoopNote
            : `Clean onset, steady within ±${Math.round(res.spread)}¢.`,
      };
    case 'octave':
      return {
        title: 'Right note, wrong octave',
        detail: `You sang it ${Math.abs(res.octave) > 1 ? `${Math.abs(res.octave)} octaves` : 'an octave'} ${res.octave < 0 ? 'low' : 'high'}. If that's fine by you, switch on “Any octave counts”.`,
      };
    case 'flat':
    case 'sharp': {
      const far = abs >= 150;
      const title = far ? `${(abs / 100).toFixed(1)} semitones ${res.verdict}` : `${abs}¢ ${res.verdict}`;
      const sang = far
        ? `You sang about ${noteName(midi + Math.round(res.cents / 100))}.`
        : `You sat ${res.verdict === 'flat' ? 'under' : 'over'} the note.`;
      return { title, detail: `${sang} ${scoopNote}`.trim() };
    }
    case 'scoop':
      return {
        title: res.scoop.dir === 'up' ? 'Scooped up into it' : 'Slid down into it',
        detail: `Started ${Math.abs(Math.round(res.scoop.from))}¢ ${res.scoop.dir === 'up' ? 'under' : 'over'}, settled at ${fmt(res.cents)}. Land on the note from the first instant.`,
      };
    default:
      return {
        title: 'Centred, but unsteady',
        detail: `Averaged ${fmt(res.cents)} but wandered ±${Math.round(res.spread)}¢. Hold it still.`,
      };
  }
}
