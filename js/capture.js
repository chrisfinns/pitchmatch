// Turns a stream of pitch frames into discrete sung notes.
// A note only counts if it starts from silence — so humming along with the
// reference, or the reference's own tail in the room, can't be scored.

export class NoteTracker {
  constructor(opts = {}) {
    this.hold = 1; // seconds of note to capture
    this.minClarity = 0.85;
    this.rmsFloor = 0.003;
    this.armSilence = 0.1; // quiet needed before a note may start
    this.onsetFrames = 3; // consecutive voiced frames that make an onset
    this.maxGap = 0.12; // dropout that ends a note
    this.noise = Infinity;
    Object.assign(this, opts);
    this.reset();
  }

  reset() {
    this.state = 'arming';
    this.quietSince = null;
    this.run = [];
    this.frames = [];
    this.total = 0;
  }

  /** Is this frame a sung pitch? Also tracks the room's noise floor. */
  voiced(f) {
    this.noise = Math.min(this.noise * 1.001 + 1e-6, f.rms);
    const gate = Math.max(this.rmsFloor, this.noise * 3);
    return f.freq > 0 && f.clarity >= this.minClarity && f.rms >= gate;
  }

  /** Feed one frame. Returns null or an event: armed | onset | short | done. */
  step(f, voiced) {
    if (this.state === 'arming') {
      if (voiced) {
        this.quietSince = null;
      } else {
        if (this.quietSince === null) this.quietSince = f.t;
        if (f.t - this.quietSince >= this.armSilence) {
          this.state = 'armed';
          this.run = [];
          return { type: 'armed' };
        }
      }
      return null;
    }

    if (this.state === 'armed') {
      if (!voiced) {
        this.run = [];
        return null;
      }
      this.run.push({ t: f.t, freq: f.freq });
      if (this.run.length < this.onsetFrames) return null;
      this.state = 'capturing';
      this.frames = this.run;
      this.run = [];
      this.t0 = this.frames[0].t;
      this.lastVoiced = f.t;
      this.total = this.frames.length;
      return { type: 'onset', t0: this.t0 };
    }

    // capturing
    this.total++;
    if (voiced) {
      this.frames.push({ t: f.t, freq: f.freq });
      this.lastVoiced = f.t;
    }
    if (f.t - this.t0 >= this.hold) {
      const ev = { type: 'done', t0: this.t0, frames: this.frames, coverage: this.frames.length / this.total };
      this.reset();
      return ev;
    }
    if (!voiced && f.t - this.lastVoiced > this.maxGap) {
      const ev = { type: 'short', dur: this.lastVoiced - this.t0 };
      this.reset();
      return ev;
    }
    return null;
  }
}
