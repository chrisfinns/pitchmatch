// The pitch analyzer: cents-vs-target over time, on a canvas.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const MONO = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export class Scope {
  constructor(canvas, onResize) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.col = {
      good: css('--good'),
      warn: css('--warn'),
      bad: css('--bad'),
      grid: css('--line'),
      text: css('--muted'),
      band: 'rgba(110, 231, 183, 0.13)',
      zone: 'rgba(255, 255, 255, 0.045)',
    };
    this.fit();
    new ResizeObserver(() => {
      this.fit();
      if (onResize) onResize();
    }).observe(canvas);
  }

  fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const r = this.cv.getBoundingClientRect();
    this.w = Math.max(80, r.width);
    this.h = Math.max(80, r.height);
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.box = { x0: 40, x1: this.w - 10, y0: 14, y1: this.h - 20 };
  }

  clear() {
    this.g.clearRect(0, 0, this.w, this.h);
  }

  /** Grid, in-tune band and centre line. Returns the cents → y mapping. */
  _base(range, tol) {
    const { g, col } = this;
    const { x0, x1, y0, y1 } = this.box;
    const mid = (y0 + y1) / 2;
    const y = (c) => mid - (clamp(c, -range, range) / range) * ((y1 - y0) / 2);
    this.clear();

    g.fillStyle = col.band;
    g.fillRect(x0, y(tol), x1 - x0, y(-tol) - y(tol));

    const step = range <= 150 ? 50 : range <= 400 ? 100 : 200;
    g.font = MONO;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.lineWidth = 1;
    for (let c = -Math.floor(range / step) * step; c <= range; c += step) {
      g.strokeStyle = col.grid;
      g.globalAlpha = c === 0 ? 1 : 0.55;
      g.beginPath();
      g.moveTo(x0, Math.round(y(c)) + 0.5);
      g.lineTo(x1, Math.round(y(c)) + 0.5);
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = col.text;
      g.fillText(c === 0 ? '0¢' : `${c > 0 ? '+' : '−'}${Math.abs(c)}`, x0 - 6, y(c));
    }
    g.strokeStyle = col.good;
    g.globalAlpha = 0.7;
    g.beginPath();
    g.moveTo(x0, Math.round(mid) + 0.5);
    g.lineTo(x1, Math.round(mid) + 0.5);
    g.stroke();
    g.globalAlpha = 1;
    return y;
  }

  _trace(pts, x, y, tol) {
    const { g, col } = this;
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (b.t - a.t > 0.05) continue; // breath / dropout
      const off = Math.max(Math.abs(a.c), Math.abs(b.c));
      g.strokeStyle = off <= tol ? col.good : off <= tol * 2 ? col.warn : col.bad;
      g.beginPath();
      g.moveTo(x(a.t), y(a.c));
      g.lineTo(x(b.t), y(b.c));
      g.stroke();
    }
  }

  _label(text, x, y, color, align = 'left') {
    const { g } = this;
    g.font = MONO;
    g.textAlign = align;
    g.textBaseline = 'top';
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  /** Static, zoomed plot of one judged note. */
  drawReview(res, tol) {
    const { g, col } = this;
    const { x0, x1, y0, y1 } = this.box;
    const peak = res.pts.reduce((m, p) => Math.max(m, Math.abs(p.c)), tol);
    const range = clamp(Math.ceil((peak + 25) / 50) * 50, 100, 700);
    const y = this._base(range, tol);
    const x = (t) => x0 + (t / res.dur) * (x1 - x0);

    g.fillStyle = col.zone;
    g.fillRect(x0, y0, x(res.onsetWin) - x0, y1 - y0);
    this._label('ONSET', x0 + 5, y0 + 4, col.text);
    this._label('SUSTAIN', x(res.bodyStart) + 5, y0 + 4, col.text);

    // Where the note settled.
    g.setLineDash([4, 4]);
    g.strokeStyle = col.text;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x(res.bodyStart), y(res.cents));
    g.lineTo(x1, y(res.cents));
    g.stroke();
    g.setLineDash([]);

    this._trace(res.pts, x, y, tol);

    if (res.scoop) {
      const first = res.pts[0];
      const tint = res.scoop.minor ? col.warn : col.bad;
      g.fillStyle = tint;
      g.beginPath();
      g.arc(x(first.t), y(first.c), 4, 0, Math.PI * 2);
      g.fill();
      // The trace heads away from the dot diagonally; put the label on the free side.
      const up = res.scoop.dir === 'up';
      const ly = up ? Math.min(y(first.c) + 7, y1 - 13) : Math.max(y(first.c) - 17, y0 + 18);
      this._label(res.scoop.minor ? (up ? 'lean-in ↗' : 'lean-in ↘') : up ? 'scoop ↗' : 'slide ↘', x(first.t) + 9, ly, tint);
    }

    g.textBaseline = 'top';
    for (let t = 0; t <= res.dur + 1e-6; t += 0.25) {
      this._label(`${t.toFixed(2)}s`, x(t), y1 + 5, col.text, t === 0 ? 'left' : t > res.dur - 0.1 ? 'right' : 'center');
    }
  }

  /** Scrolling live trace. `mark` shades the stretch that was scored. */
  drawLive(pts, now, tol, mark, span = 4) {
    const { g, col } = this;
    const { x0, x1, y0, y1 } = this.box;
    const y = this._base(200, tol);
    const x = (t) => x1 - ((now - t) / span) * (x1 - x0);

    if (mark && mark.t1 > now - span) {
      const a = Math.max(x0, x(mark.t0));
      const b = Math.max(x0, Math.min(x1, x(mark.t1)));
      g.fillStyle = col.zone;
      g.fillRect(a, y0, b - a, y1 - y0);
      if (b - a > 44) this._label('SCORED', a + 5, y0 + 4, col.text);
    }

    const visible = pts.filter((p) => p.t >= now - span);
    g.save();
    g.beginPath();
    g.rect(x0, y0 - 4, x1 - x0, y1 - y0 + 8);
    g.clip();
    this._trace(visible, x, y, tol);
    g.restore();

    const head = visible[visible.length - 1];
    if (head && now - head.t < 0.1) {
      const off = Math.abs(head.c);
      g.fillStyle = off <= tol ? col.good : off <= tol * 2 ? col.warn : col.bad;
      g.beginPath();
      g.arc(x(head.t), y(head.c), 4.5, 0, Math.PI * 2);
      g.fill();
    }
    this._label(`last ${span}s`, x0, y1 + 5, col.text);
    this._label('now', x1, y1 + 5, col.text, 'right');
  }
}
