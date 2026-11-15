import test from 'node:test';
import assert from 'node:assert/strict';
import { PitchDetector } from '../js/pitch.js';
import { NoteTracker } from '../js/capture.js';
import { evaluateAttempt } from '../js/evaluate.js';
import { pickRound, keyContext, SCALES, pc, midiToFreq } from '../js/music.js';

const SR = 48000;
const HOP = 512;
const DT = HOP / SR;

// A voice-like tone: harmonic series with a falling spectrum, optional noise.
function tone(freq, n, { sr = SR, noise = 0, harmonics = 8, weakFundamental = false } = {}) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let h = 1; h <= harmonics; h++) {
      if (freq * h > sr / 2.2) break;
      const amp = (h === 1 && weakFundamental ? 0.15 : 1) / h;
      s += amp * Math.sin((2 * Math.PI * freq * h * i) / sr + h);
    }
    out[i] = 0.2 * s + noise * (Math.random() * 2 - 1);
  }
  return out;
}
const centsErr = (f, ref) => 1200 * Math.log2(f / ref);

test('detector is accurate to a couple of cents across the vocal range', () => {
  for (const sr of [44100, 48000]) {
    const det = new PitchDetector(sr);
    let worst = 0;
    for (let midi = 38; midi <= 86; midi += 0.37) {
      const f = midiToFreq(midi);
      const r = det.detect(tone(f, 2048, { sr }));
      assert.ok(r.clarity > 0.9, `clarity ${r.clarity} at ${f.toFixed(1)} Hz`);
      worst = Math.max(worst, Math.abs(centsErr(r.freq, f)));
    }
    assert.ok(worst < 2, `worst error ${worst.toFixed(2)}¢ at ${sr}`);
  }
});

test('detector holds up with noise and a weak fundamental', () => {
  const det = new PitchDetector(SR);
  for (const f of [98, 147, 220, 330, 523]) {
    const noisy = det.detect(tone(f, 2048, { noise: 0.02 }));
    assert.ok(Math.abs(centsErr(noisy.freq, f)) < 5, `noisy ${f}: ${centsErr(noisy.freq, f)}`);
    assert.ok(noisy.clarity > 0.85);
    const thin = det.detect(tone(f, 2048, { weakFundamental: true }));
    assert.ok(Math.abs(centsErr(thin.freq, f)) < 3, `thin ${f}: got ${thin.freq}`);
  }
});

test('detector reports low clarity for noise and silence', () => {
  const det = new PitchDetector(SR);
  const noise = Float32Array.from({ length: 2048 }, () => Math.random() * 0.2 - 0.1);
  assert.ok(det.detect(noise).clarity < 0.85);
  assert.equal(det.detect(new Float32Array(2048)).freq, 0);
});

// ---- evaluation ----------------------------------------------------------

const TARGET = 220;
const OPTS = { tol: 25, scoopThr: 30, strictOnset: true, anyOctave: false };
/** Build frames for a 1 s note whose pitch (in cents vs target) follows fn(t). */
function sung(fn, dur = 1) {
  const frames = [];
  for (let t = 0; t <= dur; t += DT) frames.push({ t: 5 + t, freq: TARGET * Math.pow(2, fn(t) / 1200) });
  return frames;
}
const judge = (fn, opts = {}) => evaluateAttempt(sung(fn), 5, TARGET, { ...OPTS, ...opts });
const jitter = () => (Math.random() - 0.5) * 12;

test('steady and close is a hit', () => {
  const r = judge(() => 6 + jitter());
  assert.equal(r.verdict, 'hit');
  assert.equal(r.scoop, null);
  assert.ok(Math.abs(r.cents - 6) < 4);
});

test('steady but off is flat / sharp', () => {
  assert.equal(judge(() => -40 + jitter()).verdict, 'flat');
  assert.equal(judge(() => 38 + jitter()).verdict, 'sharp');
});

test('gliding up into the note is a scoop, even though it settles on pitch', () => {
  const r = judge((t) => (t < 0.18 ? -120 * (1 - t / 0.18) : 0) + jitter() / 3);
  assert.equal(r.verdict, 'scoop');
  assert.equal(r.scoop.dir, 'up');
  assert.ok(r.scoop.from < -80);
  assert.ok(Math.abs(r.cents) < 5);
});

test('falling onto the note is a downward scoop', () => {
  const r = judge((t) => (t < 0.15 ? 90 * (1 - t / 0.15) : 0));
  assert.equal(r.verdict, 'scoop');
  assert.equal(r.scoop.dir, 'down');
});

test('a slow slide is caught too', () => {
  const r = judge((t) => (t < 0.45 ? -80 * (1 - t / 0.45) : 0));
  assert.equal(r.verdict, 'scoop');
});

test('a brief onset flicker is not a scoop', () => {
  assert.equal(judge((t) => (t < 0.03 ? -60 : 0)).verdict, 'hit');
});

test('with lenient onsets a scoop is flagged but still passes', () => {
  const r = judge((t) => (t < 0.18 ? -120 * (1 - t / 0.18) : 0), { strictOnset: false });
  assert.equal(r.verdict, 'hit');
  assert.equal(r.scoop.dir, 'up');
});

test('scoop plus wrong pitch reports the pitch, keeps the scoop', () => {
  const r = judge((t) => -45 + (t < 0.2 ? -100 * (1 - t / 0.2) : 0));
  assert.equal(r.verdict, 'flat');
  assert.equal(r.scoop.dir, 'up');
});

test('wobble around the pitch is unsteady', () => {
  assert.equal(judge((t) => (t < 0.3 ? 0 : 60 * Math.sin(2 * Math.PI * 5 * t))).verdict, 'unsteady');
});

test('octave handling', () => {
  assert.equal(judge(() => -1200 + 5).verdict, 'octave');
  assert.equal(judge(() => -1200 + 5, { anyOctave: true }).verdict, 'hit');
});

test('isolated octave glitches from the detector are ignored', () => {
  let i = 0;
  assert.equal(judge(() => (++i % 23 === 0 ? -1200 : 3)).verdict, 'hit');
});

// ---- note tracker --------------------------------------------------------

function run(tracker, segments) {
  const events = [];
  let t = 0;
  for (const [dur, voiced] of segments) {
    for (const end = t + dur; t < end; t += DT) {
      const f = { t, freq: voiced ? 220 : 0, clarity: voiced ? 0.97 : 0.2, rms: voiced ? 0.1 : 0.0005 };
      const ev = tracker.step(f, tracker.voiced(f));
      if (ev) events.push(ev.type);
    }
  }
  return events;
}

test('tracker: silence then a held note completes', () => {
  assert.deepEqual(run(new NoteTracker(), [[0.4, false], [1.3, true]]), ['armed', 'onset', 'done']);
});

test('tracker: a blip is rejected as too short, then re-arms', () => {
  const ev = run(new NoteTracker(), [[0.4, false], [0.3, true], [0.5, false], [1.2, true]]);
  assert.deepEqual(ev, ['armed', 'onset', 'short', 'armed', 'onset', 'done']);
});

test('tracker: a note already sounding when listening starts does not count', () => {
  assert.deepEqual(run(new NoteTracker({ noise: 0.0005 }), [[1.5, true]]), []);
});

// ---- music ---------------------------------------------------------------

test('pickRound stays in range, in key, and avoids repeats', () => {
  const s = { low: 43, high: 64, keyMode: true, keyTonic: '2', keyScale: 'major' };
  let prev = null;
  for (let i = 0; i < 200; i++) {
    const r = pickRound(s, prev);
    assert.ok(r.midi >= 43 && r.midi <= 64);
    assert.ok(SCALES.major.includes(pc(r.midi - 2)));
    assert.equal(SCALES.major[r.degree - 1], pc(r.midi - 2));
    assert.notEqual(r.midi, prev);
    prev = r.midi;
  }
  assert.equal(pickRound({ low: 50, high: 60, keyMode: false }).key, null);
});

test('keyContext only uses notes of the key (plus the leading tone in minor)', () => {
  for (const scale of ['major', 'minor']) {
    for (const style of ['scale', 'cadence']) {
      const { events, length } = keyContext({ tonic: 7, scale }, style);
      assert.ok(length > 1);
      for (const e of events) for (const n of e.notes) {
        const step = pc(n - 7);
        assert.ok(SCALES[scale].includes(step) || step === 11, `${scale}/${style}: ${step}`);
      }
    }
  }
});

// ---- practice ladder -----------------------------------------------------

import { createPractice, pickPractice, recordFind, recordLand, learning, nextUnlock } from '../js/practice.js';

const land = (p, midi, results, opts = {}) => results.map((ok) => recordLand(p, midi, ok, { low: 43, high: 64, ...opts }).event);

test('practice: a new note is found first, then landed', () => {
  const p = createPractice(50);
  assert.deepEqual(pickPractice(p), { midi: 50, stage: 'find', review: false });
  recordFind(p, 50);
  assert.deepEqual(pickPractice(p), { midi: 50, stage: 'land', review: false });
});

test('practice: three clean landings in a row unlock the next note, outward from home', () => {
  const p = createPractice(50);
  const unlocked = [];
  for (let i = 0; i < 4; i++) {
    const focus = learning(p);
    recordFind(p, focus);
    assert.deepEqual(land(p, focus, [true, true]), [null, null]);
    unlocked.push(recordLand(p, focus, true, { low: 43, high: 64 }).midi);
  }
  assert.deepEqual(unlocked, [51, 49, 52, 48]);
});

test('practice: the streak needed is configurable and a miss resets it', () => {
  const p = createPractice(50);
  recordFind(p, 50);
  const need = { need: 5 };
  assert.deepEqual(land(p, 50, [true, true, true, true, false, true, true, true, true], need), Array(9).fill(null));
  assert.equal(p.notes[50].streak, 4);
  assert.deepEqual(land(p, 50, [true], need), ['unlocked']);
});

test('practice: notes mastered on an earlier day are checked cold first', () => {
  const p = createPractice(50);
  recordFind(p, 50);
  land(p, 50, [true, true, true], { today: 'mon' }); // 50 mastered, 51 unlocked
  recordFind(p, 51);
  land(p, 51, [true, true, true], { today: 'mon' }); // 51 mastered, 49 unlocked
  assert.ok(!pickPractice(p, null, () => 0.99, 'mon').cold); // same day: straight to the focus note
  const first = pickPractice(p, null, Math.random, 'tue');
  assert.ok(first.cold && first.review && [50, 51].includes(first.midi));
  land(p, first.midi, [true], { today: 'tue' });
  const second = pickPractice(p, first.midi, Math.random, 'tue');
  assert.ok(second.cold && second.midi !== first.midi);
  land(p, second.midi, [false], { today: 'tue' }); // a cold miss still counts as checked
  assert.deepEqual(pickPractice(p, second.midi, () => 0.99, 'tue'), { midi: 49, stage: 'find', review: false });
});

test('practice: three misses in a row send a note back to find', () => {
  const p = createPractice(50);
  recordFind(p, 50);
  assert.deepEqual(land(p, 50, [false, false, false]), [null, null, 'refind']);
  assert.equal(pickPractice(p).stage, 'find');
});

test('practice: unlocking respects the range and finishes when it is full', () => {
  const p = createPractice(50);
  assert.equal(nextUnlock(p, 50, 51), 51);
  recordFind(p, 50);
  assert.equal(land(p, 50, [true, true, true], { low: 50, high: 51 }).pop(), 'unlocked');
  recordFind(p, 51);
  assert.equal(land(p, 51, [true, true, true], { low: 50, high: 51 }).pop(), 'complete');
  assert.equal(learning(p), null);
  for (let i = 0, prev = null; i < 50; i++) {
    const pick = pickPractice(p, prev);
    assert.ok(pick.review && pick.stage === 'land' && pick.midi !== prev);
    prev = pick.midi;
  }
});

test('practice: mastered notes return as review and are demoted after two misses', () => {
  const p = createPractice(50);
  recordFind(p, 50);
  land(p, 50, [true, true, true]); // unlocks 51
  recordFind(p, 51);
  let reviews = 0;
  for (let i = 0; i < 300; i++) {
    const pick = pickPractice(p, 51);
    if (pick.review) {
      assert.equal(pick.midi, 50);
      reviews++;
    } else assert.equal(pick.midi, 51);
  }
  assert.ok(reviews > 60 && reviews < 140, `review share ${reviews}/300`);
  assert.deepEqual(land(p, 50, [false, false]), [null, 'demoted']);
  assert.equal(learning(p), 50); // the slipped note takes focus again
});
