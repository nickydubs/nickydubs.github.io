/* DJFX app: one playlist, a NOW deck and a NEXT deck (roles swap on every drop), the audio roll, FX rack,
   NEXT ON THE 1 / CUT ALL on the downbeat, automix, keys. */
(function () {
  const DJ = window.DJ;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const DEF = { cutKeys: 'Space+Enter', mixBeats: 32, tempoMode: 'smooth', style: 'swell', maxStretch: 10, xfCurve: 'smooth', amFx: true,
    route: 'now', fx: {}, master: 0.9, dropTempo: 'glide', glideBeats: 16, keyLock: true };
  const S = Object.assign({}, DEF, store.get('djfx.settings', {}));
  if (S.route === 'A' || S.route === 'B') S.route = 'now';
  const META = store.get('djfx.tracks', {});
  const saveS = () => store.set('djfx.settings', S), saveMeta = () => store.set('djfx.tracks', META);
  const fmtT = s => { if (!isFinite(s)) return '--:--'; s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 1800); }

  const eng = new DJ.Engine(); const ctx = eng.ctx;
  const unlock = () => eng.resume();
  window.addEventListener('pointerdown', unlock, { capture: true }); window.addEventListener('keydown', unlock, { capture: true });
  eng.xfCurve = S.xfCurve; eng.master.gain.value = S.master;
  for (const id of ['A', 'B']) eng.decks[id].keyLock = S.keyLock;

  /* ---------------------------------------------------------------- roles */
  const R = { now: 'A', next: 'B' };
  const D = r => eng.decks[R[r]];
  const roleOf = id => R.now === id ? 'now' : 'next';
  function applyRoles() {
    for (const id of ['A', 'B']) {
      const el = $('#deck' + id), r = roleOf(id);
      el.classList.toggle('now', r === 'now'); el.classList.toggle('next', r === 'next'); el.style.order = r === 'now' ? 0 : 1;
      $('.role', el).textContent = r === 'now' ? 'NOW' : 'NEXT';
      const sr = $(`[data-srole="${id}"]`); if (sr) sr.textContent = r === 'now' ? 'now' : 'next';
    }
    if (S.route === 'now' || S.route === 'next') eng.fx.setRoute(R[S.route]);
    renderList();
  }
  function swapRoles() { [R.now, R.next] = [R.next, R.now]; applyRoles(); mediaMeta(); }
  eng.fx.gridDeck = () => D('now').playing ? D('now') : (D('next').playing ? D('next') : null);

  /* ---------------------------------------------------------------- knob */
  function knob(el, o) {
    el.classList.add('knob');
    el.innerHTML = '<div class="kn" role="slider" tabindex="0" aria-label="' + o.label + '"><i></i></div><span class="kl">' + o.label + '</span><span class="kv"></span>';
    const kn = $('.kn', el), kv = $('.kv', el); let v = o.value;
    const set = (nv, emit = true) => {
      v = clamp(nv, o.min, o.max); const f = (v - o.min) / (o.max - o.min);
      kn.style.transform = 'rotate(' + (-135 + 270 * f) + 'deg)'; kv.textContent = o.fmt ? o.fmt(v) : v.toFixed(2);
      kn.setAttribute('aria-valuenow', v.toFixed(2)); if (emit && o.onInput) o.onInput(v);
    };
    let y0 = 0, v0 = 0;
    kn.addEventListener('pointerdown', e => { kn.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = v; e.preventDefault(); });
    kn.addEventListener('pointermove', e => { if (kn.hasPointerCapture(e.pointerId)) set(v0 + (y0 - e.clientY) / 160 * (o.max - o.min)); });
    kn.addEventListener('dblclick', () => set(o.def ?? o.value));
    kn.addEventListener('wheel', e => { e.preventDefault(); set(v - Math.sign(e.deltaY) * (o.max - o.min) / 40); }, { passive: false });
    kn.addEventListener('keydown', e => { if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(v + (o.max - o.min) / 40); if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(v - (o.max - o.min) / 40); });
    set(v, false);
    return { set, get: () => v };
  }
  const dB = g => (g <= 0.0001 ? '-∞' : (20 * Math.log10(g)).toFixed(0)) + 'dB';

  /* ---------------------------------------------------------------- library: one playlist */
  const AUDIO = /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|webm|aif|aiff)$/i;
  const tracks = []; let tid = 0, pinnedNext = null;
  const fkey = f => f.name + '|' + f.size + '|' + f.lastModified;
  function addFiles(files) {
    const added = [];
    for (const f of files) {
      if (!AUDIO.test(f.name) && !(f.type || '').startsWith('audio/')) continue;
      const t = { id: ++tid, file: f, name: f.name.replace(/\.[^.]+$/, ''), key: fkey(f), played: false };
      t.meta = META[t.key] || null; t.status = t.meta ? 'ready' : 'queued';
      tracks.push(t); added.push(t);
    }
    added.forEach(t => { if (!t.meta) queue.push(t); }); pump(); renderList(); ensureNext();
    return added;
  }
  // A playlist can carry a known tempo (track.bpmHint). The analyser sometimes locks onto 2/3 or 1/2 of the
  // real beat; when its reading is more than 6% off the hint, use the hint, as if fixed by hand.
  function applyHint(t) {
    if (!t.bpmHint || !t.meta || t.meta.edited) return;
    if (Math.abs(t.meta.bpm - t.bpmHint) / t.bpmHint > 0.06) { t.meta.bpm = t.bpmHint; t.meta.edited = true; }
  }
  const queue = []; let busy = false;
  async function pump() {
    if (busy || !queue.length) return; busy = true;
    const t = queue.shift(); t.status = 'analyzing'; renderList();
    try {
      const buf = await ctx.decodeAudioData(await t.file.arrayBuffer());
      const r = await DJ.analyze(buf);
      if (!(META[t.key] && META[t.key].edited)) META[t.key] = Object.assign(META[t.key] || {}, { bpm: r.bpm, firstBeat: r.firstBeat, q1: r.q1, key: r.key, duration: buf.duration });
      t.meta = META[t.key]; applyHint(t); saveMeta(); t.status = 'ready';
    } catch (e) { t.status = 'error'; console.warn('analysis failed', t.name, e); }
    busy = false; renderList(); pump();
  }
  async function walkEntry(entry, out) {
    if (entry.isFile) { await new Promise(res => entry.file(f => { out.push(f); res(); }, res)); return; }
    if (entry.isDirectory) {
      const rd = entry.createReader(); let batch;
      do { batch = await new Promise(res => rd.readEntries(res, () => res([]))); for (const e of batch) await walkEntry(e, out); } while (batch.length);
    }
  }
  async function filesFromDrop(dt) {
    const out = [], entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (entries.length) { for (const e of entries) await walkEntry(e, out); return out.sort((a, b) => a.name.localeCompare(b.name)); }
    return [...dt.files];
  }
  const deckOf = t => ['A', 'B'].find(id => eng.decks[id].track === t);
  // What should be on the NEXT deck: a pinned pick, else the first unplayed track after the one playing.
  function nextTarget() {
    if (pinnedNext && !pinnedNext.played && deckOf(pinnedNext) !== R.now) return pinnedNext;
    const cur = D('now').track, i = cur ? tracks.indexOf(cur) : -1;
    const after = tracks.slice(i + 1).concat(tracks.slice(0, Math.max(0, i)));
    return after.find(t => !t.played && t !== cur) || null;
  }
  let ensuring = false;
  async function ensureNext() {
    if (ensuring) return; const N = D('next');
    if (N.playing) return;
    if (!D('now').loaded && !D('now').playing) {                       // fill NOW first, so the first track starts there
      if (N.loaded && !N.track.played) { swapRoles(); return ensureNext(); }
      const first = tracks.find(t => !t.played); if (!first) return;
      ensuring = true; try { await loadDeck(R.now, first); } finally { ensuring = false; }
    }
    const t = nextTarget(); if (!t || N.track === t) return;
    ensuring = true; try { await loadDeck(R.next, t); } finally { ensuring = false; }
    if (D('next').track !== nextTarget()) ensureNext();
  }

  /* ---------------------------------------------------------------- decks UI */
  const LOOPS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
  const loopLabel = b => b < 1 ? '1/' + Math.round(1 / b) : b < 4 ? b + (b === 1 ? ' beat' : ' beats') : (b / 4) + (b === 4 ? ' bar' : ' bars');
  const UI = {};
  function buildDeck(id) {
    const d = eng.decks[id], el = $('#deck' + id);
    el.innerHTML = `
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><span class="role">NOW</span><span class="tag" style="font-size:14px">${id}</span><span class="title" data-f="title" style="flex:1">Empty: add tracks to the playlist</span><span class="mono" data-f="time">--:--</span></div>
      <div class="readout"><span class="bpm" data-f="bpm">---.-</span><span class="lbl" data-f="bpmsrc">BPM</span><span class="key" data-f="key">—</span><span data-f="pct">0.0%</span><span class="lbl" data-f="beat"></span></div>
      <canvas class="ovw"></canvas>
      <div class="transport"><button data-a="cue">CUE</button><button data-a="play" class="btn-play">▶ PLAY</button><button data-a="sync">SYNC</button><button data-a="kl" title="Key lock: tempo changes keep the pitch">KEY</button><button data-a="q" class="on" title="Quantize cues and loops to the beat grid">Q</button></div>
      <div class="hot">${[0, 1, 2, 3].map(i => `<button data-h="${i}" title="Tap: set or jump (on the NEXT deck: drop it on the 1). Long-press: delete">Q${i + 1}</button>`).join('')}</div>
      <div class="loop"><button data-a="lhalf" aria-label="Halve loop">◀</button><span class="len" data-f="loop">4 beats</span><button data-a="ldouble" aria-label="Double loop">▶</button><button data-a="loop">LOOP</button></div>
      <div class="pitch"><button data-a="range" title="Pitch range">±8%</button><input type="range" min="-1" max="1" step="0.0005" value="0" data-f="pitch" aria-label="Pitch"><div class="row"><button data-a="nd" title="Nudge slower (hold)">−</button><button data-a="nu" title="Nudge faster (hold)">+</button></div></div>
      <details class="gridbox"><summary>Beat grid</summary><div class="grid-edit"><button data-a="g-">◀ 10ms</button><button data-a="g+">10ms ▶</button><button data-a="down">Set downbeat here</button><button data-a="q1here">Q1 = first downbeat</button><button data-a="b/2">BPM ÷2</button><button data-a="b*2">BPM ×2</button><input type="number" step="0.01" min="40" max="250" data-f="bpmEdit" style="width:84px" aria-label="Track BPM"></div></details>`;
    const u = UI[id] = { el, f: n => $(`[data-f="${n}"]`, el), ovw: $('canvas.ovw', el), ovImg: null, peaks: null };
    const act = (a, fn) => $(`[data-a="${a}"]`, el).addEventListener('click', fn);
    $('[data-a="play"]', el).addEventListener('click', () => playPressed(id));
    const cue = $('[data-a="cue"]', el);
    cue.addEventListener('pointerdown', e => { if (!d.loaded) return; cue.setPointerCapture(e.pointerId); d.cueDown(); saveDeckMeta(id); });
    cue.addEventListener('pointerup', () => d.cueUp()); cue.addEventListener('pointercancel', () => d.cueUp());
    act('sync', () => { d.syncTo(eng.decks[id === 'A' ? 'B' : 'A']); syncPitchUI(id); });
    act('kl', () => { S.keyLock = !d.keyLock; saveS(); for (const x of ['A', 'B']) eng.decks[x].setKeyLock(S.keyLock); });
    act('q', e => { d.quantize = !d.quantize; e.currentTarget.classList.toggle('on', d.quantize); });
    act('range', () => { d.range = d.range === 0.08 ? 0.16 : d.range === 0.16 ? 0.5 : 0.08; d.setPitch(d.rate - 1); syncPitchUI(id); });
    u.f('pitch').addEventListener('input', e => { d.setPitch(Number(e.target.value) * d.range); });
    u.f('pitch').addEventListener('dblclick', () => { d.setPitch(0); syncPitchUI(id); });
    for (const [a, b] of [['nd', 0.96], ['nu', 1.04]]) {
      const btn = $(`[data-a="${a}"]`, el);
      btn.addEventListener('pointerdown', e => { btn.setPointerCapture(e.pointerId); d.bend = b; d.applyRate(); });
      const up = () => { d.bend = 1; d.applyRate(); }; btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up);
    }
    const loopIdx = () => LOOPS.indexOf(d.loop.beats);
    act('lhalf', () => d.resizeLoop(LOOPS[Math.max(0, loopIdx() - 1)]));
    act('ldouble', () => d.resizeLoop(LOOPS[Math.min(LOOPS.length - 1, loopIdx() + 1)]));
    act('loop', () => { if (!d.loaded) return; d.loop.on ? d.exitLoop() : d.setLoop(d.loop.beats); });
    $$('[data-h]', el).forEach(b => {
      let timer = null, long = false; const i = Number(b.dataset.h);
      b.addEventListener('pointerdown', () => { long = false; timer = setTimeout(() => { long = true; d.hotCue(i, true); saveDeckMeta(id); }, 500); });
      b.addEventListener('pointerup', () => { clearTimeout(timer); if (!long) hotPressed(id, i); });
      b.addEventListener('pointerleave', () => clearTimeout(timer));
      b.addEventListener('contextmenu', e => e.preventDefault());
    });
    const grid = fn => () => { if (!d.loaded) return; fn(); saveDeckMeta(id, true); };
    act('g-', grid(() => { d.firstBeat -= 0.01; }));
    act('g+', grid(() => { d.firstBeat += 0.01; }));
    act('down', grid(() => { const bar = 4 * d.beatLen, p = d.pos(); d.firstBeat = ((p % bar) + bar) % bar; d.hot[0] = d.gridPos(p, 4, 'round'); }));
    act('q1here', grid(() => { d.hot[0] = d.gridPos(d.pos(), 4, 'round'); }));
    act('b/2', grid(() => { d.bpm /= 2; }));
    act('b*2', grid(() => { d.bpm *= 2; }));
    u.f('bpmEdit').addEventListener('change', grid(() => { const v = Number(u.f('bpmEdit').value); if (v >= 40 && v <= 250) d.bpm = v; }));
    u.ovw.addEventListener('pointerdown', e => { if (!d.loaded) return; const r = u.ovw.getBoundingClientRect(); d.seek((e.clientX - r.left) / r.width * d.duration); });
    el.addEventListener('dragover', e => e.preventDefault());
    el.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); document.body.classList.remove('dragging');
      const added = addFiles(await filesFromDrop(e.dataTransfer)); if (added[0] && !d.playing) { if (roleOf(id) === 'next') pinnedNext = added[0]; loadDeck(id, added[0]); }
    });
    d.onended = () => { if (roleOf(id) === 'now' && !AM.on) toast('Track ended'); renderList(); };
  }
  const q1Of = d => d.hot[0] != null ? d.hot[0] : d.firstBeat;
  function playPressed(id) {
    const d = eng.decks[id]; if (!d.loaded) { ensureNowLoaded().then(() => d.loaded && playPressed(id)); return; }
    if (d.playing) { d.pause(); return; }
    if (roleOf(id) === 'next' && D('now').playing) { dropNext(0, false); return; }    // NEXT deck: drop it on the 1
    if (roleOf(id) === 'next') swapRoles();
    eng.setXfader(id === 'A' ? 0 : 1); $('#xfader').value = String(eng.xfPos);
    d.play(); afterUserPlay(); ensureNext();
  }
  function hotPressed(id, i) {
    const d = eng.decks[id];
    if (roleOf(id) === 'next' && D('now').playing && d.hot[i] != null) { dropNext(i, false); return; }
    d.hotCue(i, false); saveDeckMeta(id);
    if (d.playing && roleOf(id) === 'next' && !D('now').playing) swapRoles();
  }
  async function ensureNowLoaded() {
    const N = D('now'); if (N.loaded) return;
    const t = tracks.find(x => !x.played) || tracks[0]; if (t) await loadDeck(R.now, t);
    ensureNext();
  }
  function syncPitchUI(id) {
    const d = eng.decks[id], u = UI[id];
    $('[data-a="range"]', u.el).textContent = '±' + Math.round(d.range * 100) + '%';
    u.f('pitch').value = String((d.rate - 1) / d.range);
  }
  function saveDeckMeta(id, edited) {
    const d = eng.decks[id]; if (!d.track) return;
    const m = META[d.track.key] = Object.assign(META[d.track.key] || {}, { bpm: d.bpm, firstBeat: d.firstBeat, key: d.key, cue: d.cue, hot: d.hot, duration: d.duration });
    if (edited) m.edited = true;
    d.track.meta = m; saveMeta(); renderList();
  }

  const loading = {};
  async function loadDeck(id, track) {
    const d = eng.decks[id], u = UI[id];
    if (d.playing) return false;
    loading[id] = track; u.f('title').textContent = 'Loading ' + track.name + '…';
    try {
      await eng.klReady;
      const buf = await ctx.decodeAudioData(await track.file.arrayBuffer());
      const r = await DJ.analyze(buf);
      if (loading[id] !== track) return false;
      const old = META[track.key] || {};
      const m = old.edited ? old : Object.assign({}, old, { bpm: r.bpm, firstBeat: r.firstBeat, q1: r.q1, key: r.key, duration: buf.duration });
      if (!m.hot) m.hot = [null, null, null, null];
      if (m.hot[0] == null) m.hot[0] = m.q1 != null ? m.q1 : m.firstBeat;           // Q1 = first downbeat, always
      if (m.cue == null) m.cue = m.hot[0];
      META[track.key] = m; track.meta = m; track.status = 'ready'; saveMeta();
      d.load(buf, track, m);
      u.peaks = r; u.endPos = trailingEnd(r, buf.duration);
      u.f('title').textContent = track.name; u.f('bpmEdit').value = d.bpm.toFixed(2);
      syncPitchUI(id); drawOverview(id); renderList(); mediaMeta();
      return true;
    } catch (e) { u.f('title').textContent = 'Could not load ' + track.name; console.warn(e); return false; }
    finally { if (loading[id] === track) loading[id] = null; }
  }
  function trailingEnd(r, dur) { const p = r.peaks; let i = p.length - 1; while (i > 0 && p[i] < 0.02) i--; return Math.min(dur, (i + 1) / r.peakRate); }

  /* ---------------------------------------------------------------- NEXT ON THE 1 */
  let pendingCut = null, pendingDrop = null;
  // Start the NEXT deck from hot cue `cueIdx` exactly on the NOW deck's next downbeat, switch the crossfader to it there,
  // and (withCut) kill every effect on that same downbeat. Then the roles swap and the following track loads.
  function dropNext(cueIdx = 0, withCut = true) {
    const O = D('now'), I = D('next');
    if (!I.loaded) { toast('Nothing loaded on the NEXT deck yet'); return; }
    if (pendingDrop) { if (withCut) cutAll(false); return; }
    if (AM.plan) cancelPlan(true);
    const start = I.hot[cueIdx] != null ? I.hot[cueIdx] : q1Of(I);
    const now = ctx.currentTime;
    const T = O.playing ? (O.nextDownbeat(0.06) || now + 0.05) : now + 0.05;
    const bO = O.playing ? O.effBpm(T) : I.bpm, bI = I.bpm, close = Math.abs(bI / bO - 1) <= S.maxStretch / 100;
    I.bend = 1;
    if (O.playing && close && S.dropTempo !== 'native') {
      I.rate = bO / bI; I.play(T, start);
      if (S.dropTempo === 'glide' && Math.abs(bO - bI) > 0.01) {
        const ease = u => u * u * (3 - 2 * u), dur = S.glideBeats * 60 / ((bO + bI) / 2), pts = [];
        for (let k = 1; k <= 24; k++) pts.push({ t: T + dur * k / 24, r: (bO + (bI - bO) * ease(k / 24)) / bI });
        I.rampRate(pts); I.rate = 1;
      }
    } else { I.rate = 1; I.play(T, start); }
    eng.setXfader(I.id === 'A' ? 0 : 1, T);
    if (withCut) { eng.fx.cutAll(T); pendingCut = { T, deck: I }; }
    pendingDrop = { T, O, I };
    const ms = Math.max(0, (T - ctx.currentTime) * 1000);
    setTimeout(() => {
      pendingDrop = null; swapRoles(); $('#xfader').value = String(eng.xfPos); renderFx(); afterUserPlay();
      setTimeout(() => {
        if (O.playing) O.pause();
        O.rate = 1; O.bend = 1; syncPitchUI(O.id); syncPitchUI(I.id);
        if (pinnedNext === I.track) pinnedNext = null;
        if (I.track) I.track.played = true;
        if (O.track) O.track.played = true;
        ensureNext(); renderList();
      }, 300);
    }, ms);
    renderFx();
  }

  /* ---------------------------------------------------------------- waveforms: overview per deck + the audio roll */
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  function fit(c) { const w = Math.round(c.clientWidth * DPR), h = Math.round(c.clientHeight * DPR); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; return true; } return false; }
  const COL = { now: '#33d17a', next: '#ffd23f' };
  function drawOverview(id) {
    const u = UI[id], c = u.ovw; fit(c);
    const g = c.getContext('2d'), W = c.width, H = c.height; g.clearRect(0, 0, W, H);
    if (!u.peaks || !W || !H) { u.ovImg = null; return; } // hidden canvas (phone mode): nothing to draw
    const P = u.peaks.peaks, PL = u.peaks.peaksLow, n = P.length;
    for (let x = 0; x < W; x++) {
      const a = Math.floor(x / W * n), b = Math.max(a + 1, Math.floor((x + 1) / W * n)); let m = 0, ml = 0;
      for (let i = a; i < b; i++) { if (P[i] > m) m = P[i]; if (PL[i] > ml) ml = PL[i]; }
      g.fillStyle = '#4b5663'; g.fillRect(x, H / 2 - m * H / 2, 1, m * H);
      g.fillStyle = '#8fa3b8'; g.fillRect(x, H / 2 - ml * H / 2, 1, ml * H);
    }
    u.ovImg = g.getImageData(0, 0, W, H);
  }
  function overviewPlayhead(id, now) {
    const u = UI[id], d = eng.decks[id]; if (fit(u.ovw)) drawOverview(id);
    const o = u.ovw.getContext('2d'); if (u.ovImg) o.putImageData(u.ovImg, 0, 0); else o.clearRect(0, 0, u.ovw.width, u.ovw.height);
    if (!d.loaded) return;
    const ox = d.pos(now) / d.duration * u.ovw.width; o.fillStyle = 'rgba(0,0,0,.45)'; o.fillRect(0, 0, ox, u.ovw.height); o.fillStyle = '#fff'; o.fillRect(ox, 0, 2, u.ovw.height);
    if (d.hot[0] != null) { o.fillStyle = '#7b61ff'; o.fillRect(d.hot[0] / d.duration * u.ovw.width, 0, 2, u.ovw.height); }
  }
  // The roll: NOW on top, NEXT below. x is real time; NEXT is drawn where it will play if dropped on the marked downbeat.
  function drawRoll(now) {
    const c = $('#roll'); fit(c);
    const g = c.getContext('2d'), W = c.width, H = c.height, h = H / 2, cx = W * 0.38;
    g.clearRect(0, 0, W, H); g.fillStyle = '#07090b'; g.fillRect(0, 0, W, H);
    const O = D('now'), I = D('next');
    const ref = O.loaded ? O : I.loaded ? I : null;
    if (!ref) { g.fillStyle = '#8a96a3'; g.font = (14 * DPR) + 'px system-ui'; g.fillText('Add tracks to the playlist, then press PLAY', 16 * DPR, H / 2); return; }
    const secs = 8 * 60 / (ref.effBpm(now) || 120), pps = W / secs;
    let tDrop = null;
    if (pendingDrop) tDrop = pendingDrop.T; else if (O.playing) tDrop = O.nextDownbeat(0.06);
    const drawLane = (d, y0, col, posAt, label) => {
      const u = UI[d.id];
      if (!d.loaded || !u.peaks) { g.fillStyle = '#8a96a3'; g.font = (12 * DPR) + 'px system-ui'; g.fillText(label + ': empty', 10 * DPR, y0 + 18 * DPR); return; }
      const P = u.peaks.peaks, PL = u.peaks.peaksLow, pr = u.peaks.peakRate, mid = y0 + h / 2;
      for (let x = 0; x < W; x++) {
        const p0 = posAt(x), p1 = posAt(x + 1); if (p1 < 0 || p0 >= d.duration) continue;
        const i0 = Math.max(0, Math.floor(p0 * pr)), i1 = Math.max(i0 + 1, Math.floor(p1 * pr)); let m = 0, ml = 0;
        for (let i = i0; i < i1 && i < P.length; i++) { if (P[i] > m) m = P[i]; if (PL[i] > ml) ml = PL[i]; }
        g.globalAlpha = x < cx ? 0.45 : 1;
        g.fillStyle = '#5d6a78'; g.fillRect(x, mid - m * h * 0.46, 1, m * h * 0.92);
        g.fillStyle = col; g.fillRect(x, mid - ml * h * 0.46, 1, ml * h * 0.92);
      }
      g.globalAlpha = 1;
      const bl = d.beatLen, pL = posAt(0), pR = posAt(W);
      for (let k = Math.ceil((pL - d.firstBeat) / bl); ; k++) {
        const p = d.firstBeat + k * bl; if (p > pR) break;
        const x = (p - pL) / (pR - pL) * W, bar = ((k % 4) + 4) % 4 === 0;
        g.fillStyle = bar ? 'rgba(255,59,71,.85)' : 'rgba(255,255,255,.18)'; g.fillRect(Math.round(x), y0 + (bar ? 0 : h * 0.82), bar ? 2 : 1, bar ? h : h * 0.18);
      }
      d.hot.forEach((q, i) => { if (q == null) return; const x = (q - pL) / (pR - pL) * W; if (x < 0 || x > W) return; g.fillStyle = '#7b61ff'; g.fillRect(x - 1, y0, 3, h); g.font = 'bold ' + (11 * DPR) + 'px monospace'; g.fillText('Q' + (i + 1), x + 4, y0 + h - 6 * DPR); });
      if (d.loop.on) { const a = (d.loop.start - pL) / (pR - pL) * W, b = (d.loop.end - pL) / (pR - pL) * W; g.fillStyle = 'rgba(255,210,63,.12)'; g.fillRect(a, y0, b - a, h); }
      g.font = 'bold ' + (12 * DPR) + 'px system-ui'; g.fillStyle = col;
      g.fillText(label + ' · ' + d.track.name + ' · ' + d.effBpm(now).toFixed(1) + ' BPM · ' + DJ.keyLabel(d.key), 10 * DPR, y0 + 16 * DPR);
    };
    const rO = O.rateAt(now), pO = O.pos(now);
    drawLane(O, 0, COL.now, x => pO + (x - cx) / pps * rO, 'NOW');
    if (I.playing && I.anchorT <= now) { const rI = I.rateAt(now), pI = I.pos(now); drawLane(I, h, COL.next, x => pI + (x - cx) / pps * rI, 'NEXT'); }
    else {
      const close = I.bpm && Math.abs(I.bpm / (O.effBpm(now) || I.bpm) - 1) <= S.maxStretch / 100;
      const xD = tDrop ? cx + (tDrop - now) * pps : cx, rI = (O.playing && close && S.dropTempo !== 'native') ? O.effBpm(now) / I.bpm : 1;
      const q = I.playing ? I.anchorPos : q1Of(I);
      drawLane(I, h, COL.next, x => q + (x - xD) / pps * rI, 'NEXT');
    }
    if (tDrop) {
      const x = cx + (tDrop - now) * pps; g.setLineDash([6 * DPR, 4 * DPR]); g.strokeStyle = pendingDrop ? '#33d17a' : '#ffd23f'; g.lineWidth = 2 * DPR;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.setLineDash([]);
      g.fillStyle = g.strokeStyle; g.font = 'bold ' + (11 * DPR) + 'px monospace'; g.fillText(pendingDrop ? 'DROP' : 'next 1', x + 4, h - 6 * DPR);
    }
    g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(0, h - 1, W, 2);
    g.fillStyle = '#fff'; g.fillRect(cx - 1, 0, 2, H);
  }

  /* ---------------------------------------------------------------- mixer UI */
  const trimDb = v => Math.pow(10, v / 20), eqDb = v => v <= -25 ? -60 : v;
  function buildMixer() {
    const m = $('#mixer');
    m.innerHTML = `<span class="lbl">Mixer</span><div class="strips">${['A', 'B'].map(id => `
      <div class="strip" data-s="${id}"><span class="tag">${id}</span><span class="srole" data-srole="${id}"></span>
        <div data-k="trim"></div><span class="led" data-clip="${id}" title="Channel clip"></span>
        <div data-k="hi"></div><div data-k="mid"></div><div data-k="lo"></div>
        <div class="fmrow"><input type="range" class="vfader" min="0" max="1" step="0.001" value="1" data-fader="${id}" aria-label="Channel ${id} fader"><div class="meter"><i data-meter="${id}"></i></div></div>
      </div>`).join('')}</div>
      <div class="xf"><span class="lbl">Crossfader</span><input type="range" id="xfader" min="0" max="1" step="0.001" value="0.5" aria-label="Crossfader"></div>`;
    for (const id of ['A', 'B']) {
      const d = eng.decks[id], s = $(`[data-s="${id}"]`, m);
      knob($('[data-k="trim"]', s), { label: 'Gain', min: -12, max: 12, value: 0, def: 0, fmt: v => (v > 0 ? '+' : '') + v.toFixed(0), onInput: v => DJ.glide(d.trim.gain, trimDb(v), ctx) });
      for (const [k, node] of [['hi', d.hi], ['mid', d.mid], ['lo', d.lo]])
        knob($(`[data-k="${k}"]`, s), { label: k, min: -26, max: 6, value: 0, def: 0, fmt: v => v <= -25 ? 'kill' : v.toFixed(0), onInput: v => DJ.glide(node.gain, eqDb(v), ctx) });
      $(`[data-fader="${id}"]`, m).addEventListener('input', e => { const v = Number(e.target.value); DJ.glide(d.fader.gain, v * v, ctx, 0.005); });
    }
    $('#xfader').addEventListener('input', e => eng.setXfader(Number(e.target.value)));
    knob($('#masterKnob'), { label: 'Level', min: 0, max: 1.2, value: S.master, def: 0.9, fmt: dB, onInput: v => { DJ.glide(eng.master.gain, v, ctx); S.master = v; saveS(); } });
  }

  /* ---------------------------------------------------------------- FX UI */
  const SHAPES = ['lfo', 'swish', 'dive'];
  const FXP = {
    filter: [{ k: 'pos', label: 'LPF·HPF', min: -1, max: 1, def: 0.5, fmt: v => v < -0.02 ? 'LP' : v > 0.02 ? 'HP' : '—' }, { k: 'res', label: 'Res', min: 0, max: 1, def: 0.3 }],
    autofilter: [{ k: 'shape', label: 'Shape', list: SHAPES, def: 'swish' }, { k: 'div', label: 'Length', div: true, def: '1' }],
    flanger: [{ k: 'amount', label: 'Mix', min: 0, max: 1, def: 0.7 }, { k: 'div', label: 'Rate', div: true, def: '2' }],
    crush: [{ k: 'bits', label: 'Bits', min: 2, max: 10, def: 5, fmt: v => Math.round(v) }],
    trans: [{ k: 'div', label: 'Chop', div: true, def: '1/8' }],
    echo: [{ k: 'amount', label: 'Mix', min: 0, max: 1, def: 0.6 }, { k: 'div', label: 'Time', div: true, def: '3/4' }, { k: 'feedback', label: 'Fdbk', min: 0, max: 0.92, def: 0.55 }],
    reverb: [{ k: 'amount', label: 'Mix', min: 0, max: 1, def: 0.5 }, { k: 'size', label: 'Size', min: 0.8, max: 6, def: 3, fmt: v => v.toFixed(1) + 's' }],
    noise: [{ k: 'amount', label: 'Level', min: 0, max: 0.6, def: 0.25 }, { k: 'tone', label: 'Tone', min: 0, max: 1, def: 0.3 }],
  };
  const DIVK = Object.keys(DJ.DIVS);
  const divLabel = k => DJ.DIVS[k] >= 4 ? k + (k === '1' ? ' bar' : ' bars') : k;
  function applyParam(s, k, v) {
    if (k === 'amount') s.setAmount(v);
    else if (k === 'div') { s.params.div = v; s.sync && s.sync(eng.fx.bpm); }
    else if (k === 'shape') s.params.shape = v;
    else if (k === 'pos' || k === 'res') { s.params[k] = v; if (s.on) s.apply(ctx.currentTime, 0.03); }
    else if (k === 'bits') { s.params.bits = Math.round(v); s.setBits(Math.round(v)); }
    else if (k === 'feedback') { s.params.feedback = v; DJ.glide(s.fb.gain, v, ctx); }
    else if (k === 'size') { if (Math.abs(v - s.params.size) > 0.15) s.setSize(v); }
    else if (k === 'tone') s.setTone(v);
  }
  function buildFx() {
    const rack = $('#fxrack'); rack.innerHTML = '';
    for (const s of eng.fx.stages) {
      const saved = S.fx[s.id] || {};
      s.armed = !!saved.armed;
      const card = document.createElement('div'); card.className = 'fx'; card.dataset.fx = s.id;
      card.innerHTML = `<span class="name">${s.name}</span><div class="kr"></div><div class="btns"><button class="arm" aria-pressed="false">ARM</button><button class="fire" aria-pressed="false">FIRE</button></div>`;
      const kr = $('.kr', card);
      for (const p of FXP[s.id]) {
        const holder = document.createElement('div'); kr.appendChild(holder);
        const start = saved[p.k] ?? s.params[p.k] ?? p.def;
        if (p.div || p.list) {
          const L = p.list || DIVK, i = Math.max(0, L.indexOf(start));
          knob(holder, { label: p.label, min: 0, max: L.length - 1, value: i, def: L.indexOf(p.def), fmt: v => p.div ? divLabel(L[Math.round(v)]) : L[Math.round(v)],
            onInput: v => { const dv = L[Math.round(v)]; applyParam(s, p.k, dv); saveFx(s, p.k, dv); } });
          applyParam(s, p.k, L[i]);
        } else {
          knob(holder, { label: p.label, min: p.min, max: p.max, value: start, def: p.def, fmt: p.fmt, onInput: v => { applyParam(s, p.k, v); saveFx(s, p.k, v); } });
          applyParam(s, p.k, start);
        }
      }
      $('.arm', card).addEventListener('click', () => { s.armed = !s.armed; saveFx(s, 'armed', s.armed); renderFx(); });
      $('.fire', card).addEventListener('click', () => { eng.fx.fire(s.id, !s.on); renderFx(); });
      rack.appendChild(card);
    }
    $$('#route button').forEach(b => b.addEventListener('click', () => setRoute(b.dataset.r === S.route ? null : b.dataset.r)));
    setRoute(S.route);
    $('#fireAll').addEventListener('click', fireAll);
    $('#dropNext').addEventListener('click', () => dropNext(0, true));
    $('#cutAll').addEventListener('click', () => cutAll(false));
    $('#cutNow').addEventListener('click', () => cutAll(true));
    renderFx();
  }
  eng.fx.oncut = () => renderFx();
  function saveFx(s, k, v) { (S.fx[s.id] = S.fx[s.id] || {})[k] = v; saveS(); }
  function setRoute(r) {
    S.route = r; saveS();
    eng.fx.setRoute(r === 'now' || r === 'next' ? R[r] : r);
    $$('#route button').forEach(b => b.classList.toggle('on', b.dataset.r === r));
  }
  function renderFx() {
    for (const s of eng.fx.stages) {
      const c = $(`[data-fx="${s.id}"]`); if (!c) continue;
      c.classList.toggle('armed', s.armed); c.classList.toggle('live', s.on);
      const a = $('.arm', c), f = $('.fire', c);
      a.classList.toggle('on', s.armed); a.setAttribute('aria-pressed', String(s.armed));
      f.classList.toggle('on', s.on); f.setAttribute('aria-pressed', String(s.on)); f.textContent = s.on ? 'ON' : 'FIRE';
    }
  }
  function fireAll() {
    if (!eng.fx.stages.some(s => s.armed)) { toast('Arm some effects first'); return; }
    eng.fx.fireAll(); renderFx();
  }

  /* -- CUT ALL: on the next downbeat of the incoming track (the NEXT deck if it's started or scheduled, else NOW), or now -- */
  function cutAll(now) {
    if (pendingCut && pendingCut.T > ctx.currentTime && !now) now = true;   // second press while counting down = cut now
    const N = D('next'), d = N.playing ? N : D('now').playing ? D('now') : null;
    let T = ctx.currentTime + 0.005;
    if (!now && d) { const t = d.nextDownbeat(0.03); if (t) T = t; }
    if (pendingDrop && !now) T = pendingDrop.T;                             // pressed with NEXT ON THE 1: same downbeat
    if (AM.plan) cancelPlan(true);
    eng.fx.cutAll(T);
    if (d && d === N && !pendingDrop) eng.setXfader(N.id === 'A' ? 0 : 1, T);
    pendingCut = { T, deck: d };
    renderFx();
  }

  /* -- BPM readout, tap tempo, beat LED -- */
  let tapTimes = [], tapBpm = null, tapPhase = 0;
  $('#tapBtn').addEventListener('click', () => {
    const t = ctx.currentTime; tapTimes = tapTimes.filter(x => t - x < 3).concat(t);
    if (tapTimes.length >= 2) { tapBpm = 60 / ((tapTimes[tapTimes.length - 1] - tapTimes[0]) / (tapTimes.length - 1)); tapPhase = t; $('#autoBpmBtn').classList.remove('on'); }
  });
  $('#autoBpmBtn').addEventListener('click', e => { tapBpm = null; e.currentTarget.classList.add('on'); });
  const leadDeck = () => D('now').playing ? D('now') : D('next').playing ? D('next') : null;

  /* ---------------------------------------------------------------- sampler UI */
  function buildPads() {
    const box = $('#pads'); box.innerHTML = '';
    eng.sampler.pads.forEach((p, i) => {
      const b = document.createElement('button'); b.innerHTML = `<span>${esc(p.name)}</span><small>${i + 1}</small>`;
      let timer = null;
      b.addEventListener('pointerdown', () => { eng.sampler.hit(i); flash(b); timer = setTimeout(() => pickPad(i), 600); });
      b.addEventListener('pointerup', () => clearTimeout(timer)); b.addEventListener('pointerleave', () => clearTimeout(timer));
      b.addEventListener('contextmenu', e => { e.preventDefault(); pickPad(i); });
      b.addEventListener('dragover', e => e.preventDefault());
      b.addEventListener('drop', async e => { e.preventDefault(); e.stopPropagation(); document.body.classList.remove('dragging'); const f = e.dataTransfer.files[0]; if (f) { await eng.sampler.loadPad(i, f); buildPads(); } });
      box.appendChild(b);
    });
  }
  const flash = b => { if (!b) return; b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 110); };
  let padTarget = 0;
  function pickPad(i) { padTarget = i; $('#padIn').click(); }
  $('#padIn').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { await eng.sampler.loadPad(padTarget, f); buildPads(); } e.target.value = ''; });

  /* ---------------------------------------------------------------- playlist UI */
  function renderList() {
    const box = $('#plist'); if (!box) return; box.innerHTML = '';
    const lk = D('now').key, nt = nextTarget();
    tracks.forEach((t, i) => {
      const m = t.meta, on = deckOf(t), role = on ? roleOf(on) : null, r = document.createElement('div');
      const isNow = role === 'now', isNext = role === 'next' || (!on && t === nt);
      r.className = 'trk' + (isNow && eng.decks[on].playing ? ' playing' : '') + (t.played && !on ? ' played' : '') + (isNext ? ' next' : '');
      r.draggable = true;
      const good = m && lk && !isNow && DJ.keyDistance(m.key, lk) <= 1;
      r.innerHTML = `<span class="tn">${isNow ? '<span class="badge now">NOW</span>' : isNext ? '<span class="badge next">NEXT</span>' : ''}${i + 1}. ${esc(t.name)}</span>
        <span class="tb"><button data-pn title="Play this next">Next</button><button data-up aria-label="Move up">↑</button></span>
        <span class="tm">${m ? m.bpm.toFixed(1) + ' BPM · <span class="' + (good ? 'good' : '') + '">' + DJ.keyLabel(m.key) + '</span> · ' + fmtT(m.duration) : t.status}${t.played ? ' · played' : ''}</span>`;
      $('[data-pn]', r).addEventListener('click', () => { pinnedNext = t; t.played = false; renderList(); ensureNext(); });
      $('[data-up]', r).addEventListener('click', () => { if (i > 0) { tracks.splice(i, 1); tracks.splice(i - 1, 0, t); renderList(); ensureNext(); } });
      r.addEventListener('dblclick', () => { pinnedNext = t; t.played = false; ensureNext(); });
      r.addEventListener('dragstart', e => e.dataTransfer.setData('text/djfx', String(t.id)));
      r.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('text/djfx')) e.preventDefault(); });
      r.addEventListener('drop', e => { const id = Number(e.dataTransfer.getData('text/djfx')); if (!id) return; e.preventDefault(); e.stopPropagation(); moveTrack(id, i); });
      box.appendChild(r);
    });
    if (!tracks.length) box.innerHTML = '<p class="hint" style="margin:auto">Drop tracks or folders here (or anywhere on the page)</p>';
  }
  function moveTrack(id, idx) {
    const i = tracks.findIndex(t => t.id === id); if (i < 0) return;
    const [t] = tracks.splice(i, 1); tracks.splice(i < idx ? idx - 1 : idx, 0, t); renderList(); ensureNext();
  }
  $('#openFiles').addEventListener('click', () => $('#fileIn').click());
  $('#openFolder').addEventListener('click', () => $('#dirIn').click());
  for (const id of ['#fileIn', '#dirIn']) $(id).addEventListener('change', e => { addFiles([...e.target.files].sort((a, b) => a.name.localeCompare(b.name))); e.target.value = ''; });
  $('#clearLib').addEventListener('click', () => { const keep = tracks.filter(t => deckOf(t)); tracks.length = 0; tracks.push(...keep); pinnedNext = null; renderList(); });
  // Key sort: keep what's playing first, then chain the rest by harmonic distance (circle of fifths), then tempo
  $('#keySort').addEventListener('click', () => {
    const cur = D('now').track, ready = tracks.filter(t => t.meta && t !== cur && !t.played), rest = tracks.filter(t => !ready.includes(t) && t !== cur);
    if (ready.length < 2) { toast('Wait for the analysis to finish'); return; }
    let at = cur && cur.meta ? cur : ready[0]; const chain = [], left = new Set(ready);
    if (at === ready[0]) { chain.push(at); left.delete(at); }
    while (left.size) {
      let best = null, bs = 1e9;
      for (const t of left) {
        let db = Math.abs(t.meta.bpm - at.meta.bpm); db = Math.min(db, Math.abs(t.meta.bpm * 2 - at.meta.bpm), Math.abs(t.meta.bpm / 2 - at.meta.bpm));
        const s = DJ.keyDistance(at.meta.key, t.meta.key) * 4 + db / 3; if (s < bs) { bs = s; best = t; }
      }
      chain.push(best); left.delete(best); at = best;
    }
    const played = rest.filter(t => t.played), unready = rest.filter(t => !t.played);
    tracks.length = 0; tracks.push(...played, ...(cur ? [cur] : []), ...chain, ...unready);
    pinnedNext = null; renderList(); ensureNext(); toast('Sorted ' + chain.length + ' tracks by key and tempo');
  });
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); if (e.dataTransfer.files.length) addFiles(await filesFromDrop(e.dataTransfer)); });

  /* ---------------------------------------------------------------- automix */
  const AM = { on: false, plan: null };
  function amStatus(s) { $('#amStatus').textContent = s; }
  $('#amBeats').value = String(S.mixBeats); $('#amTempo').value = S.tempoMode; $('#amStyle').value = S.style;
  $('#amBeats').addEventListener('change', e => { S.mixBeats = Number(e.target.value); saveS(); });
  $('#amTempo').addEventListener('change', e => { S.tempoMode = e.target.value; saveS(); });
  $('#amStyle').addEventListener('change', e => { S.style = e.target.value; saveS(); });
  $('#amToggle').addEventListener('click', () => setAutomix(!AM.on));
  $('#amNow').addEventListener('click', () => mixNow());
  function setAutomix(on) {
    AM.on = on; const b = $('#amToggle'); b.classList.toggle('on', on); b.textContent = on ? 'Automix ON' : 'Automix off';
    if (!on) { cancelPlan(false); amStatus(''); return; }
    eng.resume(); startAutomix();
  }
  async function startAutomix() {
    if (D('now').playing || D('next').playing) return;
    await ensureNowLoaded(); const O = D('now'); if (!O.loaded) { amStatus('add some tracks'); return; }
    eng.setXfader(O.id === 'A' ? 0 : 1); $('#xfader').value = String(eng.xfPos);
    O.play(ctx.currentTime + 0.05, q1Of(O)); if (O.track) O.track.played = true; afterUserPlay(); ensureNext(); renderList();
  }
  function plan(O, I, quick) {
    const now = ctx.currentTime, uO = UI[O.id];
    let mixBeats = quick ? Math.min(16, S.mixBeats) : S.mixBeats;
    const bO = O.effBpm(now), bI = I.bpm, echoOut = Math.abs(bI / bO - 1) > S.maxStretch / 100;
    const endPos = uO.endPos || O.duration, posNow = O.pos(now), bl = O.beatLen;
    let startPos;
    if (quick) startPos = O.gridPos(posNow + 0.5 * O.rateAt(now) + 0.05, 4, 'ceil');
    else {
      const phrase = 32 * bl, latest = endPos - mixBeats * bl;
      startPos = O.firstBeat + Math.floor((latest - O.firstBeat) / phrase) * phrase;
      if (startPos < posNow + 1) startPos = O.firstBeat + Math.floor((latest - O.firstBeat) / (4 * bl)) * 4 * bl;
      if (startPos < posNow + 1) { startPos = O.gridPos(posNow + 1, 4, 'ceil'); mixBeats = Math.max(4, Math.floor((endPos - startPos) / bl / 4) * 4); }
    }
    if (O.loop.on) O.exitLoop();
    const T0 = O.timeOfPos(O.rawPos(now) + (startPos - posNow)); if (T0 == null) return null;
    const p = { O, I, T0, echoOut, mixBeats, timers: [] }, outX = O.id === 'A' ? 0 : 1, inX = 1 - outX, q1 = q1Of(I);
    if (echoOut) {
      p.T1 = O.timeOfPos(O.rawPos(now) + (startPos + mixBeats * bl - posNow));
      const sw = Math.min(16, mixBeats);
      p.swellT0 = O.timeOfPos(O.rawPos(now) + (startPos + (mixBeats - sw) * bl - posNow));
      I.rate = 1; I.bend = 1; I.play(p.T1, q1);
    } else {
      const ease = u => u * u * (3 - 2 * u), est = mixBeats * 60 / ((bO + bI) / 2);
      I.bend = 1;
      if (S.tempoMode === 'snap') { I.rate = 1; I.play(T0, q1); O.rampRate([{ t: T0, r: O.rateAt(now) }, { t: T0 + 0.002, r: bI / O.bpm }]); }
      else {
        I.rate = bO / I.bpm; I.play(T0, q1);
        const ptsO = [{ t: T0, r: bO / O.bpm }], ptsI = [];
        for (let k = 1; k <= 24; k++) { const t = T0 + est * k / 24, bpm = bO + (bI - bO) * ease(k / 24); ptsO.push({ t, r: bpm / O.bpm }); ptsI.push({ t, r: bpm / I.bpm }); }
        O.rampRate(ptsO); I.rampRate(ptsI); I.rate = 1;
      }
      p.T1 = O.timeOfPos(O.rawPos(now) + (startPos + mixBeats * bl - posNow));
      if (S.style === 'blend') eng.xfRamp(outX, inX, T0, p.T1); else eng.xfRamp(outX, 0.5, T0, T0 + (p.T1 - T0) * 0.5);
    }
    if (S.amFx) swell(p);
    eng.fx.cutAll(p.T1 + 0.0005); eng.setXfader(inX, p.T1);
    const at = (t, fn) => p.timers.push(setTimeout(fn, Math.max(0, (t - ctx.currentTime) * 1000)));
    at(p.T1, () => { swapRoles(); $('#xfader').value = String(eng.xfPos); renderFx(); });
    at(p.T1 + 0.25, () => { O.pause(); O.rate = 1; O.bend = 1; syncPitchUI(O.id); syncPitchUI(I.id); if (I.track) I.track.played = true; AM.plan = null; setRoute(S.route); ensureNext(); renderList(); });
    return p;
  }
  function swell(p) {
    const fx = eng.fx, O = p.O, T0 = p.swellT0 || p.T0, T1 = p.T1, D_ = T1 - T0;
    fx.setRoute(O.id); fx.setBpm(O.effBpm(T0));
    const armed = fx.stages.filter(s => s.armed), use = armed.length ? armed.map(s => s.id) : ['filter', 'echo', 'reverb'];
    const ramp = (param, from, to, a, b, exp) => { DJ.setAt(param, from, a); exp ? param.exponentialRampToValueAtTime(to, b) : param.linearRampToValueAtTime(to, b); };
    for (const id of use) {
      const s = fx.by[id];
      if (id === 'filter') { ramp(s.hp.frequency, 10, 900, T0 + D_ * 0.25, T1 - 0.01, true); DJ.setAt(s.hp.Q, 3, T0); }
      else if (id === 'autofilter') {           // the swish takes the last bars (its Length knob), ending on the cut
        const len = (DJ.DIVS[s.params.div] || 4) * O.beatLen, a = Math.max(T0, T1 - len / O.rateAt(T1));
        p.timers.push(setTimeout(() => { s.fire(true, Math.max(a, ctx.currentTime)); renderFx(); }, Math.max(0, (a - ctx.currentTime) * 1000 - 40)));
        continue;
      }
      else if (s.kind === 'send') { const a = T0 + D_ * (id === 'noise' ? 0.6 : 0.4); DJ.setAt(s.send.gain, 1, a); ramp(s.wet.gain, 0, Math.max(0.3, s.params.amount ?? 0.5), a, T1 - 0.01, false); }
      else { const a = T0 + D_ * 0.75; DJ.setAt(s.wet.gain, 1, a); DJ.setAt(s.dry.gain, 0, a); }
      p.timers.push(setTimeout(() => { s.on = true; renderFx(); }, Math.max(0, (T0 - ctx.currentTime) * 1000)));
    }
  }
  function cancelPlan(keepFx) {
    const p = AM.plan; if (!p) return; AM.plan = null;
    p.timers.forEach(clearTimeout);
    const now = ctx.currentTime;
    if (p.I.playing && p.I.startedAt > now) { p.I.pause(); p.I.pausedPos = q1Of(p.I); }
    for (const d of [p.O, p.I]) if (d.playing) { d.rate = d.rateAt(now); d.applyRate(); }
    DJ.hold(eng.decks.A.xf.gain, now); DJ.hold(eng.decks.B.xf.gain, now);
    if (!keepFx) eng.fx.cutAll(now);
    setRoute(S.route); renderFx();
  }
  async function amTick() {
    if (!AM.on || AM.plan || AM.busy || pendingDrop) return;
    const O = D('now'), I = D('next');
    if (!O.playing) { if (!I.playing) startAutomix(); return; }
    AM.busy = true;
    try {
      await ensureNext();
      if (!I.loaded || I.playing) { amStatus(nextTarget() ? 'loading next…' : 'last track playing'); return; }
      const now = ctx.currentTime, left = (UI[O.id].endPos || O.duration) - O.pos(now);
      const need = S.mixBeats * O.beatLen / O.rateAt(now) + 40;
      if (left > need && !AM.quick) { amStatus('next: ' + I.track.name + ' in ' + fmtT((left - S.mixBeats * O.beatLen) / O.rateAt(now))); return; }
      const quick = !!AM.quick; AM.quick = false;
      AM.plan = plan(O, I, quick);
    } finally { AM.busy = false; }
  }
  function mixNow() { if (!AM.on) setAutomix(true); if (AM.plan) return; AM.quick = true; amTick(); }
  setInterval(amTick, 250);

  /* ---------------------------------------------------------------- keyboard */
  const keyName = tok => { tok = tok.trim(); if (/^[a-z]$/i.test(tok)) return 'Key' + tok.toUpperCase(); if (/^\d$/.test(tok)) return 'Digit' + tok; if (/^shift$/i.test(tok)) return 'Shift'; if (/^(ctrl|control)$/i.test(tok)) return 'Control'; if (/^alt$/i.test(tok)) return 'Alt'; return tok[0].toUpperCase() + tok.slice(1); };
  const combo = () => (S.cutKeys || 'Space+Enter').split('+').map(keyName);
  const down = new Set(); let comboFired = false;
  const norm = e => e.code === 'NumpadEnter' ? 'Enter' : /^Shift/.test(e.code) ? 'Shift' : /^Control/.test(e.code) ? 'Control' : /^Alt/.test(e.code) ? 'Alt' : e.code;
  window.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input[type=text],input[type=number],dialog')) return;
    const k = norm(e), c = combo();
    if (c.includes(k)) e.preventDefault();
    if (e.repeat) return;
    down.add(k);
    if (c.every(x => down.has(x))) { if (!comboFired) { comboFired = true; cutAll(false); } return; }
    if (c.includes(k)) return;
    const m = /^Digit([1-8])$/.exec(k); if (m) { eng.sampler.hit(Number(m[1]) - 1); flash($$('#pads button')[Number(m[1]) - 1]); return; }
    if (k === 'KeyN') dropNext(0, true); else if (k === 'KeyF') fireAll(); else if (k === 'KeyX') cutAll(true); else if (k === 'KeyM') mixNow();
  });
  window.addEventListener('keyup', e => { down.delete(norm(e)); if (!combo().every(x => down.has(x))) comboFired = false; });
  window.addEventListener('blur', () => { down.clear(); comboFired = false; });

  /* ---------------------------------------------------------------- settings */
  const dlg = $('#settings');
  $('#settingsBtn').addEventListener('click', () => {
    $('#cutKeys').value = S.cutKeys; $('#xfCurve').value = S.xfCurve; $('#maxStretch').value = S.maxStretch; $('#amFx').checked = S.amFx;
    $('#dropTempo').value = S.dropTempo; $('#glideBeats').value = String(S.glideBeats); dlg.showModal();
  });
  $('#settingsClose').addEventListener('click', () => {
    S.cutKeys = $('#cutKeys').value.trim() || 'Space+Enter'; S.xfCurve = $('#xfCurve').value; eng.xfCurve = S.xfCurve; eng.setXfader(eng.xfPos);
    S.maxStretch = clamp(Number($('#maxStretch').value) || 10, 2, 30); S.amFx = $('#amFx').checked;
    S.dropTempo = $('#dropTempo').value; S.glideBeats = Number($('#glideBeats').value) || 16; saveS(); dlg.close(); updateCutHint();
  });
  function updateCutHint() { $('#cutHint').textContent = 'NEXT ON THE 1 (N) starts the next track from Q1 on the next downbeat, cuts all FX and switches to it. CUT ALL (' + S.cutKeys + ') waits for the downbeat; press it twice, or CUT NOW, to cut straight away.'; }

  /* ---------------------------------------------------------------- car: media keys, keep screen on */
  let wake = null;
  async function afterUserPlay() {
    try { if (!wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) {}
    mediaMeta();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (eng.decks.A.playing || eng.decks.B.playing)) afterUserPlay(); });
  function mediaMeta() {
    if (!('mediaSession' in navigator)) return;
    const d = D('now'); if (!d.track) return;
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: d.track.name, artist: 'DJFX' }); } catch (e) {}
  }
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession, h = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) {} };
    h('play', () => { eng.resume(); playPressed(R.now); });
    h('pause', () => { eng.decks.A.pause(); eng.decks.B.pause(); });
    h('nexttrack', () => AM.on ? mixNow() : dropNext(0, true));
  }

  /* ---------------------------------------------------------------- render loop */
  const clipUntil = { A: 0, B: 0, M: 0 };
  function frame() {
    const now = ctx.currentTime, tms = performance.now();
    drawRoll(now);
    for (const id of ['A', 'B']) {
      const d = eng.decks[id], u = UI[id];
      overviewPlayhead(id, now);
      $('[data-a="kl"]', u.el).classList.toggle('on', d.keyLock && eng.keyLockReady);
      if (d.loaded) {
        const pos = d.pos(now), eb = d.effBpm(now);
        u.f('time').textContent = '-' + fmtT((d.duration - pos) / d.rateAt(now));
        u.f('bpm').textContent = eb.toFixed(1); u.f('pct').textContent = ((d.rateAt(now) - 1) * 100).toFixed(1) + '%';
        u.f('bpmsrc').textContent = 'BPM (track ' + d.bpm.toFixed(2) + ')';
        const other = eng.decks[id === 'A' ? 'B' : 'A'], kEl = u.f('key');
        kEl.textContent = DJ.keyLabel(d.key); kEl.classList.toggle('good', !!(other.loaded && DJ.keyDistance(d.key, other.key) <= 1));
        const bi = d.beatIndex(pos); u.f('beat').textContent = 'bar ' + (Math.floor(bi / 4) + 1) + '.' + ((((Math.floor(bi) % 4) + 4) % 4) + 1);
        const pb = $('[data-a="play"]', u.el); pb.classList.toggle('on', d.playing);
        pb.textContent = d.playing ? '❚❚ PAUSE' : roleOf(id) === 'next' && D('now').playing ? '▶ ON THE 1' : '▶ PLAY';
        $('[data-a="loop"]', u.el).classList.toggle('on', d.loop.on);
        u.f('loop').textContent = loopLabel(d.loop.beats);
        $$('[data-h]', u.el).forEach((b, i) => b.classList.toggle('set', d.hot[i] != null));
      }
      const pk = d.peak(); if (pk > 0.99) clipUntil[id] = tms + 400;
      $(`[data-clip="${id}"]`).classList.toggle('on', tms < clipUntil[id]);
      $(`[data-meter="${id}"]`).style.height = Math.min(100, Math.max(0, 100 + 100 * Math.log10(pk + 1e-6) / 2.4)) + '%';
    }
    if (eng.masterPeak() > 0.99) clipUntil.M = tms + 400;
    $('#masterClip').classList.toggle('on', tms < clipUntil.M);
    $('#limLed').classList.toggle('on', eng.limiter.reduction < -1);
    const lead = leadDeck(); let bpm = null, on = false, bar = false;
    if (tapBpm) { bpm = tapBpm; on = ((now - tapPhase) * bpm / 60) % 1 < 0.15; $('#fxBpmSrc').textContent = 'tap'; }
    else if (lead) { bpm = lead.effBpm(now); const bi = lead.beatIndex(lead.pos(now)), fr = ((bi % 1) + 1) % 1; on = fr < 0.15; bar = on && (((Math.floor(bi) % 4) + 4) % 4) === 0; $('#fxBpmSrc').textContent = roleOf(lead.id) === 'now' ? 'current' : 'next'; }
    else $('#fxBpmSrc').textContent = 'auto';
    $('#fxBpm').textContent = bpm ? bpm.toFixed(1) : '---.-';
    const led = $('#beatLed'); led.classList.toggle('on', on); led.classList.toggle('down', bar);
    if (bpm && Math.abs(bpm - eng.fx.bpm) > 0.05 && !AM.plan) eng.fx.setBpm(bpm);
    const beatsTo = T => { const d = D('now').playing ? D('now') : lead; return d ? ((T - now) * d.effBpm(now) / 60).toFixed(1) : ''; };
    const cb = $('#cutAll'), db = $('#dropNext');
    if (pendingCut && pendingCut.T > now) { cb.classList.add('pending'); cb.textContent = 'CUT in ' + beatsTo(pendingCut.T); } else { cb.classList.remove('pending'); cb.textContent = 'CUT ALL'; }
    if (pendingDrop) { db.classList.add('pending'); db.textContent = 'DROP in ' + beatsTo(pendingDrop.T); } else { db.classList.remove('pending'); db.textContent = '▶ NEXT ON THE 1'; }
    if (AM.plan) { const p = AM.plan; amStatus(now < p.T0 ? 'mix in ' + fmtT(p.T0 - now) + (p.echoOut ? ' (echo-out: tempos too far apart)' : '') : now < p.T1 ? 'mixing → ' + p.I.track.name + ' · cut in ' + (p.T1 - now).toFixed(1) + 's' : 'cut!'); }
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------------- boot */
  buildDeck('A'); buildDeck('B'); buildMixer(); buildFx(); buildPads(); applyRoles(); updateCutHint();
  $('#xfader').value = String(eng.xfPos);
  eng.klReady.then(ok => {
    $('#foot').textContent = 'Audio: ' + ctx.sampleRate + ' Hz · output latency ~' + Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000) + ' ms · key lock ' + (ok ? 'ready (KEY button on each deck)' : 'unavailable in this browser: tempo changes shift pitch');
  });
  requestAnimationFrame(frame);
  window.DJFX = { eng, tracks, addFiles, applyHint, saveMeta, loadDeck, AM, R, setAutomix, mixNow, cutAll, dropNext, S, ensureNext };
})();
