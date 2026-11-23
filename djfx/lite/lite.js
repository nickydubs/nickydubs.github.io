/* DJFX Lite: the one-thumb deck. Built on the DJFX engine (../js/engine.js: decks, FX unit, key lock) and its
   analysis (../js/analysis.js: tempo, beat grid, phrases). Two hidden decks: NOW plays, NEXT waits.
   Transition 1-4 mixes NEXT in by itself on a 4-bar phrase line, beat-matched when the tempos are close;
   LOOP rolls the playing track; CUT/DROP slams NEXT in on the next downbeat.
   Songs come from this device (or the bundled demo list). Nothing is uploaded. */
(function () {
  'use strict';
  const DJ = window.DJ;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MAX_STRETCH = 0.10;          // beat-match within 10 %; further apart the next track lands on the 1 at its own tempo
  const LOOPS = [0.25, 0.5, 1, 2, 4, 8];
  const loopLabel = b => b < 1 ? '1/' + Math.round(1 / b) : String(b);
  const AUDIO = /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|webm|aif|aiff)$/i;

  const eng = new DJ.Engine(), ctx = eng.ctx, fx = eng.fx;
  eng.setMaster(0.9);
  const unlock = () => eng.resume();
  addEventListener('pointerdown', unlock, { capture: true }); addEventListener('keydown', unlock, { capture: true });

  // Per deck: the trim carries the mix (it sits before the FX insert, so echo tails ring on after a fade-out),
  // a high-pass and a low-pass for sweeps are spliced in after the EQ, the fader only dips loop seams, the crossfader stays open.
  for (const d of Object.values(eng.decks)) {
    d.hpf = ctx.createBiquadFilter(); d.hpf.type = 'highpass'; d.hpf.frequency.value = 10; d.hpf.Q.value = 0.7;
    d.lpf = ctx.createBiquadFilter(); d.lpf.type = 'lowpass'; d.lpf.frequency.value = 22000; d.lpf.Q.value = 0.7;
    d.hi.disconnect(); d.hi.connect(d.hpf); d.hpf.connect(d.lpf); d.lpf.connect(d.insert.in);
    DJ.setAt(d.xf.gain, 1, ctx.currentTime);
    d.onended = deckEnded; d.dipT = 0; d.slip = null; d._exit = 0; d.m = null;
  }
  function neutral(d, t = ctx.currentTime) {
    DJ.setAt(d.trim.gain, 1, t); DJ.setAt(d.lo.gain, 0, t); DJ.setAt(d.mid.gain, 0, t); DJ.setAt(d.hi.gain, 0, t);
    DJ.setAt(d.hpf.frequency, 10, t); DJ.setAt(d.hpf.Q, 0.7, t); DJ.setAt(d.lpf.frequency, 22000, t); DJ.setAt(d.lpf.Q, 0.7, t);
    DJ.setAt(d.fader.gain, 1, t);
  }
  // [[t, v, exp?], ...]: hold the param at the first time, then ramp through the points
  function steps(prm, pts) {
    DJ.hold(prm, pts[0][0]); prm.setValueAtTime(pts[0][1], pts[0][0]);
    for (let i = 1; i < pts.length; i++) { const [t, v, e] = pts[i]; e ? prm.exponentialRampToValueAtTime(v, t) : prm.linearRampToValueAtTime(v, t); }
  }
  function curve(prm, t0, t1, fn, n = 24) {
    DJ.hold(prm, t0); prm.setValueAtTime(fn(0), t0);
    for (let k = 1; k <= n; k++) prm.linearRampToValueAtTime(fn(k / n), t0 + (t1 - t0) * k / n);
  }

  /* ------------------------------------------------------------ toast */
  let toastT = 0;
  function toast(m) { const el = $('#toast'); el.textContent = m; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 1800); }

  /* ------------------------------------------------------------ library */
  const tracks = []; let tid = 0;
  const META = (() => { try { return JSON.parse(localStorage.getItem('djfx.tracks') || '{}'); } catch (e) { return {}; } })();   // the full deck's hand-fixed grids
  const fkey = f => f.name + '|' + f.size + '|' + f.lastModified;
  const DIR = '../music/', CACHE = 'djfx-songs-v1';   // same cache as the full deck: a song downloaded there plays here for free
  const urlOf = e => e.url || DIR + encodeURIComponent(e.file);
  async function getBlob(e) {
    const u = urlOf(e);
    try {
      const c = await caches.open(CACHE); let r = await c.match(u);
      if (!r) { r = await fetch(u); if (!r.ok) return null; await c.put(u, r.clone()); }
      return await r.blob();
    } catch (err) { const r = await fetch(u); return r.ok ? r.blob() : null; }
  }
  function mkTrack(o) { return Object.assign({ id: ++tid, bpm: null, m: null, status: '', bad: false }, o); }
  function setLibrary(list) {
    tracks.length = 0; tracks.push(...list);
    userNext = null; nextT = D('now').playing && tracks.includes(D('now').track) ? following() : tracks[0] || null;
    renderList(); ensureNext();
  }
  function addFiles(files, replace) {
    const list = [...files].filter(f => AUDIO.test(f.name) || (f.type || '').startsWith('audio/'))
      .sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }))
      .map(f => mkTrack({ name: f.name.replace(/\.[^.]+$/, ''), file: f }));
    if (!list.length) { toast('No songs found there'); return; }
    if (replace) setLibrary(list);
    else { tracks.push(...list); if (!nextT) nextT = list[0]; renderList(); ensureNext(); }
    toast(list.length + (list.length === 1 ? ' song' : ' songs') + ' loaded');
  }
  async function walkDir(dir, out) {
    for await (const h of dir.values()) {
      if (h.kind === 'file') { if (AUDIO.test(h.name)) out.push(await h.getFile()); }
      else if (h.kind === 'directory') await walkDir(h, out);
    }
  }
  $('#loadDir').addEventListener('click', async () => {
    if (window.showDirectoryPicker) {
      try { const dir = await showDirectoryPicker({ id: 'djfx-lite', mode: 'read' }), out = []; toast('Reading folder…'); await walkDir(dir, out); addFiles(out, true); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    $('#dirIn').click();
  });
  $('#addFiles').addEventListener('click', () => $('#fileIn').click());
  $('#dirIn').addEventListener('change', e => { addFiles(e.target.files, true); e.target.value = ''; });
  $('#fileIn').addEventListener('change', e => { addFiles(e.target.files, false); e.target.value = ''; });

  // Decode, and analyse once per track (tempo, grid, first downbeat, drop). Decoded audio lives only on the decks.
  async function getData(t) {
    let buf = t.buf;
    if (!buf) {
      t.status = 'loading'; renderList();
      const blob = t.file || await getBlob(t.entry);
      if (!blob) throw new Error('download failed');
      buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    }
    if (!t.m) {
      t.status = 'analysing'; renderList();
      const r = await DJ.analyze(buf);
      const m = { bpm: r.bpm, firstBeat: r.firstBeat, q1: r.q1 };
      const saved = t.file && META[fkey(t.file)];
      if (saved && saved.edited && saved.bpm) {
        m.bpm = saved.bpm; m.firstBeat = saved.firstBeat ?? m.firstBeat;
        m.q1 = saved.hot && saved.hot[0] != null ? saved.hot[0] : (saved.q1 ?? m.firstBeat);
      } else if (t.bpmHint && Math.abs(m.bpm - t.bpmHint) / t.bpmHint > 0.06) m.bpm = t.bpmHint;   // analyser locked onto 2/3 or 1/2
      if (m.q1 == null) m.q1 = m.firstBeat;
      const c = DJ.cues(r, m, buf.duration), bar = 240 / m.bpm;
      m.end = c ? c.end : buf.duration;
      m.drop = c && c.drop != null && c.drop < m.end - 8 * bar ? c.drop : null;
      t.m = m;
    }
    t.bpm = t.m.bpm; t.status = '';
    return buf;
  }

  /* ------------------------------------------------------------ decks and roles */
  const R = { now: 'A', next: 'B' };
  const D = r => eng.decks[R[r]];
  let nextT = null, userNext = null, loadingT = null, startWhenReady = false, plan = null, lastLevel = 2, auto = true;
  try { auto = localStorage.getItem('djfx.lite.auto') !== '0'; } catch (e) {}
  function swapRoles() { [R.now, R.next] = [R.next, R.now]; }
  function following() {
    if (!tracks.length) return null;
    const cur = D('now').track, i = tracks.indexOf(cur), n = tracks.length;
    for (let k = 1; k <= n; k++) { const t = tracks[((i + k) % n + n) % n]; if (t !== cur && !t.bad) return t; }
    return null;
  }
  function pickNext(t) {
    if (t === D('now').track && D('now').playing) { toast('That one is playing now'); return; }
    userNext = nextT = t; renderList(); ensureNext();
  }
  async function ensureNext() {
    if (!nextT || nextT.bad) nextT = following();
    const want = nextT;
    if (!want) return paint();
    const N = D('next');
    if (N.track === want || plan || N.playing) return paint();
    if (loadingT) return paint();                    // the load in flight checks again when it is done
    loadingT = want; paint();
    let buf;
    try { buf = await getData(want); }
    catch (e) {
      console.warn('could not load', want.name, e); want.bad = true; want.status = 'cannot play'; loadingT = null;
      if (nextT === want) nextT = null;
      toast('Skipped ' + want.name); renderList(); return ensureNext();
    }
    loadingT = null;
    if (nextT !== want || plan || D('next').playing) return ensureNext();
    const d = D('next');
    if (d._exit) { clearTimeout(d._exit); d._exit = 0; }
    d.loop.on = false; d.slip = null; d.keyLock = true;
    d.load(buf, want, { bpm: want.m.bpm, firstBeat: want.m.firstBeat, cue: want.m.q1 });
    d.m = want.m; d.bend = 1; d.rate = 1; neutral(d);
    renderList(); paint();
    if (startWhenReady) { startWhenReady = false; startNext(); }
  }

  /* ------------------------------------------------------------ timing helpers */
  // Where the song really is: a loop doesn't move it (slip), so phrases stay in step after a loop.
  function slipPos(d, t) { return d.loop.on && d.slip ? d.slip.p + d.rateAt(t) * (t - d.slip.t) : d.pos(t); }
  // Hold the current tempo (stops a glide in progress) so the deck's clock is a straight line from now on.
  function freeze(d) { if (!d.playing || d.anchorT > ctx.currentTime) return; d.bend = 1; d.rate = d.rateAt(ctx.currentTime); d.applyRate(); }
  function grid(d) {
    const t = Math.max(ctx.currentTime, d.anchorT), r = d.rateAt(t);
    return { t, r, p: slipPos(d, t), barL: 4 * d.beatLen, q1: d.m ? d.m.q1 : d.firstBeat, at(P) { return this.t + (P - this.p) / this.r; } };
  }
  // the first line of `bars` bars (counted from the first downbeat) at or after track position P
  function lineAfter(g, bars, P) { const L = bars * g.barL; return g.q1 + Math.ceil((P - g.q1) / L - 1e-6) * L; }
  // after landing at the outgoing tempo bFrom, glide to the track's own tempo over 8 bars
  function glideHome(I, T, bFrom) {
    if (Math.abs(bFrom - I.bpm) < 0.01) return;
    const ease = u => u * u * (3 - 2 * u), dur = 32 * 60 / ((bFrom + I.bpm) / 2), pts = [{ t: T, r: bFrom / I.bpm }];
    for (let k = 1; k <= 24; k++) pts.push({ t: T + dur * k / 24, r: (bFrom + (I.bpm - bFrom) * ease(k / 24)) / I.bpm });
    I.rampRate(pts); I.rate = 1;
  }
  function at(p, t, fn) { const id = setTimeout(() => { p.timers.delete(id); fn(); }, Math.max(0, (t - ctx.currentTime) * 1000)); p.timers.add(id); }
  function inPosOf(I, bars) { const m = I.m, L = bars * 4 * I.beatLen; return m.drop != null && m.drop - L >= m.q1 - 1e-3 ? m.drop - L : m.q1; }

  /* ------------------------------------------------------------ FX helpers (the engine's FX unit, on the outgoing deck) */
  function echoArm(div, fb, bpm, now) {
    const ec = fx.by.echo; ec.params.div = div; ec.params.feedback = fb; ec.wake(); ec.on = true;
    DJ.setAt(ec.fb.gain, fb, now); DJ.setAt(ec.dl.delayTime, Math.min(3.9, 60 / bpm * DJ.DIVS[div]), now);
    DJ.setAt(ec.send.gain, 0, now); DJ.setAt(ec.wet.gain, 0, now);
    return ec;
  }
  function riser(Tb, T1) {
    const nz = fx.by.noise; nz.wake(); nz.on = true;
    steps(nz.hp.frequency, [[Tb, 300], [T1, 9000, true]]);
    DJ.setAt(nz.send.gain, 1, Tb);
    steps(nz.wet.gain, [[Tb, 0], [T1 - 0.01, 0.3], [T1 + 0.015, 0]]);
  }
  function fxRelease(now) {
    for (const id of ['echo', 'noise']) { const s = fx.by[id]; if (s.on) { s.on = false; DJ.setAt(s.send.gain, 0, now); s.sleepAfter(now); } }
  }

  /* ------------------------------------------------------------ transitions */
  // 1 Blend: 8-bar equal-power blend, the lows cross over bars 3-5 (never both basses at full).
  // 2 Filter: + the incoming opens from a low-pass, hard bass swap on bar 4, the outgoing thins out through a high-pass.
  // 3 Echo: + the outgoing throws a bar into a dotted-eighth echo and cuts on bar 6; the tail rings over the incoming.
  // 4 Drama: loop roll 1 > 1/2 > 1/4 beat, resonant high-pass + noise riser, echo-out, then the next track's drop slams in on the 1.
  // Tempos too far apart to beat-match: the outgoing goes out with its level's effect and the next track lands on the 1 at its own tempo.
  function transition(level) {
    lastLevel = level;
    const O = D('now'), I = D('next');
    if (plan) { toast('Already mixing: CUT drops it now'); return; }
    if (!O.playing) return startNext();
    if (!I.loaded || I.playing) { toast(nextT ? 'Next song is still loading…' : 'Tap a song to play next'); return; }
    freeze(O);
    const g = grid(O), bO = O.bpm * g.r, matched = Math.abs(bO / I.bpm - 1) <= MAX_STRETCH;
    fx.setRoute(O.id); fx.setBpm(bO);
    const p = plan = { level, O, I, matched, bO, timers: new Set() };
    if (level === 4 || !matched) slam(p, g); else blend(p, g);
    at(p, p.T1 + 0.06, () => finish(p));
    paint();
    return p;
  }

  function blend(p, g) {
    const { O, I, level } = p, now = ctx.currentTime;
    const P0 = lineAfter(g, 4, g.p + 0.35 * g.r);                 // the next 4-bar line at least 0.35 s away
    const tb = k => g.at(P0 + k * g.barL), T0 = tb(0), T1 = tb(8);
    p.T0 = T0; p.T1 = T1;
    neutral(I, now); I.bend = 1; I.rate = p.bO / I.bpm;
    I.play(T0, inPosOf(I, 8));                                      // its drop (if any) lands as the blend ends
    glideHome(I, T1, p.bO);
    const S = u => Math.sin(u * Math.PI / 2), C = u => Math.cos(u * Math.PI / 2);
    curve(I.trim.gain, T0, T1, S);
    if (level === 1) {
      curve(O.trim.gain, T0, T1, C);
      steps(I.lo.gain, [[T0, -26], [tb(3), -26], [tb(5), 0]]);
      steps(O.lo.gain, [[T0, 0], [tb(3), 0], [tb(5), -26]]);
      return;
    }
    // 2 and 3: the bass swap on the bar-4 downbeat, in one 30 ms move
    steps(I.lo.gain, [[T0, -26], [tb(4), -26], [tb(4) + 0.03, 0]]);
    steps(O.lo.gain, [[T0, 0], [tb(4), 0], [tb(4) + 0.03, -26]]);
    steps(I.lpf.frequency, [[T0, 350], [tb(4), 22000, true]]); steps(I.lpf.Q, [[T0, 2.2], [tb(4), 0.7]]);
    if (level === 2) {
      curve(O.trim.gain, T0, T1, C);
      steps(O.hpf.frequency, [[tb(4), 10], [T1, 900, true]]); steps(O.hpf.Q, [[tb(4), 0.7], [tb(4) + 0.05, 2.5]]);
      return;
    }
    // 3: fade to bar 5, hold through the throw bar, cut on bar 6 and let the echo carry it out
    const t5 = tb(5), t6 = tb(6);
    curve(O.trim.gain, T0, t5, u => C(u * 5 / 8));
    O.trim.gain.setValueAtTime(C(5 / 8), t6); O.trim.gain.linearRampToValueAtTime(0, t6 + 0.012);
    steps(O.hpf.frequency, [[tb(4), 10], [t6, 700, true]]); steps(O.hpf.Q, [[tb(4), 0.7], [tb(4) + 0.05, 2.5]]);
    const ec = echoArm('3/16', 0.6, p.bO, now);
    steps(ec.wet.gain, [[t5, 0.9]]);
    steps(ec.send.gain, [[t5, 1], [t6 + 0.012, 1], [t6 + 0.025, 0]]);
  }

  function slam(p, g) {
    const { O, I, level, matched } = p, now = ctx.currentTime, beatP = O.beatLen;
    const Pn = lineAfter(g, 1, g.p + 0.3 * g.r);                   // the next downbeat
    const P1 = lineAfter(g, 4, Pn + 2 * g.barL);                   // the slam: a 4-bar line at least 2 bars after it
    const Pb = Math.max(P1 - 4 * g.barL, Pn);                       // the build: up to 4 bars
    const T1 = g.at(P1), Tb = g.at(Pb);
    p.T0 = Tb; p.T1 = T1;
    neutral(I, now); I.bend = 1; I.rate = matched ? p.bO / I.bpm : 1;
    I.play(T1, level === 4 ? inPosOf(I, 0) : I.m.q1);
    if (matched) glideHome(I, T1, p.bO);
    if (level === 4) {
      at(p, g.at(P1 - 2 * g.barL) + 0.012, () => loopSet(O, 1));
      at(p, g.at(P1 - g.barL) + 0.012, () => loopSet(O, 0.5));
      at(p, g.at(P1 - 2 * beatP) + 0.012, () => loopSet(O, 0.25));
      p.rollT = g.at(P1 - 2 * g.barL);
      steps(O.hpf.frequency, [[Tb, 10], [T1, 1600, true]]); steps(O.hpf.Q, [[Tb, 0.7], [Tb + 0.05, 4]]);
      riser(Tb, T1);
      const ec = echoArm('1/8', 0.55, p.bO, now);
      steps(ec.wet.gain, [[T1 - g.barL / 4 / g.r, 0.7]]);
      steps(ec.send.gain, [[T1 - g.barL / 4 / g.r, 1], [T1 + 0.004, 1], [T1 + 0.015, 0]]);
      steps(O.trim.gain, [[T1, 1], [T1 + 0.006, 0]]);
    } else if (level === 1) {
      steps(O.lpf.frequency, [[Tb, 22000], [T1, 250, true]]);
      const tf = Math.max(Tb, g.at(P1 - 2 * g.barL));
      curve(O.trim.gain, tf, T1, u => Math.cos(u * Math.PI / 2));
    } else {
      steps(O.hpf.frequency, [[Tb, 10], [T1, 1200, true]]); steps(O.hpf.Q, [[Tb, 0.7], [Tb + 0.05, 3]]);
      const tl = g.at(P1 - g.barL);
      if (level === 3) {
        const ec = echoArm('3/16', 0.6, p.bO, now);
        steps(ec.wet.gain, [[tl, 0.9]]);
        steps(ec.send.gain, [[tl, 1], [T1 + 0.004, 1], [T1 + 0.015, 0]]);
        steps(O.trim.gain, [[T1, 1], [T1 + 0.006, 0]]);
      } else curve(O.trim.gain, Math.max(Tb, tl), T1, u => Math.cos(u * Math.PI / 2));
    }
  }

  // From T on only the incoming plays: full, open, its own bass. The outgoing is cut, every effect killed.
  function land(p, T) {
    const { O, I } = p;
    for (const [prm, v] of [[I.trim.gain, 1], [I.lo.gain, 0], [I.lpf.Q, 0.7], [I.hpf.Q, 0.7]]) { DJ.hold(prm, T); prm.linearRampToValueAtTime(v, T + 0.008); }
    DJ.hold(I.lpf.frequency, T); I.lpf.frequency.exponentialRampToValueAtTime(22000, T + 0.02);
    DJ.hold(I.hpf.frequency, T); I.hpf.frequency.exponentialRampToValueAtTime(10, T + 0.02);
    DJ.hold(O.trim.gain, T); O.trim.gain.linearRampToValueAtTime(0, T + 0.006);
    fx.cutAll(T);
    p.T1 = T; p.cut = true;
    at(p, T + 0.06, () => finish(p));
    paint();
  }
  function cutDrop() {
    const O = D('now'), I = D('next'), now = ctx.currentTime;
    if (!O.playing && !plan) return startNext();
    const T = O.nextDownbeat(0.06) || now + 0.06;
    if (plan) {
      const p = plan; if (p.cut) return;                                 // already dropping
      p.timers.forEach(clearTimeout); p.timers.clear();
      if (p.I.playing && p.I.anchorT <= T + 1e-3) {                   // the incoming is already running: it takes over on T
        if (p.matched) glideHome(p.I, T, p.I.effBpm(T));
        return land(p, T);
      }
      p.I.pause(); p.I.pausedPos = p.I.m.q1; neutral(p.I, now + 0.02); plan = null;   // its start is still ahead: drop it fresh
    }
    if (!I.loaded || I.playing) {                                      // nothing to drop into: just kill the FX and the loop
      fx.cutAll(T); if (O.loop.on) loopExit(O); toast(nextT ? 'Next song is still loading…' : 'Tap a song to play next'); return;
    }
    freeze(O);
    const bO = O.effBpm(T), matched = Math.abs(bO / I.bpm - 1) <= MAX_STRETCH;
    fx.setRoute(O.id);
    const p = plan = { level: 0, O, I, matched, bO, T0: T, timers: new Set() };
    neutral(I, now); I.bend = 1; I.rate = matched ? bO / I.bpm : 1;
    I.play(T, inPosOf(I, 0));
    if (matched) glideHome(I, T, bO);
    land(p, T);
    return p;
  }
  function finish(p) {
    if (plan !== p) return;
    plan = null; p.timers.forEach(clearTimeout);
    const { O, I } = p, now = ctx.currentTime;
    stopDeck(O); fxRelease(now);
    swapRoles();
    nextT = userNext && userNext !== I.track ? userNext : following(); userNext = null;
    renderList(); ensureNext(); paint();
  }
  function stopDeck(d) {
    if (d._exit) { clearTimeout(d._exit); d._exit = 0; }
    d.pause(); d.loop.on = false; d.slip = null; d.rate = 1; d.bend = 1; d.keyLock = true;
    neutral(d, ctx.currentTime + 0.03);                                // after the 4 ms stop fade, never during it
  }
  function startNext() {
    if (plan) return;
    const I = D('next'), O = D('now');
    if (!I.loaded || I.playing) { startWhenReady = true; toast('Loading the next song…'); ensureNext(); return; }
    if (O.playing) stopDeck(O);
    neutral(I); I.bend = 1; I.rate = 1; I.play(ctx.currentTime + 0.06, I.m.q1);
    swapRoles(); wake();
    nextT = userNext && userNext !== I.track ? userNext : following(); userNext = null;
    renderList(); ensureNext(); paint();
  }
  function deckEnded(d) {
    if (plan && (d === plan.O || d === plan.I)) return;
    if (d === D('now')) { if (D('next').loaded && !D('next').playing) startNext(); else paint(); }
  }
  function playPause() {
    const O = D('now');
    if (plan) {                                                        // stop everything, mid-mix included
      const p = plan; plan = null; p.timers.forEach(clearTimeout);
      if (p.I.playing) p.I.pause(); p.I.pausedPos = p.I.m.q1; neutral(p.I, ctx.currentTime + 0.03);
      fx.cutAll(); fxRelease(ctx.currentTime);
    }
    if (O.playing) { if (O._exit) { clearTimeout(O._exit); O._exit = 0; } O.loop.on = false; O.slip = null; O.keyLock = true; O.pause(); neutral(O, ctx.currentTime + 0.03); paint(); return; }
    if (O.loaded && O.pausedPos < O.duration - 1) { neutral(O); O.play(); wake(); paint(); return; }
    startNext();
  }

  /* ------------------------------------------------------------ loops (slip: the song keeps running underneath) */
  let loopBeats = 1;
  const rolling = () => plan && plan.level === 4 && plan.rollT && ctx.currentTime > plan.rollT - 0.2;
  function loopSet(d, beats) {
    if (!d.playing || !d.loaded) return;
    if (d._exit) { clearTimeout(d._exit); d._exit = 0; }
    const now = ctx.currentTime;
    if (!d.loop.on) d.slip = { p: d.pos(now), t: now };
    freeze(d);
    // At its own tempo the key lock isn't needed, and its worklet applies loop changes up to a frame (~21 ms) late.
    // Hand over to a plain buffer source (sample-exact loops): same audio, same spot, so the engine's 4 ms crossfade is seamless.
    if (d.src instanceof DJ.StretchSource && d.anchorT <= now && Math.abs(d.rateAt(now) - 1) < 1e-4) {
      d.keyLock = false; const t = now + 0.03; d.seek(d.pos(t), t);
    }
    applyLoop(d, beats);
    redip(d); paint();
  }
  // The engine's setLoop, also for a deck whose (re)start is still a few ms ahead: start snapped to the beat grid, no seek, no gap
  function applyLoop(d, beats) {
    const now = ctx.currentTime, t = Math.max(now, d.anchorT);
    if (t === now) d.reanchor(now);
    const p = d.pos(t), len = beats * d.beatLen, u = Math.min(len, d.beatLen);
    const start = d.firstBeat + Math.floor((p - d.firstBeat) / u + 1e-7) * u;
    d.loop = { on: true, start, end: start + len, beats };
    if (d.src) { d.src.loopStart = start; d.src.loopEnd = start + len; d.src.loop = true; }
  }
  // Exit on the next beat of the real timeline: jump to where the song would be by now (4 ms crossfade in the engine's seek)
  function loopExit(d) {
    if (!d.loop.on || d._exit) return;
    const now = ctx.currentTime, r = d.rateAt(now), sp = slipPos(d, now);
    const target = d.gridPos(sp + 0.05 * r, 1, 'ceil'), Tq = now + (target - sp) / r;
    d._exit = setTimeout(() => {
      d._exit = 0; if (!d.loop.on || !d.playing) return;
      d.loop.on = false; d.slip = null; d.keyLock = true; d.seek(target, Tq); paint();
    }, Math.max(0, (Tq - now - 0.09) * 1000)) || 1;
    paint();
  }
  function loopToggle() {
    const d = D('now'); if (!d.playing || rolling()) return;
    if (d.loop.on && !d._exit) loopExit(d); else loopSet(d, loopBeats);
  }
  function loopSize(b, start = true) {
    loopBeats = b; const d = D('now');
    if (d.playing && !rolling() && (start || d.loop.on)) loopSet(d, b);
    paint();
  }
  // Loop seams: a 4 ms dip to silence centred on every wrap, scheduled just ahead on the deck's fader.
  // Only where the deck clock is sample-exact (plain playback, or the key lock at its own tempo).
  function redip(d) { const g = d.fader.gain, t = ctx.currentTime; DJ.hold(g, t); g.linearRampToValueAtTime(1, t + 0.004); d.dipT = t + 0.005; dipAhead(d, t); }
  function dipAhead(d, now) {
    if (!d.playing || !d.loop.on || window.DJLITE.noDip) return;
    const exact = !(d.src instanceof DJ.StretchSource) || Math.abs(d.rateAt(now) - 1) < 1e-4;
    const L = d.loop, len = L.end - L.start; if (!exact || len < 0.02) return;
    let from = Math.max(now, d.dipT, d.anchorT);
    for (let i = 0; i < 64; i++) {
      const raw = d.rawPos(from), W = raw < L.end ? L.end : L.end + (Math.floor((raw - L.end) / len) + 1) * len;
      const tw = d.timeOfPos(W); if (tw == null || tw > now + 0.15) break;
      if (tw - 0.004 > now) { const g = d.fader.gain; g.setValueAtTime(1, tw - 0.004); g.linearRampToValueAtTime(0, tw); g.linearRampToValueAtTime(1, tw + 0.004); }
      d.dipT = from = tw + 0.0045;
    }
  }

  /* ------------------------------------------------------------ ticker: slip clocks, seam dips, auto mix */
  setInterval(() => {
    const now = ctx.currentTime;
    for (const d of Object.values(eng.decks)) {
      if (d.slip && d.playing && d.loop.on && now > d.slip.t) { d.slip.p += (d.rateAt(d.slip.t) + d.rateAt(now)) / 2 * (now - d.slip.t); d.slip.t = now; }
      dipAhead(d, now);
    }
    const O = D('now'), I = D('next');
    if (auto && !plan && O.playing && O.m && I.loaded && !I.playing && !O.loop.on && now - O.startedAt > 20) {
      const end = O.m.end || O.duration, barL = 4 * O.beatLen;
      if (O.pos(now) > end - 13 * barL) transition(lastLevel);
    }
  }, 25);

  /* ------------------------------------------------------------ screen */
  function renderList() {
    const el = $('#list'), nowT = D('now').loaded ? D('now').track : null;
    if (!tracks.length) { el.innerHTML = '<p class="empty">Load a folder of songs to start.</p>'; return; }
    el.innerHTML = tracks.map(t => {
      const cls = t === nowT ? 'now' : t === nextT ? 'next' : '', bd = t === nowT ? 'NOW' : t === nextT ? 'NEXT' : '';
      const meta = t.status || (t.bpm ? t.bpm.toFixed(1) : t.bpmHint ? '~' + Math.round(t.bpmHint) : '');
      return `<button class="trk ${cls}${t.bad ? ' bad' : ''}" data-id="${t.id}"><span class="bd">${bd}</span><span class="n">${esc(t.name)}</span><span class="m">${esc(meta)}</span></button>`;
    }).join('');
  }
  $('#list').addEventListener('click', e => { const b = e.target.closest('.trk'); if (!b) return; const t = tracks.find(x => x.id === +b.dataset.id); if (t) pickNext(t); });

  function paint() {
    const O = D('now'), I = D('next');
    $('#nowT').textContent = O.loaded ? O.track.name : 'Nothing playing yet';
    $('#play').classList.toggle('on', O.playing); $('#play').textContent = O.playing ? '❚❚' : '▶';
    const nt = I.loaded && !(plan && plan.I === I) ? I.track : nextT;
    $('#nextT').textContent = plan ? (plan.I.track ? plan.I.track.name : '') : nt ? nt.name : 'Tap a song below';
    let sub = '';
    if (plan) sub = plan.cut ? 'dropping on the 1' : 'mixing in…';
    else if (loadingT) sub = 'loading…';
    else if (I.loaded && I.m) {
      const bO = O.playing ? O.effBpm() : 0;
      sub = !bO ? 'ready' : Math.abs(bO / I.bpm - 1) <= MAX_STRETCH ? 'beat-matched to ' + bO.toFixed(1) : 'tempo far apart: lands on the 1';
    }
    $('#nextS').textContent = sub;
    $('#nextB').textContent = I.loaded && I.m ? I.bpm.toFixed(1) : '';
    $('#loop').classList.toggle('on', O.loop.on && !O._exit);
    $('#loop').textContent = O._exit ? 'EXIT…' : 'LOOP';
    $$('.ls').forEach(b => { const v = +b.dataset.b; b.classList.toggle('sel', v === loopBeats); b.classList.toggle('on', O.loop.on && Math.abs(O.loop.beats - v) < 1e-6); });
    $$('#tx button').forEach(b => b.classList.toggle('live', !!plan && plan.level === +b.dataset.l));
    $('#cut').classList.toggle('pending', !!(plan && plan.cut));
    $('#auto').classList.toggle('on', auto);
    renderList();
  }
  function frame() {
    const O = D('now'), now = ctx.currentTime;
    if (O.loaded && O.m) {
      const p = slipPos(O, now), bi = Math.floor((p - O.m.q1) / O.beatLen + 1e-3), on = O.playing && p >= O.m.q1 - 0.01;
      $$('#dots i').forEach((el, k) => el.classList.toggle('on', on && ((bi % 4) + 4) % 4 === k));
      const bar = Math.floor(bi / 4);
      $$('#phr i').forEach((el, k) => el.classList.toggle('on', on && ((bar % 8) + 8) % 8 >= k));
      $('#prog').style.width = (100 * Math.min(1, O.pos(now) / O.duration)) + '%';
      $('#nowB').textContent = O.effBpm(now).toFixed(1);
    } else { $('#nowB').textContent = '---'; $('#prog').style.width = '0'; }
    const live = $('#tx button.live small');
    if (plan && live) {
      const barT = 4 * plan.O.beatLen / plan.O.rateAt(now);
      live.textContent = now < plan.T0 ? 'in ' + Math.max(1, Math.ceil((plan.T0 - now) / barT - 0.05)) + ' bar' + (Math.ceil((plan.T0 - now) / barT - 0.05) > 1 ? 's' : '')
        : now < plan.T1 ? 'mixing · ' + Math.max(1, Math.ceil((plan.T1 - now) / barT - 0.05)) : 'done';
    }
    $$('#tx button:not(.live) small').forEach(el => { if (el.textContent !== el.dataset.d) el.textContent = el.dataset.d; });
  }
  if (window.NDAudio) NDAudio.frames(frame, 30); else (function loop() { frame(); requestAnimationFrame(loop); })();
  if (window.NDAudio) NDAudio.keepAlive(ctx, () => eng.decks.A.playing || eng.decks.B.playing);

  // screen stays on while it plays
  let lock = null;
  async function wake() { try { if (!lock && navigator.wakeLock && document.visibilityState === 'visible') { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch (e) {} }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (eng.decks.A.playing || eng.decks.B.playing)) wake(); });

  /* ------------------------------------------------------------ controls */
  $('#tx').addEventListener('click', e => { const b = e.target.closest('button'); if (b) transition(+b.dataset.l); });
  $('#cut').addEventListener('click', cutDrop);
  $('#play').addEventListener('click', playPause);
  $('#loop').addEventListener('click', loopToggle);
  $('.loop').addEventListener('click', e => { const b = e.target.closest('.ls'); if (b) loopSize(+b.dataset.b); });
  $('#auto').addEventListener('click', () => { auto = !auto; try { localStorage.setItem('djfx.lite.auto', auto ? '1' : '0'); } catch (e) {} toast(auto ? 'Auto mix on: it mixes by itself near the end' : 'Auto mix off'); paint(); });
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.target.closest('input,select,textarea')) return;
    const k = e.key;
    if (k >= '1' && k <= '4') transition(+k);
    else if (k === 'l' || k === 'L') loopToggle();
    else if (k === '[' || k === ']') { const i = LOOPS.indexOf(loopBeats) + (k === '[' ? -1 : 1); loopSize(LOOPS[Math.max(0, Math.min(LOOPS.length - 1, i))], false); }
    else if (k === ' ') { e.preventDefault(); cutDrop(); }
    else if (k === 'p' || k === 'P') playPause();
    else return;
    e.preventDefault();
  });

  /* ------------------------------------------------------------ start: the bundled demo songs */
  (async () => {
    renderList(); paint();
    if (location.protocol === 'file:') return;
    try {
      const list = (await (await fetch(DIR + 'playlist.json')).json()).tracks || [];
      if (tracks.length) return;                                         // a folder picked meanwhile wins
      setLibrary(list.map(e => mkTrack({ name: e.file.replace(/\.[^.]+$/, ''), entry: e, bpmHint: e.bpm })));
    } catch (e) { console.warn('demo playlist unavailable', e); }
  })();

  // for the self-test and the curious
  window.DJLITE = { eng, R, D, tracks, transition, cutDrop, loopSet, loopExit, loopSize, loopToggle, playPause, startNext, pickNext,
    get plan() { return plan; }, get nextT() { return nextT; }, noDip: false, slipPos, mkTrack, setLibrary, ensureNext };
})();
