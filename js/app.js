// PitchMatch — round flow and UI.
//
// Test: play the reference → try 1 (blind) → if missed, replay and try 2 with
// the live analyzer → log it.
// Practice: one note at a time — find it (live colour), then land on it cold;
// the set of notes widens as each one is mastered (see practice.js).

import { AudioEngine, IS_IOS, HAS_EARMASTER, SOUNDS, soundName } from './audio.js';
import { NoteTracker } from './capture.js';
import { evaluateAttempt, describe } from './evaluate.js';
import { RANGES, NOTE_NAMES, midiToFreq, noteName, pickRound, keyContext, keyLabel, degreeLabel } from './music.js';
import { createPractice, pickPractice, recordFind, recordLand, learning } from './practice.js';
import { Scope } from './scope.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const S = Object.freeze({ IDLE: 'idle', PLAYING: 'playing', LISTENING: 'listening', CAPTURING: 'capturing', FINDING: 'finding', BETWEEN: 'between', DONE: 'done', FREE: 'free' });
const NOTE_DUR = 1.3;
const LIVE_SPAN = 4;
const LAND_HOLD = 0.75; // practice landings are short: it's the onset that matters
const FIND_HOLD = 1.2; // seconds in the green that count as "found"
const FIND_IDLE = 3.5; // seconds of silence before the note plays again
const FREE_SPAN = 6; // seconds of trace in analyzer mode
const TAIL_MS = 450; // the piano's release before the mic opens, when nothing else fills the wait

const firstVisit = !store.hasSettings();
const settings = store.loadSettings();
let log = store.loadLog();
const sessionStart = Date.now();
const forcedNote = Number(new URLSearchParams(location.search).get('note')) || null; // ?note=57 drills one pitch

const engine = new AudioEngine();
const tracker = new NoteTracker();
const scope = new Scope($('scope'), () => renderScope());

let state = S.IDLE;
let seq = 0; // bumps on every state change; pending timers from older states are dropped
let round = null;
let scopeMode = 'idle'; // idle | blind | review | live
let review = null;
let livePts = [];
let liveMark = null;
let lastFrame = null;
let earlyVoice = 0;
let statsScope = 'session';
let meter = 0;
let mode = ['test', 'focus', 'free'].includes(settings.mode) ? settings.mode : 'practice';
let focusStats = store.loadFocus();
let focusQueue = []; // upcoming instruments, shuffled each cycle
let focusSession = { n: 0, clean: 0, streak: 0 };
let freePts = []; // analyzer mode: { t, m } with m a fractional MIDI note
let freeCenter = 57;
let freeShown = '';
let practice = store.loadPractice(); // null until a home note is set
let find = null; // live state of a "find it" round
let cue = { kind: '', word: '', sub: '' }; // the big WAIT / SING in the middle panel
let cleanStreak = 0;
let soundUntil = 0;

// ---------------------------------------------------------------- flow

function setState(next) {
  state = next;
  seq++;
  renderControls();
}

function after(ms, fn) {
  const mine = seq;
  setTimeout(() => {
    if (mine === seq) fn();
  }, Math.max(0, ms));
}

function say(title, detail = '', tone = '') {
  $('status').textContent = title;
  $('status').dataset.tone = tone;
  $('detail').textContent = detail;
}

let starting = false;
async function start() {
  if (starting) return;
  starting = true;
  $('btnMain').disabled = true;
  say('Starting…', 'Allow the microphone when your browser asks.');
  try {
    engine.bright = settings.brightPiano;
    await engine.start(onFrame, { speakerFix: settings.speakerFix, timbre: settings.timbre });
  } catch (err) {
    renderControls();
    say('Microphone needed', micError(err), 'bad');
    return;
  } finally {
    starting = false;
  }
  begin();
}

/** Start the next round of whichever mode is selected. */
function begin() {
  if (mode === 'test') return newRound();
  if (mode === 'free') return freeRun();
  if (mode === 'focus') return focusRound();
  scopeMode = 'idle';
  if (practice) practiceRound();
  else calibrate();
}

function stop() {
  engine.stop();
  round = null;
  lastFrame = null;
  scopeMode = 'idle';
  holdBar(false);
  lampSet('');
  setState(S.IDLE);
  say('Stopped', 'Press Start when you want another go.');
  renderScope();
}

function newRound() {
  const pick = pickRound(settings, round ? round.midi : null);
  if (forcedNote) Object.assign(pick, { midi: forcedNote, key: null, degree: null });
  round = { kind: 'test', ...pick, freq: midiToFreq(pick.midi), tryNo: 1, tries: [] };
  review = null;
  liveMark = null;
  livePts = [];
  scopeMode = 'blind';
  playReference(!!round.key);
}

function playReference(withContext) {
  setState(S.PLAYING);
  holdBar(false);
  engine.stopAll();
  const timbre = round.timbre || settings.timbre;
  const t0 = engine.now() + 0.12;
  let at = t0;

  if (withContext) {
    const intro = keyContext(round.key, settings.keyIntro);
    for (const e of intro.events) {
      for (const n of e.notes) engine.playNote(n, { at: t0 + e.at, dur: e.dur, vel: e.notes.length > 1 ? 0.32 : 0.6, timbre });
    }
    at = t0 + intro.length + 0.45;
    say(`Key of ${keyLabel(round.key)}`, 'Hear the key. The note to match comes next.');
    setCue('wait', 'Wait', 'hear the key');
    after((at - engine.now()) * 1000, () => {
      say('Match this note', 'Wait for it to finish, then sing it back.');
      setCue('wait', 'Wait', 'this is the note');
    });
  } else {
    setCue('wait', 'Wait', 'listen');
    const counted = settings.clicks && round.kind !== 'find';
    const lead = round.kind === 'focus'
      ? `${soundName(timbre)}. ${counted ? 'Hear it through the clicks, then land on it.' : 'Hear it in your head, then land on it.'}`
      : round.cold
      ? 'Cold check — a note you locked in on an earlier day.'
      : {
          find: 'Then sing, and steer until the panel goes green.',
          land: counted ? 'Hear it in your head through the clicks. Then land on it.' : 'Hear it in your head first. Then land on it.',
        }[round.kind];
    say(round.tryNo === 1 ? 'Listen…' : 'Listen again…', lead || (counted ? 'Wait for the clicks, then sing it back.' : 'Wait for the note to finish, then sing it back.'));
  }

  engine.playNote(round.midi, { at, dur: NOTE_DUR, vel: 0.85, timbre });
  // Listening opens as the note releases (or after a silent gap, to train holding
  // the pitch in memory); the tracker itself waits for real silence.
  const endMs = (at + NOTE_DUR - engine.now()) * 1000 + 60;
  const gap = round.kind === 'find' ? 0 : settings.gap;
  if (gap > 0) after(endMs, () => say('Hold it in your head', `Stay silent for ${gap} s and keep the note alive in your mind. Then sing.`));
  if (settings.clicks && round.kind !== 'find') {
    // Count-in: steady clicks through the wait, and you come in on the beat after the last one.
    const beat = gap >= 4 ? 1 : 0.5;
    const clicks = Math.max(2, Math.round(gap / beat));
    const first = at + NOTE_DUR + 0.1;
    for (let i = 0; i < clicks; i++) {
      engine.playClick(first + i * beat);
      after((first + i * beat - engine.now()) * 1000, () => setCue('wait', 'Wait', `${gap > 0 ? 'hold it in your head · ' : 'sing in '}${clicks - i}`));
    }
    // Open the mic just after the last click, so it has heard silence before the beat you enter on.
    after((first + (clicks - 1) * beat - engine.now()) * 1000 + 80, listen);
  } else {
    for (let k = gap; k >= 1; k--) after(endMs + (gap - k) * 1000, () => setCue('wait', 'Wait', `hold it in your head · ${k}`));
    // With no gap, let the piano's release (-30 dB after ~0.5 s) die down first,
    // so a speaker's tail in the mic isn't taken for an early start.
    after(endMs + (gap > 0 ? gap * 1000 : TAIL_MS), listen);
  }
  renderScope();
}

function listen() {
  if (round.kind === 'find') return listenFind();
  tracker.hold = holdFor();
  tracker.reset();
  earlyVoice = 0;
  setState(S.LISTENING);
  say(...prompt(), 'go');
  setCue('wait', 'Wait'); // turns to SING once the tracker has heard silence
}

const holdFor = () => (round.kind === 'test' ? settings.hold : round.kind === 'land' || round.kind === 'focus' ? LAND_HOLD : 1);

function prompt() {
  if (round.kind === 'calibrate') return ['Sing any comfortable note', 'A relaxed “ah”, wherever your voice sits naturally. Hold it for a second — practice starts from there.'];
  if (round.kind === 'land' || round.kind === 'focus') return ['Sing it', 'One short, clean note. Be on it from the first instant — no sliding.'];
  return ['Sing it', round.tryNo === 1 ? 'Blind try. Land straight on the pitch and hold it steady.' : 'Watch the analyzer. Hit the centre line from the very first instant.'];
}

function toCents(freq) {
  const c = 1200 * Math.log2(freq / round.freq);
  return settings.anyOctave ? c - 1200 * Math.round(c / 1200) : c;
}

function onFrame(f) {
  lastFrame = f;
  const voiced = tracker.voiced(f);

  if (state === S.FREE) {
    if (voiced) freePts.push({ t: f.t, m: 69 + 12 * Math.log2(f.freq / 440) });
    while (freePts.length && f.t - freePts[0].t > FREE_SPAN + 0.5) freePts.shift();
    return;
  }

  if (scopeMode === 'live' && round && state !== S.PLAYING) {
    if (voiced && performance.now() > soundUntil) livePts.push({ t: f.t, c: toCents(f.freq) });
    while (livePts.length && f.t - livePts[0].t > LIVE_SPAN + 0.5) livePts.shift();
  }
  if (state === S.FINDING) return findFrame(f, voiced);
  if (state !== S.LISTENING && state !== S.CAPTURING) return;

  // Singing before the room has gone quiet can't be judged — there's no clean onset.
  if (tracker.state === 'arming') {
    earlyVoice = voiced ? earlyVoice + engine.frameDt : 0;
    if (earlyVoice > 0.5 && !cue.sub) {
      $('detail').textContent = 'Stop for a beat — let it go quiet, then start the note fresh.';
      setCue('wait', 'Wait', 'let it go quiet first');
      sound('again');
    }
  }

  const ev = tracker.step(f, voiced);
  if (!ev) return;
  if (ev.type === 'armed') {
    if (cue.sub) say(...prompt(), 'go'); // drop the "let it go quiet" hint now that it has
    setCue('go', 'Sing', round.kind === 'test' && round.tryNo === 1 ? 'blind — trust your ear' : '');
  } else if (ev.type === 'onset') {
    setState(S.CAPTURING);
    say('Hold it…', '', 'go');
    setCue('go', 'Hold');
    holdBar(true, holdFor());
  } else if (ev.type === 'short') {
    holdBar(false);
    setCue('wait', 'Wait');
    setState(S.LISTENING);
    const [title, hint] = prompt();
    say(title, ev.dur > 0.15 ? `Too short — hold the note for ${holdFor()} s.` : hint, 'go');
    if (ev.dur > 0.15) sound('again');
  } else if (ev.type === 'done') {
    holdBar(false);
    if (ev.coverage < 0.75) return unreadable();
    if (round.kind === 'calibrate') setHome(ev);
    else if (round.kind === 'land') judgeLand(ev);
    else if (round.kind === 'focus') judgeFocus(ev);
    else judge(ev);
  }
}

/** Result sounds, so a session can run with your eyes closed (see AudioEngine.earcon). */
function sound(kind, opts) {
  if (!settings.sounds || !engine.running) return;
  engine.earcon(kind, opts);
  soundUntil = performance.now() + 700; // keep it off the live trace if the mic hears it
}

function verdictSound(res, lockedIn = false) {
  if (res.ok) sound(lockedIn ? 'great' : 'good');
  else if (res.verdict === 'scoop') sound('slide', { dir: res.scoop.dir === 'up' ? 1 : -1 });
  else if (res.verdict === 'unsteady') sound('wobble');
  else sound('off', { dir: res.cents < 0 ? -1 : 1 });
}

function unreadable() {
  sound('again');
  setCue('wait', 'Wait');
  setState(S.LISTENING);
  say(prompt()[0], "Couldn't read that cleanly — sing a clear, steady “ah”.", 'go');
}

function judge(ev) {
  const res = evaluateAttempt(ev.frames, ev.t0, round.freq, settings);
  if (!res.valid) return unreadable();
  lampSet('');
  const scoop = res.scoop && !res.scoop.minor ? res.scoop : null; // brief lean-ins aren't logged as scoops
  round.tries.push({
    v: res.verdict,
    cents: Math.round(res.cents * 10) / 10,
    spread: Math.round(res.spread * 10) / 10,
    scoop: scoop ? scoop.dir : null,
    from: scoop ? Math.round(scoop.from) : null,
  });

  if (round.tryNo === 1) {
    review = res;
    scopeMode = 'review';
  } else {
    liveMark = { t0: ev.t0, t1: ev.t0 + res.dur };
  }

  verdictSound(res);
  if (res.ok) return finish(round.tryNo === 1 ? 'first' : 'second', res);
  if (round.tryNo === 2) return finish('miss', res);

  const d = describe(res, round.midi);
  setState(S.BETWEEN);
  say(d.title, `${d.detail} Second try comes with the analyzer.`, 'bad');
  renderScope();
  if (settings.auto) after(3400, secondTry);
}

function secondTry() {
  round.tryNo = 2;
  scopeMode = 'live';
  livePts = [];
  playReference(false);
}

function finish(result, res) {
  const d = describe(res, round.midi);
  setState(S.DONE);
  log.push({
    ts: Date.now(),
    midi: round.midi,
    key: round.key,
    degree: round.degree,
    result,
    tries: round.tries,
  });
  store.saveLog(log);

  let where = `${noteName(round.midi)} (${round.freq.toFixed(1)} Hz)`;
  if (round.key) where += `, the ${degreeLabel(round.key.scale, round.degree)} of ${keyLabel(round.key)}`;
  if (result === 'first') say(d.title, `${d.detail} That was ${where}.`, 'good');
  else if (result === 'second') say(`Try two: ${d.title.toLowerCase()}`, `${d.detail} That was ${where}.`, 'ok');
  else say(d.title, `${d.detail} It was ${where}.`, 'bad');

  renderScope();
  renderScore();
  if (settings.auto) after(result === 'first' ? 2000 : 4000, newRound);
}

function replay() {
  if (!round || !round.midi) return;
  if (state === S.LISTENING || state === S.FINDING) playReference(false);
  else if (state === S.BETWEEN) secondTry();
  else if (state === S.DONE) {
    seq++; // holds auto-advance while you compare
    engine.playNote(round.midi, { dur: NOTE_DUR, vel: 0.85, timbre: round.timbre || settings.timbre });
  }
}

function mainAction() {
  if (state === S.IDLE) start();
  else if (state === S.BETWEEN) secondTry();
  else if (state === S.DONE) begin();
}

function skip() {
  if (state === S.IDLE || !engine.running) return;
  engine.stopAll();
  if (round && round.kind === 'calibrate' && !practice) {
    return startPractice(Math.round((settings.low + settings.high) / 2), 'Starting from the middle of your range.');
  }
  begin();
}

// ---------------------------------------------------------------- practice

/** First run: the singer's own comfortable note becomes the starting point. */
function calibrate() {
  round = { kind: 'calibrate', tryNo: 1 };
  lampSet('');
  holdBar(false);
  listen();
}

function setHome(ev) {
  const freqs = ev.frames.map((f) => f.freq).sort((a, b) => a - b);
  const sung = Math.round(69 + 12 * Math.log2(freqs[freqs.length >> 1] / 440));
  const home = Math.max(settings.low, Math.min(settings.high, sung));
  startPractice(home, sung === home ? `Your home note is ${noteName(home)}.` : `You sang ${noteName(sung)}, outside your range setting, so home is ${noteName(home)}.`);
}

function startPractice(home, note) {
  practice = createPractice(home);
  store.savePractice(practice);
  setState(S.DONE);
  lampSet('good', noteName(home));
  sound('good');
  say('Got it', `${note} Practice starts there and widens out one note at a time.`, 'good');
  renderScore();
  after(2400, practiceRound);
}

const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

function practiceRound() {
  const pick = pickPractice(practice, round ? round.midi : null, Math.random, today());
  round = { kind: pick.stage, review: pick.review, cold: !!pick.cold, midi: pick.midi, freq: midiToFreq(pick.midi), tryNo: 1 };
  lampSet('');
  playReference(false);
}

// "Find it": the note loops whenever you go quiet; the panel shows how close you are.
function listenFind() {
  find = { wait: 0.5, c: null, green: 0, off: 0, gap: 0, idle: 0 };
  setState(S.FINDING);
  say('Find it', 'Sing, and steer until the panel turns green. Then hold it there.', 'go');
}

function findFrame(f, voiced) {
  const dt = engine.frameDt;
  if (find.wait > 0) {
    find.wait -= dt; // let the reference die away in the room
    if (find.wait <= 0) setCue('go', 'Sing', 'steer to green');
    return;
  }
  if (!voiced) {
    find.gap += dt;
    find.idle += dt;
    if (find.gap > 0.15 && find.c !== null) {
      Object.assign(find, { c: null, green: 0 });
      setCue('go', 'Sing', 'steer to green');
    }
    if (find.idle > FIND_IDLE) playReference(false);
    return;
  }
  find.gap = 0;
  find.idle = 0;
  if (find.c === null) lampSet(''); // the live colour takes over from the cue
  const c = toCents(f.freq);
  find.c = find.c === null ? c : find.c + (c - find.c) * 0.4;
  if (Math.abs(c) <= settings.tol) {
    find.green += dt;
    find.off = 0;
  } else if ((find.off += dt) > 0.08) {
    find.green = 0;
  }
  if (find.green >= FIND_HOLD) found();
}

function found() {
  recordFind(practice, round.midi);
  store.savePractice(practice);
  holdBar(false);
  setState(S.DONE);
  lampSet('good', 'found it');
  sound('good');
  say('Found it', `That's ${noteName(round.midi)}. Now land on it cold — no steering.`, 'good');
  renderScore();
  after(1800, practiceRound);
}

// "Land it": one short note, judged on where it starts as much as where it settles.
function judgeLand(ev) {
  const res = evaluateAttempt(ev.frames, ev.t0, round.freq, settings);
  if (!res.valid) return unreadable();
  const d = describe(res, round.midi);
  const tone = res.ok ? 'good' : res.verdict === 'flat' || res.verdict === 'sharp' ? 'bad' : 'warn';
  const word = {
    hit: 'landed',
    flat: 'under',
    sharp: 'over',
    scoop: res.scoop && res.scoop.dir === 'down' ? 'slid down' : 'scooped up',
    unsteady: 'unsteady',
    octave: 'wrong octave',
  }[res.verdict];

  const out = recordLand(practice, round.midi, res.ok, { low: settings.low, high: settings.high, need: settings.landStreak, today: today() });
  store.savePractice(practice);
  cleanStreak = res.ok ? cleanStreak + 1 : 0;

  const name = noteName(round.midi);
  const n = practice.notes[round.midi];
  const tail =
    {
      unlocked: () => `${name} is solid. New note: ${noteName(out.midi)}.`,
      mastered: () => `${name} is solid.`,
      complete: () => `${name} is solid — that's your whole range. From here it's mixed review; widen the range in Settings when it gets easy.`,
      demoted: () => `${name} has slipped, so it's back in focus.`,
      refind: () => `Let's find ${name} again with the live colour.`,
    }[out.event] ||
    (() => {
      if (n.stage === 'land') return `${name}: ${n.streak} of ${settings.landStreak} in a row.`;
      return res.ok ? `${name} still holds.` : `${name}: one more miss and it's back in focus.`;
    });

  setState(S.DONE);
  lampSet(tone, word);
  verdictSound(res, ['unlocked', 'mastered', 'complete'].includes(out.event));
  say(d.title, `${d.detail} ${tail()}`, tone === 'warn' ? 'ok' : tone);
  renderScore();
  after(res.ok ? 1500 : 2800, practiceRound);
}

/** Show a verdict colour/word in the practice panel (or blank it). Clears any cue. */
function lampSet(tone, text = '') {
  cue = { kind: '', word: '', sub: '' };
  const el = $('lamp');
  el.style.backgroundColor = '';
  el.dataset.tone = tone;
  el.dataset.cue = '';
  $('lampText').textContent = text;
  $('lampSub').textContent = '';
  renderCover();
}

/** The big word in the middle panel: kind 'wait' (not yet) or 'go' (your turn). */
function setCue(kind, word, sub = '') {
  cue = { kind, word, sub };
  const el = $('lamp');
  el.style.backgroundColor = '';
  el.dataset.tone = '';
  el.dataset.cue = kind;
  $('lampText').textContent = word;
  $('lampSub').textContent = sub;
  renderCover();
}

/** Live colour while finding: green inside the window, through amber, to red far out. */
function lampLive() {
  const el = $('lamp');
  const bar = $('holdBar');
  bar.style.transition = 'none';
  bar.style.width = `${Math.min(100, (find.green / FIND_HOLD) * 100)}%`;
  if (find.c === null) return; // the cue is showing
  const off = Math.abs(find.c);
  const far = Math.max(0, Math.min(1, (off - settings.tol) / (settings.tol * 3)));
  el.style.backgroundColor = `hsl(${Math.round(152 * (1 - far))} 62% ${Math.round(34 + 4 * far)}%)`;
  $('lampText').textContent = off <= settings.tol ? 'hold' : find.c < 0 ? '▲ higher' : '▼ lower';
}

// ---------------------------------------------------------------- focus

/** The sounds focus mode rotates through: every instrument, one piano. */
const rotationSounds = () => SOUNDS.map((s) => s.id).filter((id) => id !== 'sine' && id !== 'salamander');

function focusMidi() {
  const m = settings.focusNote ?? (practice ? practice.home : Math.round((settings.low + settings.high) / 2));
  return Math.max(settings.low, Math.min(settings.high, m));
}

function nextFocusSound(prev) {
  if (!settings.focusRotate) return settings.timbre;
  if (!focusQueue.length) {
    focusQueue = rotationSounds().sort(() => Math.random() - 0.5);
    if (focusQueue[0] === prev && focusQueue.length > 1) focusQueue.push(focusQueue.shift()); // no back-to-back repeat
  }
  return focusQueue.shift();
}

/** One rep: the focus note, in the next sound of the rotation. */
async function focusRound() {
  const midi = focusMidi();
  const timbre = nextFocusSound(round && round.timbre);
  round = { kind: 'focus', midi, freq: midiToFreq(midi), timbre, tryNo: 1 };
  scopeMode = 'idle';
  lampSet('');
  setState(S.PLAYING);
  say('Listen…', `${soundName(timbre)}.`);
  const mine = seq;
  // Fetch this note in every sound of the rotation (a few files), not whole instruments.
  await Promise.race([engine.prepare(settings.focusRotate ? rotationSounds() : [timbre], midi), new Promise((r) => setTimeout(r, 5000))]);
  if (mine !== seq || !engine.running) return; // stopped or switched while loading
  playReference(false);
}

function judgeFocus(ev) {
  const res = evaluateAttempt(ev.frames, ev.t0, round.freq, settings);
  if (!res.valid) return unreadable();
  const d = describe(res, round.midi);
  const tone = res.ok ? 'good' : res.verdict === 'flat' || res.verdict === 'sharp' ? 'bad' : 'warn';
  const word = {
    hit: 'landed',
    flat: 'under',
    sharp: 'over',
    scoop: res.scoop && res.scoop.dir === 'down' ? 'slid down' : 'scooped up',
    unsteady: 'unsteady',
    octave: 'wrong octave',
  }[res.verdict];

  const byNote = (focusStats[round.midi] ||= {});
  const st = (byNote[round.timbre] ||= { n: 0, clean: 0 });
  st.n++;
  if (res.ok) st.clean++;
  store.saveFocus(focusStats);
  focusSession.n++;
  if (res.ok) focusSession.clean++;
  focusSession.streak = res.ok ? focusSession.streak + 1 : 0;

  setState(S.DONE);
  lampSet(tone, word);
  verdictSound(res);
  say(d.title, `${d.detail} ${soundName(round.timbre)}: ${st.clean} of ${st.n} clean.`, tone === 'warn' ? 'ok' : tone);
  renderScore();
  after(res.ok ? 1500 : 2800, focusRound);
}

/** Jump to focus mode on a note (from the practice ladder). */
function focusOn(midi) {
  settings.focusNote = midi;
  store.saveSettings(settings);
  syncSettings();
  focusQueue = [];
  if (mode === 'focus') {
    if (state !== S.IDLE && engine.running) {
      engine.stopAll();
      begin();
    }
    renderScore();
  } else setMode('focus');
}

function renderFocus() {
  const midi = focusMidi();
  const byNote = focusStats[midi] || {};
  const rows = Object.entries(byNote)
    .map(([id, s]) => ({ id, name: soundName(id), ...s, pct: s.clean / s.n }))
    .sort((a, b) => a.pct - b.pct || b.n - a.n);
  const tot = rows.reduce((a, r) => ({ n: a.n + r.n, clean: a.clean + r.clean }), { n: 0, clean: 0 });
  const sum = `<p class="focus-sum"><b>${noteName(midi)}</b> · this session <b>${focusSession.clean}</b> of ${focusSession.n} clean · run <b>${focusSession.streak}</b>${
    tot.n ? ` · all time <b>${Math.round((tot.clean / tot.n) * 100)}%</b> of ${tot.n}` : ''
  }</p>`;
  if (!rows.length) {
    $('focusBody').innerHTML = `${sum}<p class="empty">Press Start. Each rep plays ${noteName(midi)} on ${settings.focusRotate ? 'a different instrument' : soundName(settings.timbre)}; the sounds you miss most will rise to the top here.</p>`;
    return;
  }
  const row = (r) => {
    const color = r.pct < 0.5 ? 'var(--bad)' : r.pct < 0.8 ? 'var(--warn)' : 'var(--good)';
    return `<tr><td class="name">${r.name}</td><td><span class="bar"><i style="--w:${Math.round(r.pct * 100)}%;--c:${color}"></i><em>${Math.round(r.pct * 100)}%</em></span></td><td class="num">${r.clean}/${r.n}</td></tr>`;
  };
  $('focusBody').innerHTML = `${sum}<div class="table-wrap"><table><thead><tr><th>Sound · hardest first</th><th>Clean</th><th class="num">Reps</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------- analyzer

/** Analyzer mode: no reference, no scoring, just your pitch against the nearest note. */
function freeRun() {
  round = null;
  review = null;
  scopeMode = 'free';
  freePts = [];
  freeCenter = Math.round((settings.low + settings.high) / 2);
  freeShown = '';
  holdBar(false);
  lampSet('');
  setState(S.FREE);
  say('Sing or play', 'Your pitch shows live against the nearest note. Play a note on your piano, then sing it and compare the two lines.');
  renderScope();
}

function freeTick() {
  const now = lastFrame.t;
  const recent = freePts.filter((p) => now - p.t < 0.12).map((p) => p.m).sort((a, b) => a - b);
  const m = recent.length ? recent[recent.length >> 1] : null;
  if (m !== null) freeCenter += (Math.round(m) - freeCenter) * 0.06;
  scope.drawFree(freePts, now, freeCenter, settings.tol, FREE_SPAN);
  if (m === null) {
    readout(null);
    $('status').dataset.tone = '';
    return;
  }
  const near = Math.round(m);
  readout(100 * (m - near), noteName(near));
  const off = Math.abs(100 * (m - near));
  if (freeShown !== noteName(near)) {
    freeShown = noteName(near);
    $('status').textContent = freeShown;
  }
  $('status').dataset.tone = off <= settings.tol ? 'good' : off <= settings.tol * 2 ? 'ok' : 'bad';
}

function setMode(next) {
  if (next === mode) return;
  mode = next;
  settings.mode = next;
  store.saveSettings(settings);
  renderMode();
  if (state === S.IDLE || !engine.running) return;
  engine.stopAll();
  holdBar(false);
  round = null;
  begin();
}

function renderMode() {
  document.body.dataset.mode = mode;
  $('modePractice').setAttribute('aria-selected', String(mode === 'practice'));
  $('modeTest').setAttribute('aria-selected', String(mode === 'test'));
  $('modeFree').setAttribute('aria-selected', String(mode === 'free'));
  $('modeFocus').setAttribute('aria-selected', String(mode === 'focus'));
  renderControls();
  if (state === S.IDLE) {
    if (mode === 'practice') say('Find the note. Then land on it.', 'One note at a time, starting where your voice sits. The range widens as you nail each one.');
    else if (mode === 'focus') say(`Focus: ${noteName(focusMidi())}`, 'One note on repeat, a different instrument each time. Pick the note below, or tap any note under Practice → Your notes.');
    else if (mode === 'free') say('Just the analyzer', 'No notes from the app and no scoring. Press Start, then play your own piano and sing — your pitch shows live against the nearest note.');
    else say('Hear a note. Sing it back.', 'Your first try is blind. Miss it, and the pitch analyzer switches on for a second try.');
  }
  renderScope();
  renderScore();
}

function micError(err) {
  if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return 'Microphone access is blocked. Allow it for this site in your browser settings, then press Start.';
  if (err.name === 'NotFoundError') return 'No microphone was found. Plug one in and press Start.';
  if (err.name === 'Unsupported') return 'This browser can’t run the pitch analyzer. Use a current Chrome, Safari, Firefox or Edge, over HTTPS.';
  return `Couldn't start audio (${err.message || err.name}).`;
}

// ---------------------------------------------------------------- rendering

function renderControls() {
  document.body.dataset.state = state;
  const main = $('btnMain');
  main.textContent = { idle: 'Start', playing: 'Playing…', listening: 'Listening…', capturing: 'Listening…', finding: 'Listening…', between: 'Try again', done: 'Next note', free: 'Listening…' }[state];
  main.disabled = ![S.IDLE, S.BETWEEN, S.DONE].includes(state);
  $('btnReplay').disabled = !(round && round.midi && [S.LISTENING, S.FINDING, S.BETWEEN, S.DONE].includes(state));
  $('btnSkip').disabled = state === S.IDLE || state === S.FREE;
  $('btnStop').disabled = state === S.IDLE;

  let badge = mode === 'free' ? 'Analyzer' : 'Ready';
  if (state === S.FREE) badge = 'Analyzer · live';
  if (round && round.kind === 'test') badge = `Try ${round.tryNo} · ${round.tryNo === 1 ? 'blind' : 'analyzer'}`;
  else if (round && round.kind === 'calibrate') badge = 'Home note';
  else if (round && round.kind === 'focus') badge = `${noteName(round.midi)} · ${soundName(round.timbre)}`;
  else if (round) badge = `${noteName(round.midi)} · ${round.kind === 'find' ? 'find it' : round.cold ? 'cold check' : round.review ? 'review' : 'land it'}`;
  $('tryBadge').textContent = badge;
  const key = $('keyBadge');
  key.hidden = !(round && round.key);
  if (round && round.key) key.textContent = keyLabel(round.key);
}

/** Test mode's middle panel: the blind-try cover, which also carries the WAIT / SING cue. */
function renderCover() {
  const base = { idle: mode === 'free' ? 'Press Start to see your pitch' : 'Switches on after a miss', blind: 'Try 1 is blind — trust your ear' }[scopeMode];
  const over = scopeMode === 'live' && cue.kind === 'wait'; // on try 2, cover the analyzer until it's your turn
  const el = $('scopeCover');
  el.hidden = !(base || over);
  el.dataset.cue = cue.kind;
  el.toggleAttribute('data-over', over);
  $('coverBig').textContent = cue.kind ? cue.word : '';
  $('coverText').textContent = cue.kind ? cue.sub : base || '';
}

function renderScope() {
  renderCover();
  $('scopeLabel').textContent = { idle: 'Pitch analyzer', blind: 'Pitch analyzer · off', review: 'Try 1 · what you sang', live: 'Live', free: 'Live · nearest note' }[scopeMode];
  if (scopeMode === 'review' && review) {
    scope.drawReview(review, settings.tol);
    readout(review.cents, 'settled');
  } else if (scopeMode !== 'live' && scopeMode !== 'free') {
    scope.clear();
    readout(null);
  }
}

function readout(cents, word = '') {
  const c = cents === null ? null : Math.round(cents);
  const off = Math.abs(c);
  $('readCents').textContent = c === null ? '' : `${c < 0 ? '−' : '+'}${off}¢`;
  $('readNote').textContent = c === null ? '' : word || (off <= settings.tol ? 'in tune' : c < 0 ? 'flat' : 'sharp');
  $('readout').dataset.tone = c === null ? '' : off <= settings.tol ? 'good' : off <= settings.tol * 2 ? 'warn' : 'bad';
}

function holdBar(on, secs = 1) {
  const bar = $('holdBar');
  bar.style.transition = 'none';
  bar.style.width = '0';
  if (!on) return;
  void bar.offsetWidth;
  bar.style.transition = `width ${secs}s linear`;
  bar.style.width = '100%';
}

function tick() {
  requestAnimationFrame(tick);
  const db = lastFrame ? 20 * Math.log10(Math.max(lastFrame.rms, 1e-6)) : -120;
  meter += (Math.max(0, Math.min(1, (db + 60) / 50)) - meter) * 0.3;
  $('meterFill').style.width = `${(meter * 100).toFixed(1)}%`;

  if (state === S.FINDING) lampLive();
  if (state === S.FREE && lastFrame) return freeTick();
  if (scopeMode !== 'live' || !lastFrame) return;
  scope.drawLive(livePts, lastFrame.t, settings.tol, liveMark, LIVE_SPAN);
  const head = livePts[livePts.length - 1];
  readout(head && lastFrame.t - head.t < 0.15 ? head.c : null);
}

const pctText = (p) => (p === null ? '–' : `${Math.round(p * 100)}%`);
const centsText = (c) => (c === null ? '–' : `${Math.round(c)}¢`);

function renderScore() {
  const session = log.filter((r) => r.ts >= sessionStart);
  const now = store.summarize(session);
  if (mode === 'practice') {
    const solid = practice ? practice.order.filter((m) => practice.notes[m].stage === 'mastered').length : 0;
    $('chipA').textContent = solid;
    $('chipALabel').textContent = solid === 1 ? 'note solid' : 'notes solid';
    $('chipB').textContent = cleanStreak;
  } else if (mode === 'focus') {
    $('chipA').textContent = focusSession.n ? pctText(focusSession.clean / focusSession.n) : '–';
    $('chipALabel').textContent = 'clean';
    $('chipB').textContent = focusSession.streak;
  } else {
    $('chipA').textContent = pctText(now.pct);
    $('chipALabel').textContent = 'first try';
    $('chipB').textContent = now.streak;
  }
  renderPractice();
  renderFocus();

  const recs = statsScope === 'session' ? session : log;
  const s = statsScope === 'session' ? now : store.summarize(log);
  const cell = (value, label, small) => `<div class="stat"><b>${value}</b><span>${label}</span><small>${small}</small></div>`;
  $('stats').innerHTML = [
    cell(pctText(s.pct), 'First try', `${s.first} of ${s.n} rounds`),
    cell(s.second, 'Second try', `saved ${s.second} of ${s.second + s.miss}`),
    cell(s.miss, 'Missed', 'both tries'),
    cell(centsText(s.avgErr), 'Avg error', 'on first tries'),
    cell(s.up + s.down, 'Scoops', `↗ ${s.up} up · ↘ ${s.down} down`),
    cell(s.streak, 'Streak', `best ${s.best}`),
  ].join('');

  renderNoteLog(recs);
  renderHistory();
}

function renderPractice() {
  if (!practice) {
    $('practiceBody').innerHTML = '<p class="empty">Press Start and sing any comfortable note. Practice builds outward from there, one note at a time.</p>';
    return;
  }
  const notes = [...practice.order].sort((a, b) => a - b);
  const solid = notes.filter((m) => practice.notes[m].stage === 'mastered').length;
  const focus = learning(practice);
  const chip = (m) => {
    const n = practice.notes[m];
    const label = { find: 'find', land: `land ${n.streak || 0}/${settings.landStreak}`, mastered: 'solid' }[n.stage];
    const dots = n.recent.map((ok) => (ok ? '●' : '○')).join('');
    return `<button type="button" class="pnote ${n.stage}${m === focus ? ' focus' : ''}${m === practice.home ? ' home' : ''}" data-midi="${m}" title="Focus on ${noteName(m)}"><b>${noteName(m)}</b><i>${label}</i><em>${dots}</em></button>`;
  };
  $('practiceBody').innerHTML = `<p class="practice-sum"><b>${solid}</b> solid · <b>${notes.length}</b> of ${settings.high - settings.low + 1} unlocked · range ${noteName(notes[0])}–${noteName(notes[notes.length - 1])}</p>
    <div class="ladder">${notes.map(chip).join('')}</div>`;
}

function renderNoteLog(recs) {
  const mode = $('groupBy').value;
  const groups = store.groupStats(recs, mode);
  if (!groups.length) {
    $('noteLog').innerHTML = `<p class="empty">${
      mode === 'degree' && recs.length ? 'Turn on “Establish a key first” to log scale degrees.' : 'Nothing logged yet. Notes you miss most will rise to the top.'
    }</p>`;
    return;
  }
  const row = (g) => {
    const tag = g.n < 3 ? ['new', 'new'] : g.pct < 0.5 ? ['hard', 'hard'] : g.pct < 0.8 ? ['mid', 'so-so'] : ['easy', 'easy'];
    const color = g.pct < 0.5 ? 'var(--bad)' : g.pct < 0.8 ? 'var(--warn)' : 'var(--good)';
    const bias = g.bias === null ? '–' : Math.abs(g.bias) < 5 ? 'centred' : `${Math.round(Math.abs(g.bias))}¢ ${g.bias < 0 ? 'flat' : 'sharp'}`;
    return `<tr>
      <td class="name">${g.label}</td>
      <td><span class="tag ${tag[0]}">${tag[1]}</span></td>
      <td><span class="bar"><i style="--w:${Math.round(g.pct * 100)}%;--c:${color}"></i><em>${pctText(g.pct)}</em></span></td>
      <td class="num">${g.first}/${g.n}</td>
      <td class="num">${centsText(g.avgErr)}</td>
      <td>${bias}</td>
      <td class="num">${g.scoops}</td>
    </tr>`;
  };
  $('noteLog').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Note</th><th></th><th>First try</th><th class="num">Hits</th><th class="num">Avg err</th><th>Tendency</th><th class="num">Scoops</th></tr></thead>
    <tbody>${groups.map(row).join('')}</tbody></table></div>`;
}

function tryText(t) {
  if (!t) return '';
  const abs = Math.abs(Math.round(t.cents));
  const scoop = t.scoop ? (t.scoop === 'up' ? ' · scooped up' : ' · slid down') : '';
  if (t.v === 'hit') return `${t.cents < 0 ? '−' : '+'}${abs}¢${scoop}`;
  if (t.v === 'flat' || t.v === 'sharp') return `${abs >= 150 ? `${(abs / 100).toFixed(1)} st` : `${abs}¢`} ${t.v}${scoop}`;
  if (t.v === 'scoop') return `${t.scoop === 'up' ? 'scooped up' : 'slid down'} from ${Math.abs(t.from)}¢ ${t.scoop === 'up' ? 'under' : 'over'}`;
  if (t.v === 'octave') return 'wrong octave';
  return `unsteady ±${Math.round(t.spread)}¢`;
}

function renderHistory() {
  const rows = log.slice(-15).reverse();
  if (!rows.length) {
    $('history').innerHTML = '<p class="empty">Your rounds will show up here.</p>';
    return;
  }
  const label = { first: '1st try', second: '2nd try', miss: 'missed' };
  $('history').innerHTML = `<div class="hist">${rows
    .map((r) => {
      const time = new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const ctx = r.key ? ` · ${degreeLabel(r.key.scale, r.degree)} of ${keyLabel(r.key)}` : '';
      return `<div class="hist-row"><span class="n">${noteName(r.midi)}</span><span class="r ${r.result}">${label[r.result]}</span><span class="d">${tryText(r.tries[0])}${ctx}</span><span class="t">${time}</span></div>`;
    })
    .join('')}</div>`;
}

// ---------------------------------------------------------------- settings

const FIELDS = [
  ['setAnyOctave', 'anyOctave'],
  ['setTol', 'tol'],
  ['setHold', 'hold'],
  ['setScoop', 'scoopThr'],
  ['setScoopMs', 'scoopMs'],
  ['setStrict', 'strictOnset'],
  ['setStreak', 'landStreak'],
  ['setGap', 'gap'],
  ['setClicks', 'clicks'],
  ['setKeyMode', 'keyMode'],
  ['setKeyTonic', 'keyTonic'],
  ['setKeyScale', 'keyScale'],
  ['setKeyIntro', 'keyIntro'],
  ['setTimbre', 'timbre'],
  ['setBright', 'brightPiano'],
  ['setSounds', 'sounds'],
  ['setAuto', 'auto'],
  ['setSpeakerFix', 'speakerFix'],
];

function fillSelect(el, options) {
  el.innerHTML = options.map(([value, text]) => `<option value="${value}">${text}</option>`).join('');
}

function syncSettings() {
  for (const [id, key] of FIELDS) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = settings[key];
    else el.value = String(settings[key]);
  }
  $('setPreset').value = settings.rangePreset;
  $('setLow').value = settings.low;
  $('setHigh').value = settings.high;
  for (const id of ['setKeyTonic', 'setKeyScale', 'setKeyIntro']) $(id).disabled = !settings.keyMode;
  $('rowBright').hidden = !(HAS_EARMASTER && settings.timbre === 'piano');
  const notes = [];
  for (let m = settings.low; m <= settings.high; m++) notes.push([m, noteName(m)]);
  fillSelect($('focusNote'), notes);
  $('focusNote').value = String(focusMidi());
  $('focusRotate').checked = settings.focusRotate;
}

function initSettings() {
  const notes = [];
  for (let m = 36; m <= 84; m++) notes.push([m, noteName(m)]);
  fillSelect($('setLow'), notes);
  fillSelect($('setHigh'), notes);
  fillSelect($('setPreset'), [...Object.entries(RANGES).map(([k, r]) => [k, r.label]), ['custom', 'Custom']]);
  fillSelect($('setKeyTonic'), [['random', 'Random'], ...NOTE_NAMES.map((n, i) => [i, n])]);
  fillSelect($('setTimbre'), SOUNDS.map((s) => [s.id, s.name]));
  if (!SOUNDS.some((s) => s.id === settings.timbre)) settings.timbre = 'piano';

  for (const [id, key] of FIELDS) {
    $(id).addEventListener('change', (e) => {
      const el = e.target;
      settings[key] = el.type === 'checkbox' ? el.checked : typeof store.DEFAULTS[key] === 'number' ? Number(el.value) : el.value;
      commit();
      if (key === 'brightPiano') engine.bright = settings.brightPiano;
      if (key === 'timbre' && engine.running) engine.useTimbre(settings.timbre);
      if (key === 'speakerFix' && engine.running) {
        stop(); // the audio route is chosen when audio starts
        say('Stopped', 'Press Start to use the new speaker setting.');
      }
    });
  }
  $('setPreset').addEventListener('change', (e) => {
    settings.rangePreset = e.target.value;
    const r = RANGES[e.target.value];
    if (r) Object.assign(settings, { low: r.low, high: r.high });
    commit();
  });
  // Keep at least a major third between the ends of a custom range.
  $('setLow').addEventListener('change', (e) => {
    settings.low = Math.min(Number(e.target.value), 80);
    settings.high = Math.max(settings.high, settings.low + 4);
    settings.rangePreset = 'custom';
    commit();
  });
  $('setHigh').addEventListener('change', (e) => {
    settings.high = Math.max(Number(e.target.value), 40);
    settings.low = Math.min(settings.low, settings.high - 4);
    settings.rangePreset = 'custom';
    commit();
  });
  $('rowSpeakerFix').hidden = !IS_IOS;
  if (!HAS_EARMASTER) $('setTimbre').querySelector('option[value="piano"]').textContent = 'Grand piano';
  syncSettings();
}

function commit() {
  store.saveSettings(settings);
  syncSettings();
  if (scopeMode === 'review') renderScope();
  renderScore();
}

function toggleSettings(open) {
  $('settings').hidden = !open;
  $('btnSettings').setAttribute('aria-expanded', String(open));
}

// ---------------------------------------------------------------- wiring

function onClick(id, fn) {
  $(id).addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur(); // mouse/touch: don't leave Space bound to this button
    fn();
  });
}

onClick('btnMain', mainAction);
onClick('btnReplay', replay);
onClick('btnSkip', skip);
onClick('btnStop', stop);
onClick('btnSettings', () => toggleSettings($('settings').hidden));
onClick('btnReset', () => {
  if (!log.length || !confirm('Clear the whole log and all scores?')) return;
  log = [];
  store.saveLog(log);
  renderScore();
});
onClick('modePractice', () => setMode('practice'));
onClick('modeTest', () => setMode('test'));
onClick('modeFree', () => setMode('free'));
onClick('modeFocus', () => setMode('focus'));
$('focusNote').addEventListener('change', (e) => focusOn(Number(e.target.value)));
$('focusRotate').addEventListener('change', (e) => {
  settings.focusRotate = e.target.checked;
  store.saveSettings(settings);
  focusQueue = [];
  renderScore();
});
$('practiceBody').addEventListener('click', (e) => {
  const chip = e.target.closest('button.pnote');
  if (chip) focusOn(Number(chip.dataset.midi));
});
onClick('btnResetPractice', () => {
  if (!practice || !confirm('Forget your practice progress and pick a new home note?')) return;
  practice = null;
  store.savePractice(null);
  cleanStreak = 0;
  renderScore();
  if (mode === 'practice' && state !== S.IDLE && engine.running) {
    engine.stopAll();
    begin();
  }
});
for (const [id, scopeName] of [['tabSession', 'session'], ['tabAll', 'all']]) {
  onClick(id, () => {
    statsScope = scopeName;
    $('tabSession').setAttribute('aria-selected', String(scopeName === 'session'));
    $('tabAll').setAttribute('aria-selected', String(scopeName === 'all'));
    renderScore();
  });
}
$('groupBy').addEventListener('change', renderScore);

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('select, input, button, a')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    mainAction();
  } else if (e.key === 'r') replay();
  else if (e.key === 's') skip();
});

initSettings();
if (firstVisit) toggleSettings(true); // pick your range before the first note
renderControls();
renderMode();
requestAnimationFrame(tick);

window.pitchmatch = {
  get mode() {
    return mode;
  },
  get practice() {
    return practice;
  },
  get state() {
    return state;
  },
  get round() {
    return round;
  },
  get log() {
    return log;
  },
};
