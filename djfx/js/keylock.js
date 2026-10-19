/* DJFX key lock: tempo changes without pitch changes (WSOLA time-stretch in an AudioWorklet).
   StretchSource mimics the parts of AudioBufferSourceNode the deck uses (playbackRate, loop*, start, stop, onended),
   so the deck's position maths stays exact: the stretcher reads the track at `rate` samples per output sample.
   At rate 1 the 50%-overlap Hann frames add back to the original signal exactly. */
function DJStretchWorklet() {
  const BUFS = globalThis.__djfxBufs || (globalThis.__djfxBufs = new Map());

  class Loader extends AudioWorkletProcessor {
    constructor() {
      super();
      this.port.onmessage = e => { const d = e.data; if (d.cmd === 'put') BUFS.set(d.id, { ch: d.ch, dm: d.dm }); else if (d.cmd === 'del') BUFS.delete(d.id); };
    }
    process() { return true; }
  }
  registerProcessor('djfx-loader', Loader);

  class Stretch extends AudioWorkletProcessor {
    static get parameterDescriptors() { return [{ name: 'rate', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'a-rate' }]; }
    constructor(opts) {
      super();
      const b = BUFS.get(opts.processorOptions.id) || { ch: [new Float32Array(1)], dm: new Float32Array(1) };
      this.ch = b.ch; this.dm = b.dm; this.len = this.ch[0].length;
      const N = sampleRate > 60000 ? 4096 : 2048;                 // ~43-46 ms frames, and a search of +-12 ms (one 40 Hz cycle is 25 ms),
      this.N = N; this.Hs = N / 2; this.D = Math.round(sampleRate * 0.012);   // so subs keep their pitch, not just mids and highs
      this.win = new Float32Array(N); for (let k = 0; k < N; k++) this.win[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / N);
      this.acc = [new Float32Array(N), new Float32Array(N)];
      this.q = [new Float32Array(N), new Float32Array(N)]; this.qn = 0; this.qr = 0;   // output queue + read index
      this.pos = 0; this.prev = -1; this.startF = Infinity; this.stopF = Infinity;
      this.loopOn = false; this.ls = 0; this.le = 0; this.ended = false; this.inputDone = false;
      this.port.onmessage = e => {
        const d = e.data;
        if (d.cmd === 'start') { this.startF = Math.round(d.when * sampleRate); this.pos = d.offset * sampleRate; }
        else if (d.cmd === 'stop') this.stopF = Math.round(d.when * sampleRate);
        else if (d.cmd === 'loop') { this.loopOn = d.on; this.ls = Math.round(d.s * sampleRate); this.le = Math.round(d.e * sampleRate); }
      };
    }
    read(c, i) {
      if (this.loopOn && this.le > this.ls && i >= this.le) i = this.ls + ((i - this.ls) % (this.le - this.ls));
      const ch = this.ch[c < this.ch.length ? c : 0];
      return i >= 0 && i < this.len ? ch[i] : 0;
    }
    mono(i) { return this.read(0, i) + (this.ch.length > 1 ? this.read(1, i) : 0); }
    rdm(j) {                                  // the quarter-rate mono copy, with the loop wrap (slow path only)
      if (this.loopOn && this.le > this.ls) { const a = this.ls >> 2, b = this.le >> 2; if (j >= b && b > a) j = a + ((j - a) % (b - a)); }
      return j >= 0 && j < this.dm.length ? this.dm[j] : 0;
    }
    // Plain index ranges [lo, hi) can be read straight from the arrays: inside the track and not across the loop end
    flat(lo, hi) { return lo >= 0 && hi <= this.len && !(this.loopOn && this.le > this.ls && hi > this.le); }
    hop(rate) {
      const N = this.N, Hs = this.Hs, D = this.D;
      let t = Math.round(this.pos), best = 0;
      if (this.prev >= 0 && Math.abs(rate - 1) > 1e-4) {
        // WSOLA: pick the offset whose start best continues what the previous frame would have played next.
        // Coarse search on the quarter-rate mono copy (every candidate, every other sample), then refine at full rate.
        const nat = this.prev + Hs, dm = this.dm, n4 = nat >> 2, t4 = t >> 2, D4 = D >> 2, L4 = Hs >> 2;
        let bestC = -Infinity, b4 = 0;
        if (this.flat(Math.min(nat, t - D), Math.max(nat, t + D) + Hs + 8)) {
          for (let d = -D4; d <= D4; d++) {
            let c = 0; const o = t4 + d;
            for (let k = 0; k < L4; k += 2) c += dm[n4 + k] * dm[o + k];
            if (c > bestC) { bestC = c; b4 = d; }
          }
        } else {
          for (let d = -D4; d <= D4; d++) {
            let c = 0;
            for (let k = 0; k < L4; k += 2) c += this.rdm(n4 + k) * this.rdm(t4 + d + k);
            if (c > bestC) { bestC = c; b4 = d; }
          }
        }
        bestC = -Infinity;
        const L = this.ch[0], R = this.ch[this.ch.length > 1 ? 1 : 0], ff = this.flat(Math.min(nat, t + b4 * 4 - 3), Math.max(nat, t + b4 * 4 + 3) + Hs);
        for (let d = b4 * 4 - 3; d <= b4 * 4 + 3; d++) {
          if (d < -D || d > D) continue;
          let c = 0; const o = t + d;
          if (ff) for (let k = 0; k < Hs; k += 4) c += (L[nat + k] + R[nat + k]) * (L[o + k] + R[o + k]);
          else for (let k = 0; k < Hs; k += 4) c += this.mono(nat + k) * this.mono(o + k);
          if (c > bestC) { bestC = c; best = d; }
        }
      }
      const src = t + best, w = this.win, fast = this.flat(src, src + N);
      for (let c = 0; c < 2; c++) {
        const a = this.acc[c], ch = this.ch[c < this.ch.length ? c : 0];
        if (fast) for (let k = 0; k < N; k++) a[k] += ch[src + k] * w[k];
        else for (let k = 0; k < N; k++) a[k] += this.read(c, src + k) * w[k];
        const q = this.q[c]; q.set(a.subarray(0, Hs), this.qn);
        a.copyWithin(0, Hs); a.fill(0, N - Hs);
      }
      this.qn += Hs; this.prev = src; this.pos += Hs * rate;
      if (this.loopOn && this.le > this.ls && this.pos >= this.le) { const L = this.le - this.ls; this.pos -= L; this.prev -= L; }
      if (!this.loopOn && this.pos >= this.len + N) this.inputDone = true;
    }
    process(inputs, outputs, params) {
      const out = outputs[0], n = out[0].length, rate = params.rate, f0 = currentFrame;
      for (let i = 0; i < n; i++) {
        const f = f0 + i;
        if (f < this.startF) { out[0][i] = 0; if (out[1]) out[1][i] = 0; continue; }
        if (f >= this.stopF || (this.inputDone && this.qr >= this.qn)) {
          for (let j = i; j < n; j++) { out[0][j] = 0; if (out[1]) out[1][j] = 0; }
          if (!this.ended) { this.ended = true; if (f < this.stopF) this.port.postMessage('ended'); }
          return false;
        }
        if (this.qr >= this.qn) { this.qr = 0; this.qn = 0; this.hop(rate.length > 1 ? rate[i] : rate[0]); }
        out[0][i] = this.q[0][this.qr]; if (out[1]) out[1][i] = this.q[1][this.qr]; this.qr++;
      }
      return true;
    }
  }
  registerProcessor('djfx-stretch', Stretch);
}

window.DJ = window.DJ || {};
(function (DJ) {
  let nextId = 0;
  // Load the worklet (from a Blob, so it also works when index.html is opened straight from disk).
  DJ.initKeyLock = async function (eng) {
    const ctx = eng.ctx;
    if (!ctx.audioWorklet) return false;
    const src = '(' + DJStretchWorklet.toString() + ')();';
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    eng.loader = new AudioWorkletNode(ctx, 'djfx-loader', { numberOfInputs: 0, numberOfOutputs: 1 });
    eng.keyLockReady = true;
    return true;
  };
  DJ.putBuffer = function (eng, buffer) {
    if (!eng.keyLockReady) return null;
    const id = 'b' + (++nextId), ch = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) ch.push(buffer.getChannelData(c).slice());
    // a quarter-rate mono copy for the stretcher's offset search (16x less work than searching the full signal)
    const n = ch[0].length >> 2, dm = new Float32Array(n), k = 1 / (4 * ch.length);
    for (const x of ch) for (let i = 0, j = 0; i < n; i++, j += 4) dm[i] += (x[j] + x[j + 1] + x[j + 2] + x[j + 3]) * k;
    eng.loader.port.postMessage({ cmd: 'put', id, ch, dm }, [...ch.map(a => a.buffer), dm.buffer]);
    return id;
  };
  DJ.dropBuffer = function (eng, id) { if (id && eng.loader) eng.loader.port.postMessage({ cmd: 'del', id }); };

  class StretchSource {
    constructor(eng, id) {
      this.node = new AudioWorkletNode(eng.ctx, 'djfx-stretch', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { id } });
      this.playbackRate = this.node.parameters.get('rate');
      this._loop = false; this._ls = 0; this._le = 0; this.onended = null;
      this.node.port.onmessage = e => { if (e.data === 'ended' && this.onended) this.onended(); };
    }
    connect(d) { this.node.connect(d); }
    disconnect() { this.node.disconnect(); }
    _send() { this.node.port.postMessage({ cmd: 'loop', on: this._loop, s: this._ls, e: this._le }); }
    get loop() { return this._loop; } set loop(v) { this._loop = v; this._send(); }
    get loopStart() { return this._ls; } set loopStart(v) { this._ls = v; this._send(); }
    get loopEnd() { return this._le; } set loopEnd(v) { this._le = v; this._send(); }
    start(when, offset) { this.node.port.postMessage({ cmd: 'start', when, offset }); }
    stop(when) { this.node.port.postMessage({ cmd: 'stop', when }); }
  }
  DJ.StretchSource = StretchSource;
})(window.DJ);
