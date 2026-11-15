// The practice ladder. Pure — no DOM, no audio.
//
// Practice starts on one "home" note and widens outward a semitone at a time.
// Each note climbs: FIND (live colour, steering allowed, just to locate it)
// → LAND (hear it, then hit it cold; only a clean onset counts) → MASTERED,
// after `need` clean landings in a row.
//
// A streak right after hearing the note mostly proves short-term echo memory,
// so mastery has to survive time: every mastered note is re-checked cold on
// each new day before anything else, and keeps returning as mixed review.
// Slip twice and it goes back to LAND. Only one note is in focus at a time.

const WINDOW = 5; // recent landings remembered per note (for display and review weighting)
const REVIEW_SHARE = 1 / 3; // how often a mastered note interrupts the focus note
const MISSES_TO_REFIND = 3;

const fresh = () => ({ stage: 'find', recent: [], reps: 0, clean: 0, misses: 0, streak: 0, day: null });

export function createPractice(home) {
  return { v: 1, home, order: [home], notes: { [home]: fresh() } };
}

/** The note currently being learned, or null when everything unlocked is mastered. */
export function learning(p) {
  const m = p.order.find((n) => p.notes[n].stage !== 'mastered');
  return m === undefined ? null : m;
}

/** Next note to unlock: nearest to home, alternating above and below, inside [low, high]. */
export function nextUnlock(p, low, high) {
  for (let d = 1; d <= 60; d++) {
    for (const m of [p.home + d, p.home - d]) {
      if (m >= low && m <= high && !p.notes[m]) return m;
    }
  }
  return null;
}

const hits = (n) => n.recent.reduce((a, b) => a + b, 0);

function weighted(pool, p, rnd) {
  const weights = pool.map((m) => 1 + 1.5 * (p.notes[m].recent.length - hits(p.notes[m])));
  let x = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) if ((x -= weights[i]) <= 0) return pool[i];
  return pool[pool.length - 1];
}

/**
 * What to practise next: { midi, stage: 'find' | 'land', review, cold? }.
 * `today` is any string that changes daily; with it, notes mastered on an
 * earlier day are checked cold first.
 */
export function pickPractice(p, prev = null, rnd = Math.random, today = null) {
  const focus = learning(p);
  const mastered = p.order.filter((m) => p.notes[m].stage === 'mastered');
  if (today) {
    let due = mastered.filter((m) => p.notes[m].day !== today);
    if (due.length > 1) due = due.filter((m) => m !== prev);
    if (due.length) return { midi: due[Math.floor(rnd() * due.length)], stage: 'land', review: true, cold: true };
  }
  if (focus !== null) {
    if (p.notes[focus].stage === 'find') return { midi: focus, stage: 'find', review: false };
    const pool = mastered.filter((m) => m !== prev);
    if (pool.length && rnd() < REVIEW_SHARE) return { midi: weighted(pool, p, rnd), stage: 'land', review: true };
    return { midi: focus, stage: 'land', review: false };
  }
  const pool = mastered.length > 1 ? mastered.filter((m) => m !== prev) : mastered;
  return { midi: weighted(pool, p, rnd), stage: 'land', review: true };
}

/** The note was located with live feedback; it moves on to landing. */
export function recordFind(p, midi) {
  const n = p.notes[midi];
  n.stage = 'land';
  n.misses = 0;
}

/**
 * One landing attempt. opts: { low, high, need, today } — `need` clean landings
 * in a row master a note. Returns { event, midi? } where event is
 * unlocked | mastered | complete | demoted | refind | null.
 */
export function recordLand(p, midi, clean, { low, high, need = 3, today = null }) {
  const n = p.notes[midi];
  n.reps++;
  if (clean) n.clean++;
  n.streak = clean ? (n.streak || 0) + 1 : 0;
  n.misses = clean ? 0 : n.misses + 1;
  n.day = today;
  n.recent.push(clean ? 1 : 0);
  if (n.recent.length > WINDOW) n.recent.shift();

  if (n.stage === 'land') {
    if (n.streak >= need) {
      n.stage = 'mastered';
      if (learning(p) !== null) return { event: 'mastered' };
      const next = nextUnlock(p, low, high);
      if (next === null) return { event: 'complete' };
      p.notes[next] = fresh();
      p.order.push(next);
      return { event: 'unlocked', midi: next };
    }
    if (n.misses >= MISSES_TO_REFIND) {
      Object.assign(n, { stage: 'find', recent: [], misses: 0, streak: 0 });
      return { event: 'refind' };
    }
  } else if (n.stage === 'mastered' && n.misses >= 2) {
    Object.assign(n, { stage: 'land', recent: [], misses: 0, streak: 0 });
    return { event: 'demoted' };
  }
  return { event: null };
}
