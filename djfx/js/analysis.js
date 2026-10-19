/* DJFX track analysis: tempo, beat grid (first downbeat), musical key and waveform peaks.
   Pure functions on a mono 11025 Hz signal. Runs inside a Web Worker built from this function's source
   (DJ.analyzer), with a main-thread fallback. Key detection is our own chroma + key-profile match,
   shown on the plain circle of fifths (no third-party key notation). */
function DJAnalysisCore() {
  const SR = 11025, HOP = 128, FR = SR / HOP;          // onset frames per second (~86)
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // Per-hop energies in a kick band (<150 Hz) and the rest, their onset curves, and waveform peaks.
  function envelopes(x) {
    const n = Math.floor(x.length / HOP);
    const eLow = new Float32Array(n), eHigh = new Float32Array(n), eAll = new Float32Array(n), peak = new Float32Array(n), peakLow = new Float32Array(n);
    const aL = Math.exp(-2 * Math.PI * 150 / SR), aH = Math.exp(-2 * Math.PI * 1200 / SR);
    let lp = 0, lp2 = 0, mid = 0;
    for (let f = 0; f < n; f++) {
      let sl = 0, sh = 0, sa = 0, pk = 0, pl = 0;
      for (let i = f * HOP, e = i + HOP; i < e; i++) {
        const s = x[i];
        lp = aL * lp + (1 - aL) * s; lp2 = aL * lp2 + (1 - aL) * lp;     // 2-pole lowpass: kick + bass
        mid = aH * mid + (1 - aH) * s; const hp = s - mid;                // highpass: hats, snares, claps
        sl += lp2 * lp2; sh += hp * hp; sa += s * s;
        const a = s < 0 ? -s : s; if (a > pk) pk = a;
        const b = lp2 < 0 ? -lp2 : lp2; if (b > pl) pl = b;
      }
      eLow[f] = sl; eHigh[f] = sh; eAll[f] = sa; peak[f] = pk; peakLow[f] = pl;
    }
    const flux = e => {
      const o = new Float32Array(n); let prev = 0;
      for (let f = 0; f < n; f++) { const v = Math.log(1 + 1000 * e[f]); o[f] = Math.max(0, v - prev); prev = v; }
      let m = 0; for (let f = 0; f < n; f++) m = Math.max(m, o[f]); if (m > 0) for (let f = 0; f < n; f++) o[f] /= m;
      return o;
    };
    const oLow = flux(eLow), oHigh = flux(eHigh), env = new Float32Array(n);
    for (let f = 0; f < n; f++) env[f] = oLow[f] + 0.6 * oHigh[f];
    return { env, oLow, peak, peakLow, eLow, eAll };
  }

  const at = (a, p) => { const i = Math.floor(p), t = p - i; return i + 1 < a.length ? a[i] * (1 - t) + a[i + 1] * t : 0; };

  // Best phase (in frames) and its strength for a beat period, sampling the onset curve on the grid.
  function comb(env, period) {
    const steps = Math.max(8, Math.round(period * 2));
    let best = -1, bestPh = 0;
    for (let s = 0; s < steps; s++) {
      const ph = s * period / steps; let sum = 0, k = 0;
      for (let p = ph; p < env.length - 1; p += period) { sum += at(env, p); k++; }
      if (k && sum / k > best) { best = sum / k; bestPh = ph; }
    }
    return { phase: bestPh, score: best };
  }

  function tempo(env) {
    // autocorrelation over the busiest 3 minutes, scored with octave-error checks and a dance-music prior
    const len = Math.min(env.length, Math.round(180 * FR)), start = Math.max(0, Math.floor((env.length - len) / 2));
    const e = env.subarray(start, start + len);
    let mean = 0; for (let i = 0; i < e.length; i++) mean += e[i]; mean /= e.length;
    const acf = lag => { let s = 0; const L = Math.floor(lag), t = lag - L;
      for (let i = 0; i + L + 1 < e.length; i++) s += (e[i] - mean) * ((e[i + L] - mean) * (1 - t) + (e[i + L + 1] - mean) * t);
      return s / (e.length - lag); };
    let best = null;
    for (let bpm = 60; bpm <= 200; bpm += 0.5) {
      const lag = FR * 60 / bpm;
      let sc = acf(lag) + 0.5 * acf(2 * lag) + 0.25 * acf(4 * lag);
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 135) / 0.55, 2));
      sc = sc * (0.35 + 0.65 * prior);
      if (!best || sc > best.sc) best = { bpm, sc };
    }
    let b = best.bpm;
    if (b < 95) b *= 2; else if (b > 190) b /= 2;
    // refine on the full track with the comb (precise period matters: 0.01 BPM is 0.02 beats over 5 minutes)
    let fine = { bpm: b, score: -1, phase: 0 };
    for (let x = b - 1.6; x <= b + 1.6; x += 0.02) {
      const c = comb(env, FR * 60 / x);
      if (c.score > fine.score) fine = { bpm: x, score: c.score, phase: c.phase };
    }
    let bpm = fine.bpm;
    const r = Math.round(bpm), h = Math.round(bpm * 2) / 2;
    if (Math.abs(bpm - r) < 0.08) bpm = r; else if (Math.abs(bpm - h) < 0.05) bpm = h; else bpm = Math.round(bpm * 100) / 100;
    return bpm;
  }

  function grid(env, oLow, bpm) {
    const period = FR * 60 / bpm, c = comb(env, period);
    // Refine the phase on the kick band: swung or busy hats can pull the all-band phase a 16th off the real beat.
    const at1 = (a, ph) => { let s = 0, k = 0; for (let p = ph; p < a.length - 1; p += period) { s += at(a, p); k++; } return k ? s / k : 0; };
    let bestPh = c.phase, bestPS = -1;
    for (let d = -4; d <= 4; d++) {
      const ph = ((c.phase + d * period / 16) % period + period) % period, sc = at1(oLow, ph) + 0.3 * at1(env, ph) - 0.02 * Math.abs(d);
      if (sc > bestPS) { bestPS = sc; bestPh = ph; }
    }
    c.phase = bestPh;
    const beat = 60 / bpm;
    // which of the 4 beats starts the bar: the one with the strongest kick-band onsets
    let bestJ = 0, bestS = -1;
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let p = c.phase + j * period; p < oLow.length - 1; p += 4 * period) s += at(oLow, p);
      if (s > bestS) { bestS = s; bestJ = j; }
    }
    let t = (c.phase + bestJ * period) / FR;
    t = ((t % (4 * beat)) + 4 * beat) % (4 * beat);                    // earliest downbeat at or after 0
    return Math.round(t * 1000) / 1000;
  }

  function key(x) {
    const N = 4096, re = new Float64Array(N), im = new Float64Array(N), chroma = new Float64Array(12);
    const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const kLo = Math.ceil(55 * N / SR), kHi = Math.floor(2000 * N / SR), pcOf = new Int8Array(kHi + 1);
    for (let k = kLo; k <= kHi; k++) pcOf[k] = ((Math.round(69 + 12 * Math.log2(k * SR / N / 440)) % 12) + 12) % 12;
    for (let s = 0; s + N <= x.length; s += N) {
      for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
      fft(re, im);
      const fr = new Float64Array(12); let tot = 0;
      for (let k = kLo; k <= kHi; k++) { const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]); fr[pcOf[k]] += m; tot += m; }
      if (tot > 1e-6) for (let p = 0; p < 12; p++) chroma[p] += fr[p] / tot;   // each frame votes equally
    }
    const corr = (prof, t) => {
      let mx = 0, my = 0; for (let i = 0; i < 12; i++) { mx += chroma[i]; my += prof[i]; } mx /= 12; my /= 12;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < 12; i++) { const a = chroma[i] - mx, b = prof[(i - t + 12) % 12] - my; sxy += a * b; sxx += a * a; syy += b * b; }
      return sxy / Math.sqrt(sxx * syy || 1);
    };
    const all = [];
    for (let t = 0; t < 12; t++) { all.push({ tonic: t, minor: false, r: corr(MAJ, t) }); all.push({ tonic: t, minor: true, r: corr(MIN, t) }); }
    all.sort((a, b) => b.r - a.r);
    const k = all[0];
    // circle-of-fifths position (0-11), minor keys sit on their relative major's spot
    const majTonic = k.minor ? (k.tonic + 3) % 12 : k.tonic;
    return { tonic: k.tonic, minor: k.minor, name: NAMES[k.tonic] + (k.minor ? 'm' : ''), fifth: (majTonic * 7) % 12,
             confidence: Math.round((k.r - all[1].r) * 100) / 100 };
  }

  function analyze(x) {
    const { env, oLow, peak, peakLow, eLow, eAll } = envelopes(x);
    const bpm = tempo(env), firstBeat = grid(env, oLow, bpm);
    // Q1 = the first downbeat of the music: the first grid bar line at (or just before) the first clearly audible sound
    let mx = 0; for (let i = 0; i < peak.length; i++) if (peak[i] > mx) mx = peak[i];
    let s = 0; while (s < peak.length && peak[s] < 0.08 * mx) s++;
    const bar = 4 * 60 / bpm, ts = s / FR;
    const q1 = Math.max(firstBeat, firstBeat + Math.ceil((ts - 0.08 - firstBeat) / bar) * bar);
    return { bpm, firstBeat, q1: Math.round(q1 * 1000) / 1000, key: key(x), peaks: peak, peaksLow: peakLow, lowE: eLow, allE: eAll, peakRate: FR, duration: x.length / SR };
  }
  return { analyze, SR, NAMES };
}

window.DJ = window.DJ || {};
(function (DJ) {
  const core = DJAnalysisCore();
  DJ.ANALYSIS_SR = core.SR;
  DJ.KEY_NAMES = core.NAMES;
  let worker = null, seq = 0;
  const pending = new Map();
  try {
    const src = 'const core=(' + DJAnalysisCore.toString() + ')();onmessage=e=>{const r=core.analyze(e.data.x);' +
      'postMessage({id:e.data.id,r},[r.peaks.buffer,r.peaksLow.buffer,r.lowE.buffer,r.allE.buffer]);};';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = e => { const p = pending.get(e.data.id); pending.delete(e.data.id); p && p(e.data.r); };
  } catch (e) { worker = null; }

  // Mix an AudioBuffer to mono and decimate to 11025 Hz (box filter: plenty for tempo, key and drawing).
  DJ.downmix = function (buf) {
    const f = buf.sampleRate / core.SR, n = Math.floor(buf.length / f), out = new Float32Array(n);
    const chs = []; for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    const w = Math.max(1, Math.round(f)), g = 1 / (w * chs.length);
    for (let i = 0; i < n; i++) {
      const s0 = Math.floor(i * f); let s = 0;
      for (const ch of chs) for (let j = 0; j < w && s0 + j < ch.length; j++) s += ch[s0 + j];
      out[i] = s * g;
    }
    return out;
  };

  DJ.analyze = function (buf) {
    const x = DJ.downmix(buf);
    if (!worker) return Promise.resolve(core.analyze(x));
    return new Promise(res => { const id = ++seq; pending.set(id, res); worker.postMessage({ id, x }, [x.buffer]); });
  };

  // Harmonic distance on the circle of fifths: 0 same key, 1 neighbour or relative major/minor, 2+ further.
  DJ.keyDistance = function (a, b) {
    if (!a || !b) return 3;
    const d = Math.min((a.fifth - b.fifth + 12) % 12, (b.fifth - a.fifth + 12) % 12);
    if (d === 0) return a.minor === b.minor ? 0 : 1;
    return d + (a.minor === b.minor ? 0 : 1);
  };
  DJ.keyLabel = k => k ? k.name + ' · ' + (k.fifth + 1) + (k.minor ? 'm' : 'M') : '—';

  // Phrases and cue points, from the analysis energies and the (possibly hand-edited) grid.
  // Dance music moves in 32-bar phrases counted from the first downbeat: the drop, the breakdown and the outro start on
  // those lines. Per 8-bar block we measure the bass energy (kick + bass) and the full-band energy, label the block,
  // then pick: where the next track should start (mix-in: 32 bars before its first drop, or its first downbeat),
  // its first drop, and where to start mixing out (when the last drop is over, leaving room for a 32-bar blend).
  DJ.CUES_V = 2;
  DJ.cues = function (r, m, dur) {
    if (!r || !r.lowE || !m || !m.bpm) return null;
    const FR = r.peakRate, bar = 240 / m.bpm, q1 = m.hot && m.hot[0] != null ? m.hot[0] : (m.q1 ?? m.firstBeat);
    const nb = Math.floor((dur - q1) / bar); if (nb < 16) return null;
    // per bar: bass energy, sustained bass (the bar's median: a kick alone leaves it near silent, a bassline fills it) and full band
    const lo = new Float32Array(nb), sus = new Float32Array(nb), al = new Float32Array(nb), tmp = [];
    for (let b = 0; b < nb; b++) {
      const i0 = Math.max(0, Math.floor((q1 + b * bar) * FR)), i1 = Math.min(r.lowE.length, Math.floor((q1 + (b + 1) * bar) * FR));
      let sl = 0, sa = 0; tmp.length = 0;
      for (let i = i0; i < i1; i++) { sl += r.lowE[i]; sa += r.allE[i]; tmp.push(r.lowE[i]); }
      tmp.sort((x, y) => x - y);
      lo[b] = Math.sqrt(sl / Math.max(1, i1 - i0)); al[b] = Math.sqrt(sa / Math.max(1, i1 - i0)); sus[b] = Math.sqrt(tmp[tmp.length >> 1] || 0);
    }
    const norm = a => { const s = Array.from(a).sort((x, y) => x - y), p = s[Math.floor(s.length * 0.9)] || 1; for (let i = 0; i < a.length; i++) a[i] = Math.min(1.2, a[i] / p); };
    norm(lo); norm(sus); norm(al);
    // the musical end: the last bar with real sound in it
    let endBar = nb; while (endBar > 8 && al[endBar - 1] < 0.12) endBar--;
    // which 8-bar offset puts the 32-bar lines on the biggest energy changes (most tracks: 0, counting from the first downbeat)
    const mean = (a, b0, n) => { let s = 0, k = 0; for (let b = Math.max(0, b0); b < Math.min(nb, b0 + n); b++) { s += a[b]; k++; } return k ? s / k : 0; };
    const change = b => Math.abs(mean(sus, b, 4) - mean(sus, b - 4, 4)) + Math.abs(mean(lo, b, 4) - mean(lo, b - 4, 4)) + 0.5 * Math.abs(mean(al, b, 4) - mean(al, b - 4, 4));
    let off = 0, best = -1;
    for (const o of [0, 8, 16, 24]) {
      let s = 0, k = 0; for (let b = o || 32; b < endBar; b += 32) { s += change(b); k++; }
      s = k ? s / k : 0; if (o === 0) s += 0.04;            // a small pull towards counting from the first downbeat
      if (s > best) { best = s; off = o; }
    }
    // 8-bar blocks from the first downbeat
    const blocks = [];
    for (let b = 0; b < endBar; b += 8) {
      const L = mean(lo, b, 8), U = mean(sus, b, 8), A = mean(al, b, 8);
      blocks.push({ bar: b, type: L < 0.3 ? 'break' : U >= 0.55 && L >= 0.6 ? 'drop' : 'groove' });   // groove: drums without the full bass
    }
    const loud = k => blocks[k] && blocks[k].type === 'drop';
    let first = blocks.findIndex(x => x.type === 'drop'), last = -1;
    for (let k = blocks.length - 1; k >= 0; k--) if (loud(k)) { last = k; break; }
    // name the quiet ends: everything before the first loud block is intro, everything after the last is outro
    const firstLoud = blocks.findIndex((x, k) => loud(k));
    blocks.forEach((x, k) => { if (firstLoud >= 0 && k < firstLoud) x.type = 'intro'; else if (last >= 0 && k > last) x.type = 'outro'; });
    const at = b => q1 + b * bar;
    const dropBar = first > 0 ? blocks[first].bar : null;
    const mixInBar = dropBar != null ? Math.max(0, dropBar - 32) : 0;
    const outroBar = last >= 0 ? blocks[last].bar + 8 : endBar;
    let mixOutBar = Math.min(outroBar, endBar - 32);
    mixOutBar = Math.max(8, Math.floor(mixOutBar / 8) * 8);
    const phrases = []; for (let b = off; b < nb; b += 32) phrases.push(at(b));
    return {
      v: DJ.CUES_V, bar, off, phrases, blocks: blocks.map(x => ({ at: at(x.bar), type: x.type })),
      mixIn: at(mixInBar), drop: dropBar != null ? at(dropBar) : null, mixOut: at(mixOutBar), end: at(endBar),
    };
  };
})(window.DJ);
