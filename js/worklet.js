// Audio-thread tap: forwards the microphone to the main thread in fixed hops,
// so every pitch frame has a sample-exact timestamp (no dropped frames when
// the UI is busy). Optionally decimates very high sample rates.

class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.decim = o.decim || 1;
    this.buf = new Float32Array(o.hop || 512);
    this.n = 0;
    this.acc = 0;
    this.k = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      if (++this.k < this.decim) continue;
      this.buf[this.n++] = this.acc / this.decim;
      this.acc = 0;
      this.k = 0;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf); // structured clone copies it
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pm-capture', Capture);
