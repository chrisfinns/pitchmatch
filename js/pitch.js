// YIN pitch detector (de Cheveigné & Kawahara, 2002) with parabolic refinement.
// Pure — takes a Float32Array window, returns { freq, clarity, rms }.

export class PitchDetector {
  constructor(sampleRate, size = 2048, { minFreq = 60, maxFreq = 1300, threshold = 0.15 } = {}) {
    this.sr = sampleRate;
    this.size = size;
    this.threshold = threshold;
    this.tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
    this.tauMax = Math.min(Math.floor(sampleRate / minFreq), size >> 1);
    this.w = size - this.tauMax - 1; // integration window, constant for every lag
    this.d = new Float64Array(this.tauMax + 2);
  }

  detect(buf) {
    const { tauMin, tauMax, w, d } = this;

    let energy = 0;
    for (let i = 0; i < buf.length; i++) energy += buf[i] * buf[i];
    const rms = Math.sqrt(energy / buf.length);
    if (rms < 1e-5) return { freq: 0, clarity: 0, rms };

    // Difference function.
    const last = tauMax + 1;
    for (let tau = 1; tau <= last; tau++) {
      let s = 0;
      for (let i = 0; i < w; i++) {
        const x = buf[i] - buf[i + tau];
        s += x * x;
      }
      d[tau] = s;
    }

    // Cumulative mean normalised difference.
    d[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= last; tau++) {
      run += d[tau];
      d[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }

    // First dip under the threshold, walked down to its local minimum.
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < this.threshold) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      // Nothing periodic enough: report the best guess, its low clarity will gate it out.
      tau = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (d[t] < d[tau]) tau = t;
    }

    // Parabolic interpolation around the minimum for sub-sample precision.
    const a = d[tau - 1];
    const b = d[tau];
    const c = d[tau + 1];
    const denom = a - 2 * b + c;
    let shift = denom !== 0 ? (a - c) / (2 * denom) : 0;
    if (!(Math.abs(shift) < 1)) shift = 0;
    const min = b - 0.25 * (a - c) * shift;

    return {
      freq: this.sr / (tau + shift),
      clarity: Math.max(0, Math.min(1, 1 - min)),
      rms,
    };
  }
}
