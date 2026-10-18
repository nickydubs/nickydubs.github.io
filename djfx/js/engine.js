/* DJFX audio engine: two decks, mixer, FX unit, sampler. Web Audio only.
   Signal: deck src -> trim -> EQ (lo/mid/hi) -> [insert A|B] -> fader -> crossfader -> master sum
           sampler -> master sum -> [insert M] -> master level -> limiter -> out
   The FX unit is patched into exactly one insert (A, B or M). Timing uses the AudioContext clock. */
window.DJ = window.DJ || {};
(function (DJ) {
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // Freeze a param at time t (keeps a running ramp's value instead of jumping), then let the caller schedule.
  function hold(p, t) {
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
    else { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); }
  }
  function glide(p, v, ctx, tc = 0.012) { const t = ctx.currentTime; hold(p, t); p.setTargetAtTime(v, t, tc); }
  function setAt(p, v, t) { hold(p, t); p.setValueAtTime(v, t); }
  DJ.hold = hold; DJ.glide = glide; DJ.setAt = setAt;

  class Insert {
    constructor(ctx) { this.in = ctx.createGain(); this.out = ctx.createGain(); this.in.connect(this.out); }
    attach(fx) { this.in.disconnect(); this.in.connect(fx.in); fx.out.connect(this.out); }
    detach(fx) { this.in.disconnect(); try { fx.out.disconnect(this.out); } catch (e) {} this.in.connect(this.out); }
  }

  function peakOf(an, buf) {
    an.getFloatTimeDomainData(buf); let m = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; }
    return m;
  }

  /* ------------------------------------------------------------------ Deck */
  class Deck {
    constructor(eng, id) {
      const ctx = eng.ctx; this.eng = eng; this.ctx = ctx; this.id = id;
      this.trim = ctx.createGain();
      this.lo = ctx.createBiquadFilter(); this.lo.type = 'lowshelf'; this.lo.frequency.value = 220;
      this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.7;
      this.hi = ctx.createBiquadFilter(); this.hi.type = 'highshelf'; this.hi.frequency.value = 3800;
      this.meter = ctx.createAnalyser(); this.meter.fftSize = 512; this.mbuf = new Float32Array(512);
      this.insert = new Insert(ctx);
      this.fader = ctx.createGain(); this.xf = ctx.createGain();
      this.trim.connect(this.lo); this.lo.connect(this.mid); this.mid.connect(this.hi);
      this.hi.connect(this.meter); this.hi.connect(this.insert.in);
      this.insert.out.connect(this.fader); this.fader.connect(this.xf); this.xf.connect(eng.sum);
      this.buffer = null; this.track = null; this.bpm = 0; this.firstBeat = 0; this.key = null;
      this.rate = 1; this.bend = 1; this.range = 0.08; this.quantize = true;
      this.playing = false; this.src = null; this.srcGain = null;
      this.pausedPos = 0; this.anchorT = 0; this.anchorPos = 0; this.tl = [];
      this.loop = { on: false, start: 0, end: 0, beats: 4 };
      this.cue = 0; this.hot = [null, null, null, null];
      this.keyLock = true; this.bufId = null; this.q1 = 0;
      this.onended = null; this.startedAt = 0;
    }
    get loaded() { return !!this.buffer; }
    get duration() { return this.buffer ? this.buffer.duration : 0; }
    get beatLen() { return this.bpm ? 60 / this.bpm : 0.5; }
    effRate(t = this.ctx.currentTime) { return this.rateAt(t); }
    effBpm(t) { return this.bpm * this.rateAt(t); }

    load(buffer, track, meta) {
      this.stop();
      DJ.dropBuffer && DJ.dropBuffer(this.eng, this.bufId);
      this.bufId = DJ.putBuffer ? DJ.putBuffer(this.eng, buffer) : null;
      this.buffer = buffer; this.track = track;
      this.bpm = meta.bpm || 120; this.firstBeat = meta.firstBeat || 0; this.key = meta.key || null;
      this.cue = meta.cue != null ? meta.cue : this.firstBeat;
      this.hot = (meta.hot || [null, null, null, null]).slice(0, 4);
      this.loop = { on: false, start: 0, end: 0, beats: this.loop.beats };
      this.pausedPos = this.cue; this.rate = 1; this.bend = 1;
    }

    /* -- rate timeline: piecewise-linear playbackRate after anchorT; position = integral of rate -- */
    rateAt(t) {
      const tl = this.tl; if (!tl.length) return this.rate * this.bend;
      if (t <= tl[0].t) return tl[0].r;
      for (let i = 1; i < tl.length; i++) if (t <= tl[i].t) {
        const a = tl[i - 1], b = tl[i]; return a.r + (b.r - a.r) * (t - a.t) / (b.t - a.t || 1);
      }
      return tl[tl.length - 1].r;
    }
    rawPos(t) {
      if (!this.playing) return this.pausedPos;
      const tl = this.tl; let p = this.anchorPos;
      if (t > tl[0].t) {
        let prevT = tl[0].t, prevR = tl[0].r;
        for (let i = 1; i < tl.length && prevT < t; i++) {
          const b = tl[i], end = Math.min(t, b.t), rEnd = prevR + (b.r - prevR) * (end - prevT) / (b.t - prevT || 1);
          p += (prevR + rEnd) / 2 * (end - prevT); prevT = end; prevR = rEnd;
        }
        if (t > prevT) p += prevR * (t - prevT);
      }
      return p;
    }
    pos(t = this.ctx.currentTime) {
      let p = this.rawPos(t); const L = this.loop;
      if (this.playing && L.on && p > L.end) p = L.start + ((p - L.start) % (L.end - L.start));
      return p;
    }
    reanchor(t = this.ctx.currentTime) {
      if (!this.playing) return;
      const p = this.pos(t), r = this.rateAt(t);
      this.anchorPos = p; this.anchorT = t; this.tl = [{ t, r }];
    }
    // Schedule rate points [{t, r}] (absolute ctx times, linear between), starting from the current rate now.
    rampRate(points) {
      const t = Math.max(this.ctx.currentTime, this.anchorT); this.reanchor(t);   // a deck scheduled to start later keeps its start
      if (this.src) { const pr = this.src.playbackRate; hold(pr, t); pr.setValueAtTime(this.rateAt(t), t); }
      for (const p of points) { this.tl.push({ t: p.t, r: p.r }); if (this.src) this.src.playbackRate.linearRampToValueAtTime(p.r, p.t); }
    }
    applyRate() {                         // pitch fader / bend changed: jump to rate*bend now
      const t = this.ctx.currentTime, r = this.rate * this.bend;
      if (!this.playing) return;
      this.reanchor(t); this.tl = [{ t, r }];
      if (this.src) setAt(this.src.playbackRate, r, t);
    }
    setKeyLock(on) { this.keyLock = on; if (this.playing) this.seek(this.pos(this.ctx.currentTime + 0.02), this.ctx.currentTime + 0.02); }
    setPitch(frac) { this.rate = clamp(1 + frac, 1 - this.range, 1 + this.range); this.applyRate(); }
    setTempoBpm(bpm) { if (this.bpm) { this.rate = bpm / this.bpm; this.applyRate(); } }

    /* -- transport -- */
    _startSrc(when, offset) {
      const ctx = this.ctx, g = ctx.createGain(), kl = this.keyLock && this.eng.keyLockReady && this.bufId;
      const s = kl ? new DJ.StretchSource(this.eng, this.bufId) : ctx.createBufferSource();
      if (!kl) s.buffer = this.buffer;
      s.connect(g); g.connect(this.trim);
      const L = this.loop; if (L.on) { s.loop = true; s.loopStart = L.start; s.loopEnd = L.end; }
      s.playbackRate.setValueAtTime(this.rateAt(when), when);
      g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1, when + 0.004);
      s.start(when, clamp(offset, 0, this.buffer.duration - 0.001));
      s.onended = () => { if (this.src === s && this.playing && !s.loop) { this.playing = false; this.pausedPos = this.duration; this.src = null; this.onended && this.onended(this); } };
      return { s, g };
    }
    _stopSrc(when) {
      if (!this.src) return;
      const { src, srcGain } = this; src.onended = null;
      hold(srcGain.gain, when); srcGain.gain.setValueAtTime(srcGain.gain.value, when); srcGain.gain.linearRampToValueAtTime(0, when + 0.004);
      try { src.stop(when + 0.01); } catch (e) {}
      this.src = null; this.srcGain = null;
    }
    play(when = this.ctx.currentTime, at = null) {
      if (!this.buffer) return;
      if (this.playing) this._stopSrc(when);
      const pos = at != null ? at : this.pausedPos;
      this.playing = true; this.anchorT = when; this.anchorPos = pos;
      this.tl = [{ t: when, r: this.rate * this.bend }];
      const { s, g } = this._startSrc(when, pos); this.src = s; this.srcGain = g; this.startedAt = when;
    }
    pause() {
      if (!this.playing) return;
      const t = this.ctx.currentTime; this.pausedPos = this.pos(t); this._stopSrc(t); this.playing = false;
    }
    stop() { this.pause(); }
    toggle() { this.playing ? this.pause() : this.play(); }
    seek(p, when = this.ctx.currentTime) {
      p = clamp(p, 0, Math.max(0, this.duration - 0.01));
      if (this.loop.on && (p < this.loop.start || p >= this.loop.end)) this.loop.on = false;
      if (!this.playing) { this.pausedPos = p; return; }
      const r = this.rateAt(when);
      this._stopSrc(when);
      this.anchorT = when; this.anchorPos = p; this.tl = [{ t: when, r }];
      const { s, g } = this._startSrc(when, p); this.src = s; this.srcGain = g;
    }

    /* -- beat grid -- */
    beatIndex(p = this.pos()) { return (p - this.firstBeat) / this.beatLen; }
    gridPos(p, unit = 1, mode = 'round') {
      const b = (p - this.firstBeat) / (this.beatLen * unit);
      return this.firstBeat + Math[mode](b) * this.beatLen * unit;
    }
    // AudioContext time at which the deck reaches track position target (bisection; handles tempo ramps).
    timeOfPos(target, maxAhead = 600) {
      if (!this.playing) return null;
      const now = Math.max(this.ctx.currentTime, this.anchorT);         // a deck scheduled to start later counts from its start
      const p0 = this.rawPos(now); if (target <= p0) return now;
      let lo = now, hi = now + 1;
      while (this.rawPos(hi) < target && hi - now < maxAhead) hi = now + (hi - now) * 2;
      for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (this.rawPos(m) < target) lo = m; else hi = m; }
      return hi;
    }
    nextDownbeat(minAhead = 0.03) {
      if (!this.playing) return null;
      const now = this.ctx.currentTime;
      if (this.anchorT > now + minAhead) return this.timeOfPos(this.gridPos(this.pos(this.anchorT) - 1e-4, 4, 'ceil'));   // not started yet
      const p = this.pos(now) + minAhead * this.rateAt(now);
      if (this.loop.on) {                                  // inside a loop the bar may wrap: use beat timing directly
        const nb = this.gridPos(p, 4, 'ceil'); if (nb < this.loop.end) return this.timeOfPos(this.rawPos(now) + (nb - this.pos(now)));
        return this.timeOfPos(this.rawPos(now) + (this.loop.end - this.pos(now)));
      }
      return this.timeOfPos(this.gridPos(p, 4, 'ceil'));
    }

    /* -- sync: match the other deck's tempo and bar phase -- */
    syncTo(other) {
      if (!other.loaded || !this.loaded) return;
      const t = this.ctx.currentTime, target = other.effBpm(t);
      let r = target / this.bpm;
      if (r > 1 + this.range || r < 1 - this.range) this.range = r > 1.16 || r < 0.84 ? 0.5 : 0.16;
      this.rate = r / this.bend; this.applyRate();
      if (this.playing && other.playing) {
        const bar = 4, w = t + 0.01, a = other.beatIndex(other.pos(w)), b = this.beatIndex(this.pos(w));   // measure where both will be when the seek lands
        let d = ((a - b) % bar + bar) % bar; if (d > bar / 2) d -= bar;
        if (this.pos(w) + d * this.beatLen < 0) d += bar;              // near the track start: jump a bar forward, not before 0
        this.seek(this.pos(w) + d * this.beatLen, w);
      }
    }

    /* -- loops: native sample-accurate looping -- */
    setLoop(beats) {
      if (!this.loaded) return;
      const t = this.ctx.currentTime; this.reanchor(t);
      const p = this.pos(t), len = beats * this.beatLen, unit = Math.min(len, this.beatLen);
      const start = this.quantize ? this.firstBeat + Math.floor((p - this.firstBeat) / unit) * unit : p;
      this.loop = { on: true, start, end: start + len, beats };
      if (this.src) { this.src.loopStart = start; this.src.loopEnd = start + len; this.src.loop = true; }
    }
    resizeLoop(beats) {
      this.loop.beats = beats;
      if (!this.loop.on) return;
      const t = this.ctx.currentTime; this.reanchor(t);
      const L = this.loop; L.end = L.start + beats * this.beatLen;
      const p = this.pos(t);
      if (p >= L.end) { this.anchorPos = L.start + ((p - L.start) % (L.end - L.start)); }
      if (this.src) this.src.loopEnd = L.end;
      if (this.src && p >= L.end) this.seek(this.anchorPos, t);
    }
    // Kick back into the song: on the loop's next bar line, jump to where the looped bars end and play on
    kickOut() {
      if (!this.loop.on || !this.playing) return null;
      const T = this.nextDownbeat(0.05); if (!T) return null;
      this.seek(this.loop.end, T);
      return T;
    }
    exitLoop() {
      if (!this.loop.on) return;
      const t = this.ctx.currentTime; this.reanchor(t);
      this.loop.on = false; if (this.src) this.src.loop = false;
    }

    /* -- cues -- */
    q(p) { return this.quantize && this.bpm ? this.gridPos(p, 1, 'round') : p; }
    cueDown() {
      if (this.playing) { this.pause(); this.pausedPos = this.cue; return 'back'; }
      const p = this.pos();
      if (Math.abs(p - this.cue) > 0.005) { this.cue = this.q(p); this.pausedPos = this.cue; return 'set'; }
      this.play(); this._cuePreview = true; return 'preview';
    }
    cueUp() { if (this._cuePreview) { this._cuePreview = false; this.pause(); this.pausedPos = this.cue; } }
    hotCue(i, del) {
      if (!this.loaded) return;
      if (del) { this.hot[i] = null; return; }
      if (this.hot[i] == null) { this.hot[i] = this.q(this.pos()); return; }
      if (this.playing) {
        // jump on the beat: keep the current beat phase so the mix doesn't slip
        const t = this.ctx.currentTime;
        if (this.quantize) {
          const nb = this.gridPos(this.pos(t) + 0.02, 1, 'ceil'), when = this.timeOfPos(this.rawPos(t) + (nb - this.pos(t)));
          this.seek(this.hot[i], when);
        } else this.seek(this.hot[i]);
      } else { this.pausedPos = this.hot[i]; this.play(); }
    }

    peak() { return peakOf(this.meter, this.mbuf); }
  }

  /* ------------------------------------------------------------------ FX unit */
  const DIVS = { '1/16': 0.25, '1/8': 0.5, '3/16': 0.75, '1/4': 1, '1/2': 2, '3/4': 3, '1': 4, '2': 8, '4': 16, '8': 32, '16': 64, '32': 128, '64': 256 };   // in beats; '1' = 1 bar
  function impulse(ctx, secs, decay = 3) {
    const n = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
    return b;
  }

  class Fx {
    // One stage: in -> dry -> out, in -> [effect] -> wet -> out. 'send' effects keep dry at 1 and ring out when released.
    constructor(ctx, id, name, kind) {
      this.ctx = ctx; this.id = id; this.name = name; this.kind = kind;   // kind: 'send' | 'replace'
      this.in = ctx.createGain(); this.out = ctx.createGain(); this.dry = ctx.createGain(); this.wet = ctx.createGain(); this.send = ctx.createGain();
      this.in.connect(this.dry); this.dry.connect(this.out); this.wet.connect(this.out);
      this.wet.gain.value = 0; this.send.gain.value = 0; this.on = false; this.armed = false; this.params = {};
    }
    fire(on, when = this.ctx.currentTime) {
      this.on = on; const a = this.params.amount ?? 0.6;
      if (this.kind === 'send') {
        setAt(this.send.gain, on ? 1 : 0, when);
        if (on) { setAt(this.wet.gain, this.wet.gain.value, when); this.wet.gain.linearRampToValueAtTime(a, when + 0.015); }
      } else {
        setAt(this.dry.gain, this.dry.gain.value, when); this.dry.gain.linearRampToValueAtTime(on ? 1 - a : 1, when + 0.015);
        setAt(this.wet.gain, this.wet.gain.value, when); this.wet.gain.linearRampToValueAtTime(on ? a : 0, when + 0.015);
      }
    }
    cut(when) {                           // audio cut at `when`; FxUnit.cutAll flips the on flags at that moment
      setAt(this.send.gain, 0, when); setAt(this.wet.gain, 0, when); setAt(this.dry.gain, 1, when);
      if (this.flush) this.flush(when);
    }
    setAmount(a) {
      this.params.amount = a;
      if (!this.on) return;
      if (this.kind === 'send') glide(this.wet.gain, a, this.ctx);
      else { glide(this.wet.gain, a, this.ctx); glide(this.dry.gain, 1 - a, this.ctx); }
    }
  }

  class FxUnit {
    constructor(eng) {
      const ctx = eng.ctx; this.eng = eng; this.ctx = ctx;
      this.in = ctx.createGain(); this.out = ctx.createGain();
      this.bpm = 128; this.route = null;
      const S = [];

      // Filter: one bipolar knob, left = low-pass, right = high-pass. In line (always passes signal), neutral when off.
      const filt = new Fx(ctx, 'filter', 'Filter', 'line');
      filt.lp = ctx.createBiquadFilter(); filt.lp.type = 'lowpass'; filt.lp.frequency.value = 22000;
      filt.hp = ctx.createBiquadFilter(); filt.hp.type = 'highpass'; filt.hp.frequency.value = 10;
      filt.in.disconnect(); filt.in.connect(filt.lp); filt.lp.connect(filt.hp); filt.hp.connect(filt.out);
      filt.params = { pos: 0.5, res: 0.3, amount: 1 };
      filt.freqs = v => v < 0 ? { lp: 22000 * Math.pow(160 / 22000, -v), hp: 10 } : { lp: 22000, hp: 10 * Math.pow(7000 / 10, v) };
      filt.apply = (when, ramp) => {
        const v = filt.on ? filt.params.pos : 0, f = filt.freqs(v), q = filt.on ? 0.7 + filt.params.res * 14 : 0.7;
        for (const [node, fr] of [[filt.lp, f.lp], [filt.hp, f.hp]]) {
          if (ramp) { hold(node.frequency, when); node.frequency.exponentialRampToValueAtTime(fr, when + ramp); }
          else setAt(node.frequency, fr, when);
          setAt(node.Q, q, when);
        }
      };
      filt.fire = (on, when = ctx.currentTime) => { filt.on = on; filt.apply(when, 0.02); };
      filt.cut = when => { const was = filt.on; filt.on = false; filt.apply(when, 0); filt.on = was; };
      filt.setAmount = () => {};
      S.push(filt);

      // Auto-filter: low-pass swept by a tempo-synced LFO.
      const af = new Fx(ctx, 'autofilter', 'Auto filter', 'replace');
      af.bq = ctx.createBiquadFilter(); af.bq.type = 'lowpass'; af.bq.frequency.value = 1200; af.bq.Q.value = 6;
      af.lfo = ctx.createOscillator(); af.lfo.type = 'sine'; af.depth = ctx.createGain(); af.depth.gain.value = 1000;
      af.lfo.connect(af.depth); af.depth.connect(af.bq.frequency); af.lfo.start();
      af.in.connect(af.bq); af.bq.connect(af.wet); af.params = { amount: 1, div: '8', shape: 'swish' };
      af.sync = bpm => { af.lfo.frequency.value = bpm / 60 / DIVS[af.params.div]; };
      // 'lfo' = wobbling low-pass; 'swish' = one high-pass sweep up that ends on the bar line `div` bars ahead; 'dive' = low-pass sweep down
      const baseFire = af.fire.bind(af);
      af.fire = (on, when = ctx.currentTime) => {
        const shape = af.params.shape || 'lfo';
        if (on && shape !== 'lfo') {
          const grid = this.gridDeck && this.gridDeck(), beats = DIVS[af.params.div] || 4;
          let end = when + beats * 60 / this.bpm;
          if (grid && grid.playing) {                         // land the sweep on the nearest bar line
            const target = grid.pos(when) + beats * grid.beatLen;
            const t = grid.timeOfPos(grid.rawPos(when) + (grid.gridPos(target - grid.beatLen, 4, 'ceil') - grid.pos(when)));   // fired up to a beat late still ends on the intended bar line
            if (t && t > when + 0.2) end = t;
          }
          hold(af.depth.gain, when); af.depth.gain.setValueAtTime(0, when);
          af.bq.type = shape === 'swish' ? 'highpass' : 'lowpass'; setAt(af.bq.Q, shape === 'swish' ? 9 : 7, when);
          const [f0, f1] = shape === 'swish' ? [40, 9000] : [16000, 180];
          // sinusoidal in pitch: eases in and out, so a long sweep (8-64 bars) moves gently and never jumps
          const n = 256, curve = new Float32Array(n);
          for (let i = 0; i < n; i++) curve[i] = f0 * Math.pow(f1 / f0, (1 - Math.cos(Math.PI * i / (n - 1))) / 2);
          setAt(af.bq.frequency, f0, when); af.bq.frequency.setValueCurveAtTime(curve, when + 0.001, Math.max(0.05, end - when - 0.001));
          af.sweepEnd = end;
        } else if (on) { af.bq.type = 'lowpass'; setAt(af.depth.gain, 1000, when); setAt(af.bq.frequency, 1200, when); setAt(af.bq.Q, 6, when); }
        baseFire(on, when);
      };
      S.push(af);

      // Flanger: short modulated delay with feedback.
      const fl = new Fx(ctx, 'flanger', 'Flanger', 'send');
      fl.dl = ctx.createDelay(0.05); fl.dl.delayTime.value = 0.004; fl.fb = ctx.createGain(); fl.fb.gain.value = 0.65;
      fl.lfo = ctx.createOscillator(); fl.lfo.type = 'triangle'; fl.depth = ctx.createGain(); fl.depth.gain.value = 0.0032;
      fl.lfo.connect(fl.depth); fl.depth.connect(fl.dl.delayTime); fl.lfo.start();
      fl.in.connect(fl.send); fl.send.connect(fl.dl); fl.dl.connect(fl.fb); fl.fb.connect(fl.dl); fl.dl.connect(fl.wet);
      fl.params = { amount: 0.7, div: '2' };
      fl.sync = bpm => { fl.lfo.frequency.value = bpm / 60 / DIVS[fl.params.div] / 4; };
      fl.flush = when => { setAt(fl.fb.gain, 0, when); fl.fb.gain.setValueAtTime(0.65, when + 0.06); };
      S.push(fl);

      // Crush: bit reduction.
      const cr = new Fx(ctx, 'crush', 'Crush', 'replace');
      cr.ws = ctx.createWaveShaper(); cr.params = { amount: 1, bits: 5 };
      cr.setBits = b => { const n = 4096, c = new Float32Array(n), st = Math.pow(2, b - 1); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.round(x * st) / st; } cr.ws.curve = c; };
      cr.setBits(5); cr.in.connect(cr.ws); cr.ws.connect(cr.wet);
      S.push(cr);

      // Trans: tempo-synced volume chop.
      const tr = new Fx(ctx, 'trans', 'Trans', 'replace');
      tr.vca = ctx.createGain(); tr.vca.gain.value = 0.5; tr.lfo = ctx.createOscillator(); tr.lfo.type = 'square';
      tr.depth = ctx.createGain(); tr.depth.gain.value = 0.5; tr.lfo.connect(tr.depth); tr.depth.connect(tr.vca.gain); tr.lfo.start();
      tr.in.connect(tr.vca); tr.vca.connect(tr.wet); tr.params = { amount: 1, div: '1/8' };
      tr.sync = bpm => { tr.lfo.frequency.value = bpm / 60 / DIVS[tr.params.div]; };
      S.push(tr);

      // Echo: tempo-synced delay with filtered feedback (dub style). Releasing it lets the tail ring out.
      const ec = new Fx(ctx, 'echo', 'Echo', 'send');
      ec.dl = ctx.createDelay(4); ec.fb = ctx.createGain(); ec.fb.gain.value = 0.55;
      ec.hp = ctx.createBiquadFilter(); ec.hp.type = 'highpass'; ec.hp.frequency.value = 250;
      ec.lp = ctx.createBiquadFilter(); ec.lp.type = 'lowpass'; ec.lp.frequency.value = 6000;
      ec.in.connect(ec.send); ec.send.connect(ec.dl); ec.dl.connect(ec.hp); ec.hp.connect(ec.lp); ec.lp.connect(ec.fb); ec.fb.connect(ec.dl);
      ec.lp.connect(ec.wet); ec.params = { amount: 0.6, div: '3/4', feedback: 0.55 };
      ec.sync = bpm => { glide(ec.dl.delayTime, Math.min(3.9, 60 / bpm * DIVS[ec.params.div]), ctx, 0.05); };
      ec.flush = when => { setAt(ec.fb.gain, 0, when); ec.fb.gain.setValueAtTime(ec.params.feedback, when + 0.08); };
      S.push(ec);

      // Reverb: generated impulse response.
      const rv = new Fx(ctx, 'reverb', 'Reverb', 'send');
      rv.cv = ctx.createConvolver(); rv.params = { amount: 0.5, size: 3 }; rv.cv.buffer = impulse(ctx, 3);
      rv.in.connect(rv.send); rv.send.connect(rv.cv); rv.cv.connect(rv.wet);
      rv.setSize = s => { rv.params.size = s; rv.cv.buffer = impulse(ctx, s); };
      S.push(rv);

      // Noise riser: white noise through a sweepable high-pass, added on top.
      const nz = new Fx(ctx, 'noise', 'Noise', 'send');
      const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      nz.src = ctx.createBufferSource(); nz.src.buffer = nb; nz.src.loop = true; nz.src.start();
      nz.hp = ctx.createBiquadFilter(); nz.hp.type = 'highpass'; nz.hp.frequency.value = 800; nz.hp.Q.value = 4;
      nz.src.connect(nz.hp); nz.hp.connect(nz.send); nz.send.connect(nz.wet); nz.params = { amount: 0.25, tone: 0.3 };
      nz.setTone = v => { nz.params.tone = v; glide(nz.hp.frequency, 200 * Math.pow(60, v), ctx, 0.03); };
      nz.wet.gain.value = 0;
      S.push(nz);

      // chain: filter -> autofilter -> flanger -> crush -> trans -> echo -> reverb -> (+noise) -> out
      let prev = this.in;
      for (const s of S) { prev.connect(s.in); prev = s.out; }
      prev.connect(this.out);
      this.stages = S; this.by = Object.fromEntries(S.map(s => [s.id, s]));
      this.setBpm(128);
    }
    setBpm(bpm) { if (!bpm || !isFinite(bpm)) return; this.bpm = bpm; for (const s of this.stages) s.sync && s.sync(bpm); }
    setRoute(r) {
      const target = r && this.eng.inserts[r];
      if (this.route) this.eng.inserts[this.route].detach(this);
      this.route = null;
      if (target) { target.attach(this); this.route = r; }
    }
    fire(id, on, when) { const s = this.by[id]; s.fire(on, when); }
    fireAll(when) { for (const s of this.stages) if (s.armed) s.fire(true, when); }
    cutAll(when = this.ctx.currentTime) {
      for (const s of this.stages) s.cut(when);
      clearTimeout(this._cutTimer);
      this._cutTimer = setTimeout(() => { for (const s of this.stages) s.on = false; this.oncut && this.oncut(); }, Math.max(0, (when - this.ctx.currentTime) * 1000));
    }
  }

  /* ------------------------------------------------------------------ Sampler */
  function synth(ctx, secs, fn) {
    const n = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0), sr = ctx.sampleRate;
    let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / sr; const r = fn(t, ph); d[i] = r.v; ph = r.ph ?? ph; }
    let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(d[i])); if (m) for (let i = 0; i < n; i++) d[i] *= 0.9 / m;
    return b;
  }
  function defaultPads(ctx) {
    const sr = ctx.sampleRate, nz = () => Math.random() * 2 - 1, saw = p => 2 * (p % 1) - 1;
    const osc = (f, ph) => ph + f / sr;
    return [
      { name: 'Air horn', buf: synth(ctx, 1.4, (t, ph) => { const f = 466 * (1 + 0.03 * Math.min(1, t * 20)); ph = osc(f, ph);
        const v = (saw(ph) + 0.7 * saw(ph * 1.26) + 0.5 * saw(ph * 1.5)) * Math.min(1, t * 40) * (t < 1.2 ? 1 : (1.4 - t) * 5) * (1 + 0.3 * Math.sin(2 * Math.PI * 30 * t)); return { v, ph }; }) },
      { name: 'Siren', buf: synth(ctx, 2.0, (t, ph) => { const f = 700 + 500 * Math.sin(2 * Math.PI * 2.5 * t); ph = osc(f, ph); return { v: Math.sign(Math.sin(2 * Math.PI * ph)) * 0.6 * Math.min(1, t * 30) * Math.min(1, (2 - t) * 4), ph }; }) },
      { name: 'Laser', buf: synth(ctx, 0.35, (t, ph) => { const f = 2400 * Math.exp(-t * 14) + 120; ph = osc(f, ph); return { v: saw(ph) * Math.exp(-t * 6), ph }; }) },
      { name: 'Riser', buf: synth(ctx, 4.0, (t, ph) => { const f = 150 * Math.pow(2, t * 1.6); ph = osc(f, ph); return { v: (0.5 * nz() * (t / 4) + 0.5 * saw(ph)) * (t / 4) * (t < 3.95 ? 1 : 0), ph }; }) },
      { name: 'Kick', buf: synth(ctx, 0.45, (t, ph) => { const f = 48 + 120 * Math.exp(-t * 28); ph = osc(f, ph); return { v: Math.sin(2 * Math.PI * ph) * Math.exp(-t * 6.5), ph }; }) },
      { name: 'Snare', buf: synth(ctx, 0.3, (t, ph) => { ph = osc(185, ph); return { v: (0.7 * nz() * Math.exp(-t * 18) + 0.5 * Math.sin(2 * Math.PI * ph) * Math.exp(-t * 25)), ph }; }) },
      { name: 'Clap', buf: synth(ctx, 0.35, t => { const e = [0, 0.011, 0.022].reduce((s, o) => s + (t >= o ? Math.exp(-(t - o) * 90) : 0), 0) + 0.6 * Math.exp(-Math.max(0, t - 0.03) * 14); return { v: nz() * e }; }) },
      { name: 'Sub drop', buf: synth(ctx, 2.2, (t, ph) => { const f = 70 * Math.exp(-t * 0.6) + 25; ph = osc(f, ph); return { v: Math.sin(2 * Math.PI * ph) * Math.min(1, t * 50) * Math.exp(-t * 1.1), ph }; }) },
    ];
  }
  class Sampler {
    constructor(eng) {
      this.ctx = eng.ctx; this.out = eng.ctx.createGain(); this.out.gain.value = 0.8; this.out.connect(eng.sum);
      this.pads = defaultPads(eng.ctx); this.voices = [];
    }
    hit(i) {
      const p = this.pads[i]; if (!p || !p.buf) return;
      const v = this.voices[i]; if (v) { try { v.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.004); v.s.stop(this.ctx.currentTime + 0.03); } catch (e) {} }
      const s = this.ctx.createBufferSource(), g = this.ctx.createGain(); s.buffer = p.buf; s.connect(g); g.connect(this.out);
      s.start(); this.voices[i] = { s, g }; s.onended = () => { if (this.voices[i] && this.voices[i].s === s) this.voices[i] = null; };
    }
    async loadPad(i, file) {
      const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
      this.pads[i] = { name: file.name.replace(/\.[^.]+$/, '').slice(0, 14), buf, user: true };
    }
  }

  /* ------------------------------------------------------------------ Engine */
  class Engine {
    constructor() {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.sum = ctx.createGain();
      this.inserts = { M: new Insert(ctx) };
      this.master = ctx.createGain(); this.master.gain.value = 0.9;
      this.preMeter = ctx.createAnalyser(); this.preMeter.fftSize = 512; this.pbuf = new Float32Array(512);
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1.5; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
      this.post = ctx.createAnalyser(); this.post.fftSize = 512; this.qbuf = new Float32Array(512);
      this.sum.connect(this.inserts.M.in); this.inserts.M.out.connect(this.master);
      this.master.connect(this.preMeter); this.master.connect(this.limiter); this.limiter.connect(this.post); this.post.connect(ctx.destination);
      this.decks = { A: new Deck(this, 'A'), B: new Deck(this, 'B') };
      this.inserts.A = this.decks.A.insert; this.inserts.B = this.decks.B.insert;
      this.fx = new FxUnit(this);
      this.sampler = new Sampler(this);
      this.xfPos = 0.5; this.xfCurve = 'smooth';
      this.keyLockReady = false;
      this.klReady = DJ.initKeyLock ? DJ.initKeyLock(this).catch(e => { console.warn('key lock unavailable', e); return false; }) : Promise.resolve(false);
      this.setXfader(0.5);
    }
    xfGains(x, curve = this.xfCurve) {
      if (curve === 'cut') { const e = 0.06; return { A: x > 1 - e ? (1 - x) / e : 1, B: x < e ? x / e : 1 }; }
      if (curve === 'linear') return { A: Math.min(1, 2 * (1 - x)), B: Math.min(1, 2 * x) };
      return { A: Math.cos(x * Math.PI / 2), B: Math.sin(x * Math.PI / 2) };
    }
    setXfader(x, when = null) {
      this.xfPos = clamp(x, 0, 1); const g = this.xfGains(this.xfPos);
      if (when == null) { glide(this.decks.A.xf.gain, g.A, this.ctx, 0.005); glide(this.decks.B.xf.gain, g.B, this.ctx, 0.005); }
      else { setAt(this.decks.A.xf.gain, g.A, when); setAt(this.decks.B.xf.gain, g.B, when); }
    }
    // Move the crossfader from its current spot to x between t0 and t1 (scheduled, curve-correct).
    xfRamp(x0, x1, t0, t1, steps = 32) {
      const A = this.decks.A.xf.gain, B = this.decks.B.xf.gain; hold(A, t0); hold(B, t0);
      for (let i = 0; i <= steps; i++) {
        const t = t0 + (t1 - t0) * i / steps, g = this.xfGains(x0 + (x1 - x0) * i / steps);
        if (i === 0) { A.setValueAtTime(g.A, t); B.setValueAtTime(g.B, t); } else { A.linearRampToValueAtTime(g.A, t); B.linearRampToValueAtTime(g.B, t); }
      }
    }
    masterPeak() { return peakOf(this.preMeter, this.pbuf); }
    outPeak() { return peakOf(this.post, this.qbuf); }
    resume() { if (this.ctx.state !== 'running') return this.ctx.resume(); }
  }

  DJ.Engine = Engine; DJ.DIVS = DIVS;
})(window.DJ);
