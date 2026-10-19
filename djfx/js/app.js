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
  const DEF = { cutKeys: 'Space+Enter', mixBars: 32, style: 'swell', maxStretch: 10, xfCurve: 'smooth', amFx: true,
    route: 'now', fx: {}, master: 0.9, dropTempo: 'glide', glideBeats: 16, keyLock: true };
  const S = Object.assign({}, DEF, store.get('djfx.settings', {}));
  if (S.route === 'A' || S.route === 'B') S.route = 'now';
  if (!S.am2) { S.style = 'blend'; S.mixBars = 32; delete S.mixBeats; delete S.tempoMode; S.am2 = true; }   // automix v2: phrase blends by default
  if (!S.am3) { S.style = 'swell'; S.am3 = true; }   // Drive: swell + cut on the 1 by default (Nicky liked it better); the blend is in Pro
  S.drive = Object.assign({ moments: ['echo', 'reverb', 'filter', 'autofilter'], buildBars: 8, land: 'drop', loopEcho: true }, S.drive || {});
  const META = store.get('djfx.tracks', {});
  const saveS = () => store.set('djfx.settings', S), saveMeta = () => store.set('djfx.tracks', META);
  const fmtT = s => { if (!isFinite(s)) return '--:--'; s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 1800); }

  const eng = new DJ.Engine(); const ctx = eng.ctx;
  const unlock = () => eng.resume();
  window.addEventListener('pointerdown', unlock, { capture: true }); window.addEventListener('keydown', unlock, { capture: true });
  eng.xfCurve = S.xfCurve; eng.setMaster(S.master);
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
  // One button that steps through a list instead of a pair of arrows: tap = next, long-press or Shift-click = back
  function cycler(el, o) {
    el.classList.add('cyc');
    el.innerHTML = '<button type="button" class="cyb" title="Tap for the next one; long-press or Shift-click to go back"></button>' + (o.label ? '<span class="kl">' + o.label + '</span>' : '');
    const b = $('.cyb', el); let i = clamp(o.value, 0, o.list.length - 1), long = false, timer = 0;
    const set = (ni, emit = true) => { i = ((Math.round(ni) % o.list.length) + o.list.length) % o.list.length; b.textContent = o.fmt ? o.fmt(o.list[i]) : o.list[i]; if (emit && o.onInput) o.onInput(i); };
    b.addEventListener('pointerdown', () => { long = false; timer = setTimeout(() => { long = true; set(i - 1); }, 500); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(timer));
    b.addEventListener('click', e => { if (long) { long = false; return; } set(e.shiftKey ? i - 1 : i + 1); });
    b.addEventListener('contextmenu', e => e.preventDefault());
    set(i, false);
    return { set, get: () => i, el: b };
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
  const LOOPS = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64];   // loop lengths in beats, 1/16 note to 16 bars
  const loopLabel = b => b < 1 ? '1/' + Math.round(1 / b) : b < 4 ? b + (b === 1 ? ' beat' : ' beats') : (b / 4) + (b === 4 ? ' bar' : ' bars');
  const UI = {};
  function buildDeck(id) {
    const d = eng.decks[id], el = $('#deck' + id);
    el.innerHTML = `
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><span class="role">NOW</span><span class="tag" style="font-size:14px">${id}</span><span class="title" data-f="title" style="flex:1">Empty: add tracks to the playlist</span><span class="mono" data-f="time">--:--</span></div>
      <div class="readout"><span class="bpm" data-f="bpm">---.-</span><span class="lbl" data-f="bpmsrc">BPM</span><span class="key" data-f="key">—</span><span data-f="pct">0.0%</span><span class="lbl" data-f="beat"></span></div>
      <canvas class="ovw"></canvas>
      <div class="transport"><button data-a="pp" title="Back 32 bars, on the next bar line ([)">« 32</button><button data-a="cue">CUE</button><button data-a="play" class="btn-play">▶ PLAY</button><button data-a="sync">SYNC</button><button data-a="pn" title="Forward 32 bars, on the next bar line (])">32 »</button></div>
      <div class="hot">${[0, 1, 2, 3].map(i => `<button data-h="${i}" title="Tap: set or jump (on the NEXT deck: drop it on the 1). Long-press: delete">Q${i + 1}</button>`).join('')}</div>
      <div class="loop"><span data-f="lcyc"></span><button data-a="loop">LOOP</button><button data-a="kick" title="Leave the loop on its next bar line, straight back into the song, with the high-pass filter on">OUT · HPF</button></div>
      <div class="pitch"><input type="range" min="-1" max="1" step="0.0005" value="0" data-f="pitch" aria-label="Pitch"><div class="row"><button data-a="nd" title="Nudge slower (hold)">−</button><button data-a="nu" title="Nudge faster (hold)">+</button></div></div>
      <details class="gridbox"><summary>More: key lock, pitch range, beat grid</summary><div class="grid-edit"><button data-a="kl" title="Key lock: tempo changes keep the pitch">KEY LOCK</button><button data-a="q" class="on" title="Quantize cues and loops to the beat grid">QUANTIZE</button><button data-a="range" title="Pitch range">±8%</button><button data-a="g-">◀ 10ms</button><button data-a="g+">10ms ▶</button><button data-a="down">Set downbeat here</button><button data-a="q1here">Q1 = first downbeat</button><button data-a="b/2">BPM ÷2</button><button data-a="b*2">BPM ×2</button><input type="number" step="0.01" min="40" max="250" data-f="bpmEdit" style="width:84px" aria-label="Track BPM"></div></details>`;
    const u = UI[id] = { el, f: n => $(`[data-f="${n}"]`, el), ovw: $('canvas.ovw', el), ovImg: null, peaks: null };
    const act = (a, fn) => $(`[data-a="${a}"]`, el).addEventListener('click', fn);
    $('[data-a="play"]', el).addEventListener('click', () => playPressed(id));
    const cue = $('[data-a="cue"]', el);
    cue.addEventListener('pointerdown', e => { if (!d.loaded) return; cue.setPointerCapture(e.pointerId); d.cueDown(); saveDeckMeta(id); });
    cue.addEventListener('pointerup', () => d.cueUp()); cue.addEventListener('pointercancel', () => d.cueUp());
    act('sync', () => { d.syncTo(eng.decks[id === 'A' ? 'B' : 'A']); syncPitchUI(id); });
    act('pp', () => phraseSkip(id, -1)); act('pn', () => phraseSkip(id, 1));
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
    u.lcyc = cycler(u.f('lcyc'), { list: LOOPS, value: Math.max(0, LOOPS.indexOf(d.loop.beats)), fmt: loopLabel, onInput: i => d.resizeLoop(LOOPS[i]) });
    u.lcyc.el.dataset.f = 'loop';
    act('loop', () => { if (!d.loaded) return; d.loop.on ? d.exitLoop() : d.setLoop(d.loop.beats); });
    act('kick', () => kickOut(id));
    $$('[data-h]', el).forEach(b => {
      let timer = null, long = false; const i = Number(b.dataset.h);
      b.addEventListener('pointerdown', () => { long = false; timer = setTimeout(() => { long = true; d.hotCue(i, true); saveDeckMeta(id); }, 500); });
      b.addEventListener('pointerup', () => { clearTimeout(timer); if (!long) hotPressed(id, i); });
      b.addEventListener('pointerleave', () => clearTimeout(timer));
      b.addEventListener('contextmenu', e => e.preventDefault());
    });
    const grid = fn => () => { if (!d.loaded) return; fn(); saveDeckMeta(id, true); u.cues = DJ.cues(u.peaks, d, d.duration); drawOverview(id); };
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
    d.onended = () => { if (roleOf(id) === 'now' && !AM.on) toast('Track ended'); renderList(); paintPlay(); };
  }
  const q1Of = d => d.hot[0] != null ? d.hot[0] : d.firstBeat;
  let loadingPlay = false;
  function playPressed(id) {
    const d = eng.decks[id];
    if (!d.loaded) {                                  // load first; a second press while loading does nothing
      if (loadingPlay) return; loadingPlay = true;
      ensureNowLoaded().then(() => { loadingPlay = false; if (d.loaded && !d.playing) playPressed(id); }, () => { loadingPlay = false; });
      return;
    }
    if (pendingDrop && (pendingDrop.I === d || pendingDrop.O === d)) return;       // a drop is counting down on this deck
    if (d.playing) {
      if (AM.plan) cancelPlan(false);
      d.pause(); if (AM.on) AM.held = true; paintPlay(); mediaState(); return;
    }
    AM.held = false;
    if (roleOf(id) === 'next' && D('now').playing) { dropNext(0, false); return; }    // NEXT deck: drop it on the 1
    if (roleOf(id) === 'next') swapRoles();
    eng.setXfader(id === 'A' ? 0 : 1); $('#xfader').value = String(eng.xfPos);
    d.play(); afterUserPlay(); ensureNext(); paintPlay(); mediaState();
  }
  // Play buttons always show the deck's real state (called on every change, and every frame as a backstop)
  function paintPlay() {
    for (const id of ['A', 'B']) {
      const d = eng.decks[id], pb = $('[data-a="play"]', UI[id].el), t = d.playing ? '❚❚ PAUSE' : roleOf(id) === 'next' && D('now').playing ? '▶ ON THE 1' : '▶ PLAY';
      pb.classList.toggle('on', d.playing); if (pb.textContent !== t) pb.textContent = t;
    }
  }
  // Skip a phrase: 32 bars back or forward, landing on the next bar line so the beat never stumbles
  function phraseSkip(id, dir) {
    const d = eng.decks[id]; if (!d.loaded) return;
    const jump = dir * 32 * 4 * d.beatLen, lim = p => clamp(p, 0, Math.max(0, d.duration - 4 * d.beatLen));
    if (!d.playing) { d.pausedPos = lim(d.gridPos(d.pausedPos + jump, 4, 'round')); return; }
    const T = d.nextDownbeat(0.05) || ctx.currentTime + 0.02, at = d.pos(T);
    let to = at + jump; if (to < 0) to = d.firstBeat; to = lim(to);
    if (d.loop.on) d.exitLoop();
    d.seek(to, T);
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
      const c = DJ.cues(r, m, buf.duration);
      if (c) {
        if (m.cv !== DJ.CUES_V) {                    // first time with phrase cues: fill the empty hot cues
          if (m.hot[1] == null && c.drop != null) m.hot[1] = c.drop;
          if (m.hot[2] == null) m.hot[2] = c.mixOut;
          m.cv = DJ.CUES_V;
        }
        m.cues = { mixIn: c.mixIn, drop: c.drop, mixOut: c.mixOut, end: c.end };
      }
      META[track.key] = m; track.meta = m; track.status = 'ready'; saveMeta();
      d.load(buf, track, m);
      u.peaks = r; u.endPos = trailingEnd(r, buf.duration); u.cues = c;
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
  function dropNext(cueIdx = 0, withCut = true, startAt = null) {
    const O = D('now'), I = D('next');
    if (!I.loaded) { toast('Nothing loaded on the NEXT deck yet'); return; }
    if (pendingDrop) { if (withCut) cutAll(false); return; }
    if (AM.plan) cancelPlan(true);
    const start = startAt != null ? startAt : I.hot[cueIdx] != null ? I.hot[cueIdx] : q1Of(I);
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
  const SECCOL = { intro: '#3d4a5a', groove: '#5c74ff', drop: '#ff4f5e', break: '#34d6ff', outro: '#3d4a5a' };
  function drawOverview(id) {
    const u = UI[id], c = u.ovw; fit(c);
    const g = c.getContext('2d'), W = c.width, H = c.height; g.clearRect(0, 0, W, H);
    if (!u.peaks || !W || !H) { u.ovImg = null; return; } // hidden canvas (Drive mode): nothing to draw
    const P = u.peaks.peaks, PL = u.peaks.peaksLow, n = P.length;
    for (let x = 0; x < W; x++) {
      const a = Math.floor(x / W * n), b = Math.max(a + 1, Math.floor((x + 1) / W * n)); let m = 0, ml = 0;
      for (let i = a; i < b; i++) { if (P[i] > m) m = P[i]; if (PL[i] > ml) ml = PL[i]; }
      g.fillStyle = '#4b5663'; g.fillRect(x, H / 2 - m * H / 2, 1, m * H);
      g.fillStyle = '#8fa3b8'; g.fillRect(x, H / 2 - ml * H / 2, 1, ml * H);
    }
    const cu = u.cues, dur = eng.decks[id].duration, X = t => t / dur * W;
    if (cu) {
      cu.blocks.forEach((b, i) => { const x0 = X(b.at), x1 = i + 1 < cu.blocks.length ? X(cu.blocks[i + 1].at) : X(cu.end); g.fillStyle = SECCOL[b.type]; g.fillRect(x0, H - 3 * DPR, x1 - x0, 3 * DPR); });
      g.fillStyle = 'rgba(255,255,255,.35)'; for (const ph of cu.phrases) g.fillRect(X(ph), 0, 1, H);
      g.fillStyle = '#33d17a'; g.fillRect(X(cu.mixOut), 0, 2 * DPR, H);
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
      const cc = u.cues;
      if (cc) {
        const X = p => (p - pL) / (pR - pL) * W;
        for (const ph of cc.phrases) { const x = X(ph); if (x >= 0 && x <= W) { g.fillStyle = 'rgba(255,210,63,.9)'; g.fillRect(Math.round(x) - 1, y0, 3, h); } }
        for (const [t, lab, c2] of [[cc.mixIn, 'IN', '#9bd'], [cc.drop, 'DROP', '#ff4f5e'], [cc.mixOut, 'MIX OUT', '#33d17a'], [cc.end, 'END', '#8a96a3']]) {
          if (t == null) continue; const x = X(t); if (x < 0 || x > W) continue;
          g.fillStyle = c2; g.fillRect(x - 1, y0, 2, h); g.font = 'bold ' + (10 * DPR) + 'px monospace'; g.fillText(lab, x + 4, y0 + 30 * DPR);
        }
      }
      d.hot.forEach((q, i) => { if (q == null) return; const x = (q - pL) / (pR - pL) * W; if (x < 0 || x > W) return; g.fillStyle = '#7b61ff'; g.fillRect(x - 1, y0, 3, h); g.font = 'bold ' + (11 * DPR) + 'px monospace'; g.fillText('Q' + (i + 1), x + 4, y0 + h - 6 * DPR); });
      if (d.loop.on) { const a = (d.loop.start - pL) / (pR - pL) * W, b = (d.loop.end - pL) / (pR - pL) * W; g.fillStyle = 'rgba(255,210,63,.12)'; g.fillRect(a, y0, b - a, h); }
      g.font = 'bold ' + (12 * DPR) + 'px system-ui'; g.fillStyle = col;
      g.fillText(label + ' · ' + d.track.name + ' · ' + d.effBpm(now).toFixed(1) + ' BPM · ' + DJ.keyLabel(d.key), 10 * DPR, y0 + 16 * DPR);
    };
    const rO = O.rateAt(now), pO = O.scratch ? O.scratch.p : O.pos(now);
    drawLane(O, 0, COL.now, x => pO + (x - cx) / pps * rO, 'NOW');
    if (I.scratch && !I.playing) drawLane(I, h, COL.next, x => I.scratch.p + (x - cx) / pps, 'NEXT');
    else if (I.playing && I.anchorT <= now) { const rI = I.rateAt(now), pI = I.scratch ? I.scratch.p : I.pos(now); drawLane(I, h, COL.next, x => pI + (x - cx) / pps * rI, 'NEXT'); }
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

  // Scratch on the roll: press on a lane to grab that record (holding still stops it), drag to move it like vinyl
  // (left = forwards, right = backwards, as fast as the hand), let go to drop back on the beat
  (() => {
    const roll = $('#roll'); let sc = null;
    roll.addEventListener('pointerdown', e => {
      const r = roll.getBoundingClientRect(), d = D(e.clientY - r.top < r.height / 2 ? 'now' : 'next');
      if (!d.loaded) return;
      if (!d.scratchStart()) { toast('Scratching needs the key lock, which this browser cannot run'); return; }
      roll.setPointerCapture(e.pointerId); e.preventDefault();
      const ref = D('now').loaded ? D('now') : d, now = ctx.currentTime;
      sc = { d, x0: e.clientX, p0: d.scratch.p0, k: 8 * 60 / (ref.effBpm(now) || 120) / r.width * (d.playing ? d.rateAt(now) : 1) };
    });
    roll.addEventListener('pointermove', e => { if (sc) sc.d.scratchTo(sc.p0 + (sc.x0 - e.clientX) * sc.k); });
    const up = () => { if (sc) { sc.d.scratchEnd(); sc = null; } };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) roll.addEventListener(ev, up);
  })();

  /* ---------------------------------------------------------------- mixer UI */
  const trimDb = v => Math.pow(10, v / 20), eqDb = v => v <= -25 ? -60 : v;
  function buildMixer() {
    // compact: one row per deck (gain, EQ, fader), no meters; the master clip light covers the whole mix
    const m = $('#mixer');
    m.innerHTML = `<span class="lbl">Mixer</span>${['A', 'B'].map(id => `
      <div class="mrow" data-s="${id}"><span class="tag">${id}</span><span class="srole" data-srole="${id}"></span>
        <div data-k="trim"></div><div data-k="hi"></div><div data-k="mid"></div><div data-k="lo"></div>
        <input type="range" class="hfader" min="0" max="1" step="0.001" value="1" data-fader="${id}" aria-label="Channel ${id} fader"></div>`).join('')}
      <div class="xf"><span class="lbl">Crossfader</span><input type="range" id="xfader" min="0" max="1" step="0.001" value="0.5" aria-label="Crossfader"></div>`;
    for (const id of ['A', 'B']) {
      const d = eng.decks[id], s = $(`[data-s="${id}"]`, m);
      knob($('[data-k="trim"]', s), { label: 'Gain', min: -12, max: 12, value: 0, def: 0, fmt: v => (v > 0 ? '+' : '') + v.toFixed(0), onInput: v => DJ.glide(d.trim.gain, trimDb(v), ctx) });
      for (const [k, node] of [['hi', d.hi], ['mid', d.mid], ['lo', d.lo]])
        knob($(`[data-k="${k}"]`, s), { label: k, min: -26, max: 6, value: 0, def: 0, fmt: v => v <= -25 ? 'kill' : v.toFixed(0), onInput: v => DJ.glide(node.gain, eqDb(v), ctx) });
      $(`[data-fader="${id}"]`, m).addEventListener('input', e => { const v = Number(e.target.value); DJ.glide(d.fader.gain, v * v, ctx, 0.005); });
    }
    $('#xfader').addEventListener('input', e => eng.setXfader(Number(e.target.value)));
    knob($('#masterKnob'), { label: 'Level', min: 0, max: 1.2, value: S.master, def: 0.9, fmt: dB, onInput: v => { eng.setMaster(v); S.master = v; saveS(); } });
    if (window.NDAudio) NDAudio.clipLight(eng.out, $('#clipLed'));
  }

  /* ---------------------------------------------------------------- FX UI */
  const SWISH = ['1', '2', '4', '8', '16', '32', '64'];   // auto filter cycle lengths in bars; 8 by default so it moves gradually
  const hzFmt = v => v < 1000 ? Math.round(v) + '' : (v / 1000).toFixed(1) + 'k';
  const FXP = {
    filter: [{ k: 'pos', label: 'LPF·HPF', min: -1, max: 1, def: 0.5, fmt: v => v < -0.02 ? 'LP' : v > 0.02 ? 'HP' : '—' }, { k: 'res', label: 'Res', min: 0, max: 1, def: 0.3 }],
    autofilter: [{ k: 'lo', label: 'Low', log: [30, 16000], def: 250 }, { k: 'hi', label: 'High', log: [30, 16000], def: 6000 },
      { k: 'div', label: 'Length', div: true, list: SWISH, def: '8' }, { k: 'type', label: 'Type', list: ['LP', 'HP'], def: 'LP' }],
    flanger: [{ k: 'amount', label: 'Mix', min: 0, max: 1, def: 0.7 }, { k: 'div', label: 'Rate', div: true, def: '2' }],
    crush: [{ k: 'bits', label: 'Bits', min: 2, max: 10, def: 5, fmt: v => Math.round(v) }],
    trans: [{ k: 'div', label: 'Chop', div: true, def: '1/8' }],
    echo: [{ k: 'amount', label: 'Mix', min: 0, max: 1, def: 0.6 }, { k: 'div', label: 'Time', div: true, def: '3/4' }, { k: 'feedback', label: 'Fdbk', min: 0, max: 0.92, def: 0.55 }],
    reverb: [{ k: 'amount', label: 'Mix', min: 0, max: 1, def: 0.5 }, { k: 'size', label: 'Size', min: 0.4, max: 2, def: 1.6, fmt: v => v.toFixed(1) + 's' }],
    noise: [{ k: 'amount', label: 'Level', min: 0, max: 0.6, def: 0.25 }, { k: 'tone', label: 'Tone', min: 0, max: 1, def: 0.3 }],
  };
  const DIVK = Object.keys(DJ.DIVS).filter(k => DJ.DIVS[k] <= 16);   // echo, flanger and chop stop at 4 bars
  const knobs = {};
  const divLabel = k => DJ.DIVS[k] >= 4 ? k + (k === '1' ? ' bar' : ' bars') : k;
  function applyParam(s, k, v) {
    if (k === 'amount') s.setAmount(v);
    else if (k === 'div') { s.params.div = v; s.sync && s.sync(eng.fx.bpm); }
    else if (k === 'lo' || k === 'hi') { s.params[k] = v; s.setRange(); }
    else if (k === 'type') s.setType(v === 'HP' ? 'highpass' : 'lowpass');
    else if (k === 'pos' || k === 'res') { s.params[k] = v; if (s.on) s.apply(ctx.currentTime, 0.03); }
    else if (k === 'bits') { s.params.bits = Math.round(v); s.setBits(Math.round(v)); }
    else if (k === 'feedback') { s.params.feedback = v; DJ.glide(s.fb.gain, v, ctx); }
    else if (k === 'size') { if (Math.abs(v - s.params.size) > 0.15) s.setSize(v); }
    else if (k === 'tone') s.setTone(v);
  }
  function buildFx() {
    const rack = $('#fxrack'); rack.innerHTML = '';
    const det = document.createElement('details'); det.className = 'morefx'; det.innerHTML = '<summary>More FX: flanger, crush, trans, noise</summary><div class="fxrack"></div>';
    const more = $('.fxrack', det);
    for (const s of eng.fx.stages) {
      const saved = S.fx[s.id] || {};
      if (s.id === 'autofilter' && !saved.af2) { for (const k of ['shape', 'len8', 'div']) delete saved[k]; saved.af2 = true; S.fx[s.id] = saved; saveS(); }   // the new auto filter: 8 bars, Low to High
      s.armed = !!saved.armed;
      const card = document.createElement('div'); card.className = 'fx' + (s.id === 'autofilter' ? ' wide' : ''); card.dataset.fx = s.id;
      card.innerHTML = `<span class="name">${s.name}</span><div class="kr"></div><div class="btns"><button class="arm" aria-pressed="false">ARM</button><button class="fire" aria-pressed="false">FIRE</button></div>`;
      const kr = $('.kr', card);
      for (const p of FXP[s.id]) {
        const holder = document.createElement('div'); holder.dataset.k = p.k; kr.appendChild(holder);
        const start = saved[p.k] ?? s.params[p.k] ?? p.def;
        if (p.log) {                                   // frequency knobs turn in octaves
          const [a, b] = p.log, toV = hz => Math.log(hz / a) / Math.log(b / a), toHz = v => a * Math.pow(b / a, v);
          knob(holder, { label: p.label, min: 0, max: 1, value: toV(start), def: toV(p.def), fmt: v => hzFmt(toHz(v)), onInput: v => { applyParam(s, p.k, toHz(v)); saveFx(s, p.k, toHz(v)); } });
          applyParam(s, p.k, start);
        } else if (p.div || p.list) {
          const L = p.list || DIVK, i = Math.max(0, L.indexOf(start));
          knobs[s.id + '.' + p.k] = cycler(holder, { label: p.label, list: L, value: i, fmt: v => p.div ? divLabel(v) : v,
            onInput: j => { const dv = L[j]; applyParam(s, p.k, dv); saveFx(s, p.k, dv); } });
          applyParam(s, p.k, L[i]);
        } else {
          knob(holder, { label: p.label, min: p.min, max: p.max, value: start, def: p.def, fmt: p.fmt, onInput: v => { applyParam(s, p.k, v); saveFx(s, p.k, v); } });
          applyParam(s, p.k, start);
        }
      }
      $('.arm', card).addEventListener('click', () => { s.armed = !s.armed; saveFx(s, 'armed', s.armed); renderFx(); });
      $('.fire', card).addEventListener('click', () => { eng.fx.fire(s.id, !s.on); renderFx(); });
      (['flanger', 'crush', 'trans', 'noise'].includes(s.id) ? more : rack).appendChild(card);
    }
    rack.appendChild(det);
    $$('#route button').forEach(b => b.addEventListener('click', () => setRoute(b.dataset.r === S.route ? null : b.dataset.r)));
    setRoute(S.route);
    $('#fireAll').addEventListener('click', fireAll);
    $('#dropNext').addEventListener('click', () => dropNext(0, true));
    $('#cutAll').addEventListener('click', () => cutAll(false));
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
  // One press out of a loop: the deck jumps back into the song on the next bar line and the filter opens up as a high-pass
  function kickOut(id) {
    const d = eng.decks[id], T = d.kickOut();
    if (T == null) { toast('Loop some bars first'); return; }
    const role = R.now === id ? 'now' : 'next', f = eng.fx.by.filter;
    if (!S.route || ((S.route === 'now' || S.route === 'next') && S.route !== role)) setRoute(role);
    if (!(f.params.pos > 0.2)) f.params.pos = 0.55;   // keep a high-pass you already dialled in, otherwise about 300 Hz
    eng.fx.fire('filter', true, T);
    setTimeout(renderFx, Math.max(0, (T - ctx.currentTime) * 1000));
  }
  function swishLen(step) {   // cycle the auto filter length
    const k = knobs['autofilter.div']; if (!k) return;
    k.set((Math.round(k.get()) + step + SWISH.length) % SWISH.length);
  }
  function fireAll() {
    for (const s of eng.fx.stages) if (s.armed) s.wake && s.wake();
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
  // A DJ blend, from the tracks' own phrases: the outgoing track's MIX OUT cue (where its last drop is over) is the 1 of
  // the blend, the incoming track starts from its MIX IN cue (32 bars before its first drop) on that same downbeat.
  // Over the blend (32 bars by default) the tempo glides from one track to the other, the incoming fades up over the
  // first quarter with its bass cut, the basses swap on the halfway downbeat, and the outgoing fades over the last quarter.
  // Tempos too far apart for a blend get the swell: the outgoing builds the armed FX, then a cut to the next track on the 1.
  const AM = { on: false, plan: null, held: false };
  function amStatus(s) { const el = $('#amStatus'); if (el.textContent !== s) el.textContent = s; }
  $('#amToggle').addEventListener('click', () => setAutomix(!AM.on));
  $('#amNow').addEventListener('click', () => mixNow());
  function setAutomix(on) {
    AM.on = on; AM.held = false; const b = $('#amToggle'); b.classList.toggle('on', on); b.textContent = on ? 'Automix ON' : 'Automix off';
    if (!on) { cancelPlan(false); amStatus(''); return; }
    eng.resume(); startAutomix();
  }
  async function startAutomix() {
    if (D('now').playing || D('next').playing || AM.held) return;
    await ensureNowLoaded(); const O = D('now'); if (!O.loaded) { amStatus('add some tracks'); return; }
    eng.setXfader(O.id === 'A' ? 0 : 1); $('#xfader').value = String(eng.xfPos);
    O.play(ctx.currentTime + 0.05, O.pausedPos > q1Of(O) + 1 ? O.pausedPos : q1Of(O)); if (O.track) O.track.played = true; afterUserPlay(); ensureNext(); renderList();
  }
  // Where the blend should start on the outgoing deck (track position), and how many bars it gets
  function mixOutAt(O, quick) {
    const now = ctx.currentTime, c = UI[O.id].cues, barL = 4 * O.beatLen, pos = O.pos(now);
    const end = (c && c.end) || UI[O.id].endPos || O.duration;
    let bars = quick ? 8 : S.mixBars, at;
    if (quick) at = O.gridPos(pos + 0.4 * O.rateAt(now), 4, 'ceil');
    else {
      at = c ? c.mixOut : O.firstBeat + Math.floor((end - bars * barL - O.firstBeat) / (8 * barL)) * 8 * barL;
      if (at < pos + 0.3) at = O.gridPos(pos + 0.3 * O.rateAt(now), 4, 'ceil');      // already past it: from the next bar
      const room = Math.floor((end - at) / barL);
      if (room < bars) bars = Math.max(8, Math.floor(room / 4) * 4);
    }
    return { at, bars };
  }
  function plan(O, I, quick) {
    const now = ctx.currentTime, { at: startPos, bars } = mixOutAt(O, quick);
    const bO = O.effBpm(now), bI = I.bpm, far = Math.abs(bI / bO - 1) > S.maxStretch / 100, swell_ = far || S.style === 'swell';
    if (O.loop.on) O.exitLoop();
    const barL = 4 * O.beatLen, p0 = O.pos(now), r0 = O.rawPos(now);
    const T0 = O.timeOfPos(r0 + (startPos - p0)); if (T0 == null) return null;
    const inPos = UI[I.id].cues ? UI[I.id].cues.mixIn : q1Of(I);
    const p = { O, I, T0, echoOut: far, bars, timers: [] }, outX = O.id === 'A' ? 0 : 1, inX = 1 - outX;
    const ease = u => u * u * (3 - 2 * u);
    I.bend = 1;
    if (swell_) {
      // the outgoing plays out its bars with the FX building, then the next track lands on the 1 (tempo-matched when close)
      const nb = Math.min(bars, 16);
      p.T1 = O.timeOfPos(r0 + (startPos + nb * barL - p0)); p.swellT0 = T0;
      if (!far) {
        const bE = O.effBpm(p.T1), g = S.glideBeats * 60 / ((bE + bI) / 2), pts = [];
        I.rate = bE / bI; I.play(p.T1, inPos);
        for (let k = 1; k <= 24; k++) pts.push({ t: p.T1 + g * k / 24, r: (bE + (bI - bE) * ease(k / 24)) / bI });
        I.rampRate(pts); I.rate = 1;
      } else { I.rate = 1; I.play(p.T1, inPos); }
      swell(p);
      eng.fx.cutAll(p.T1 + 0.0005); eng.setXfader(inX, p.T1);
    } else {
      // blend: both decks glide together from one tempo to the other over the whole blend
      const est = bars * 4 * 60 / ((bO + bI) / 2), ptsO = [{ t: T0, r: bO / O.bpm }], ptsI = [];
      I.rate = bO / bI; I.play(T0, inPos);
      for (let k = 1; k <= 32; k++) { const t = T0 + est * k / 32, bpm = bO + (bI - bO) * ease(k / 32); ptsO.push({ t, r: bpm / O.bpm }); ptsI.push({ t, r: bpm / bI }); }
      O.rampRate(ptsO); I.rampRate(ptsI); I.rate = 1;
      const tb = k => O.timeOfPos(r0 + (startPos + k * barL - p0));
      p.T1 = tb(bars);
      const tIn = tb(bars / 4), tSwap = tb(bars / 2), tOut = tb(bars * 3 / 4), xo = O.xf.gain, xi = I.xf.gain;
      DJ.hold(xo, T0); DJ.hold(xi, T0);
      xi.setValueAtTime(0, T0); xi.linearRampToValueAtTime(1, tIn);
      xo.setValueAtTime(1, T0); xo.setValueAtTime(1, tOut); xo.linearRampToValueAtTime(0, p.T1);
      // the bass swap: the incoming's lows stay cut until the halfway downbeat, then the two swap in one 30 ms move
      p.loO = O.lo.gain.value; p.loI = I.lo.gain.value;
      DJ.hold(I.lo.gain, T0); I.lo.gain.setValueAtTime(-26, T0); I.lo.gain.setValueAtTime(-26, tSwap); I.lo.gain.linearRampToValueAtTime(p.loI, tSwap + 0.03);
      DJ.hold(O.lo.gain, tSwap); O.lo.gain.setValueAtTime(p.loO, tSwap); O.lo.gain.linearRampToValueAtTime(-26, tSwap + 0.03);
      p.tSwap = tSwap;
      eng.xfPos = inX; DJ.setAt(xo, 0, p.T1 + 0.001); DJ.setAt(xi, 1, p.T1 + 0.001);
    }
    const at = (t, fn) => p.timers.push(setTimeout(fn, Math.max(0, (t - ctx.currentTime) * 1000)));
    at(p.T1, () => { swapRoles(); $('#xfader').value = String(eng.xfPos); renderFx(); paintPlay(); });
    at(p.T1 + 0.25, () => {
      O.pause(); O.rate = 1; O.bend = 1; if (p.loO != null) DJ.setAt(O.lo.gain, p.loO, ctx.currentTime);
      syncPitchUI(O.id); syncPitchUI(I.id); if (I.track) I.track.played = true; AM.plan = null; setRoute(S.route); ensureNext(); renderList(); paintPlay();
    });
    return p;
  }
  function swell(p) {
    const fx = eng.fx, O = p.O, T0 = p.swellT0 || p.T0, T1 = p.T1, D_ = T1 - T0;
    fx.setRoute(O.id); fx.setBpm(O.effBpm(T0));
    if (!S.amFx) return;
    const armed = fx.stages.filter(s => s.armed), use = armed.length ? armed.map(s => s.id) : ['filter', 'echo', 'reverb'];
    const ramp = (param, from, to, a, b, exp) => { DJ.setAt(param, from, a); exp ? param.exponentialRampToValueAtTime(to, b) : param.linearRampToValueAtTime(to, b); };
    for (const id of use) {
      const s = fx.by[id]; s.wake && s.wake();
      if (id === 'filter') { ramp(s.hp.frequency, 10, 900, T0 + D_ * 0.25, T1 - 0.01, true); DJ.setAt(s.hp.Q, 3, T0); }
      else if (id === 'autofilter') s.fire(true, T0);
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
    if (p.loO != null) { DJ.setAt(p.O.lo.gain, p.loO, now); DJ.setAt(p.I.lo.gain, p.loI, now); }
    eng.setXfader(p.I.playing ? 0.5 : p.O.id === 'A' ? 0 : 1);       // mid-blend: both stay up, the crossfader in the middle
    $('#xfader').value = String(eng.xfPos);
    if (!keepFx) eng.fx.cutAll(now);
    setRoute(S.route); renderFx(); paintPlay();
  }
  async function amTick() {
    if (!AM.on || AM.plan || AM.busy || pendingDrop) return;
    const O = D('now'), I = D('next');
    if (!O.playing) { if (!I.playing && !AM.held) startAutomix(); return; }
    AM.busy = true;
    try {
      await ensureNext();
      if (!I.loaded || I.playing) { amStatus(nextTarget() ? 'loading next…' : 'last track playing'); return; }
      const now = ctx.currentTime, quick = !!AM.quick;
      if (!quick) {
        const { at } = mixOutAt(O, false), wait = (at - O.pos(now)) / O.rateAt(now);
        if (wait > 20) { amStatus('next: ' + I.track.name + ' in ' + fmtT(wait)); return; }
      }
      AM.quick = false;
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
    else if (k === 'BracketLeft') phraseSkip(R.now, -1); else if (k === 'BracketRight') phraseSkip(R.now, 1);
  });
  window.addEventListener('keyup', e => { down.delete(norm(e)); if (!combo().every(x => down.has(x))) comboFired = false; });
  window.addEventListener('blur', () => { down.clear(); comboFired = false; });

  /* ---------------------------------------------------------------- settings */
  const dlg = $('#settings');
  $('#settingsBtn').addEventListener('click', () => {
    $('#cutKeys').value = S.cutKeys; $('#xfCurve').value = S.xfCurve; $('#maxStretch').value = S.maxStretch; $('#amFx').checked = S.amFx;
    $('#amStyle').value = S.style; $('#amBars').value = String(S.mixBars);
    $('#dropTempo').value = S.dropTempo; $('#glideBeats').value = String(S.glideBeats); dlg.showModal();
  });
  $('#settingsClose').addEventListener('click', () => {
    S.cutKeys = $('#cutKeys').value.trim() || 'Space+Enter'; S.xfCurve = $('#xfCurve').value; eng.xfCurve = S.xfCurve; eng.setXfader(eng.xfPos);
    S.maxStretch = clamp(Number($('#maxStretch').value) || 10, 2, 30); S.amFx = $('#amFx').checked;
    S.style = $('#amStyle').value; S.mixBars = Number($('#amBars').value) || 32;
    S.dropTempo = $('#dropTempo').value; S.glideBeats = Number($('#glideBeats').value) || 16; saveS(); dlg.close(); updateCutHint();
  });
  function updateCutHint() { $('#cutHint').textContent = 'NEXT ON THE 1 (N) starts the next track from Q1 on the next downbeat, cuts all FX and switches to it. CUT ALL (' + S.cutKeys + ') waits for the downbeat; press it twice (or X) to cut straight away. [ and ] skip 32 bars.'; }

  /* ---------------------------------------------------------------- car: media keys, keep screen on */
  let wake = null;
  async function afterUserPlay() {
    try { if (!wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) {}
    mediaMeta();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (eng.decks.A.playing || eng.decks.B.playing)) afterUserPlay(); });
  function mediaState() { try { navigator.mediaSession.playbackState = eng.decks.A.playing || eng.decks.B.playing ? 'playing' : 'paused'; } catch (e) {} }
  function mediaMeta() {
    if (!('mediaSession' in navigator)) return;
    const d = D('now'); if (!d.track) return;
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: d.track.name, artist: 'DJFX' }); } catch (e) {}
  }
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession, h = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) {} };
    h('play', () => { eng.resume(); if (!D('now').playing) playPressed(R.now); });
    h('pause', () => { if (AM.plan) cancelPlan(false); eng.decks.A.pause(); eng.decks.B.pause(); if (AM.on) AM.held = true; paintPlay(); mediaState(); });
    h('nexttrack', () => AM.on ? mixNow() : dropNext(0, true));
  }

  /* ---------------------------------------------------------------- render loop */
  function frame() {
    const now = ctx.currentTime;
    drawRoll(now);
    for (const id of ['A', 'B']) {
      const d = eng.decks[id], u = UI[id];
      overviewPlayhead(id, now);
      $('[data-a="kl"]', u.el).classList.toggle('on', d.keyLock && eng.keyLockReady);
      $('[data-a="range"]', u.el).textContent = '±' + Math.round(d.range * 100) + '%';
      if (d.loaded) {
        const pos = d.pos(now), eb = d.effBpm(now);
        u.f('time').textContent = '-' + fmtT((d.duration - pos) / d.rateAt(now));
        u.f('bpm').textContent = eb.toFixed(1); u.f('pct').textContent = ((d.rateAt(now) - 1) * 100).toFixed(1) + '%';
        u.f('bpmsrc').textContent = 'BPM (track ' + d.bpm.toFixed(2) + ')';
        const other = eng.decks[id === 'A' ? 'B' : 'A'], kEl = u.f('key');
        kEl.textContent = DJ.keyLabel(d.key); kEl.classList.toggle('good', !!(other.loaded && DJ.keyDistance(d.key, other.key) <= 1));
        const bi = d.beatIndex(pos); u.f('beat').textContent = 'bar ' + (Math.floor(bi / 4) + 1) + '.' + ((((Math.floor(bi) % 4) + 4) % 4) + 1);
        $('[data-a="loop"]', u.el).classList.toggle('on', d.loop.on);
        const li = LOOPS.indexOf(d.loop.beats); if (li >= 0 && li !== u.lcyc.get()) u.lcyc.set(li, false);
        $$('[data-h]', u.el).forEach((b, i) => b.classList.toggle('set', d.hot[i] != null));
      }
    }
    paintPlay(); synBeat(now);
    const lead = leadDeck(); let bpm = null, on = false, bar = false;
    if (lead) { bpm = lead.effBpm(now); const bi = lead.beatIndex(lead.pos(now)), fr = ((bi % 1) + 1) % 1; on = fr < 0.15; bar = on && (((Math.floor(bi) % 4) + 4) % 4) === 0; $('#fxBpmSrc').textContent = roleOf(lead.id) === 'now' ? 'current' : 'next'; }
    else $('#fxBpmSrc').textContent = 'auto';
    $('#fxBpm').textContent = bpm ? bpm.toFixed(1) : '---.-';
    const led = $('#beatLed'); led.classList.toggle('on', on); led.classList.toggle('down', bar);
    const beatsTo = T => { const d = D('now').playing ? D('now') : lead; return d ? ((T - now) * d.effBpm(now) / 60).toFixed(1) : ''; };
    const cb = $('#cutAll'), db = $('#dropNext');
    if (pendingCut && pendingCut.T > now) { cb.classList.add('pending'); cb.textContent = 'CUT in ' + beatsTo(pendingCut.T); } else { cb.classList.remove('pending'); cb.textContent = 'CUT ALL'; }
    if (pendingDrop) { db.classList.add('pending'); db.textContent = 'DROP in ' + beatsTo(pendingDrop.T); } else { db.classList.remove('pending'); db.textContent = '▶ NEXT ON THE 1'; }
    if (AM.plan) { const p = AM.plan; amStatus(now < p.T0 ? 'mix in ' + fmtT(p.T0 - now) + (p.echoOut ? ' (tempos too far apart: swell and cut)' : ' · ' + p.bars + '-bar blend') : now < p.T1 ? 'mixing → ' + p.I.track.name + (p.tSwap ? (now < p.tSwap ? ' · bass swap in ' + (p.tSwap - now).toFixed(0) + 's' : ' · done in ' + (p.T1 - now).toFixed(0) + 's') : ' · cut in ' + (p.T1 - now).toFixed(1) + 's') : 'cut!'); }
    else if (AM.on && AM.held) amStatus('paused: press PLAY to carry on');
  }
  // Synesthesia (if loaded): one note per beat of the NOW deck, coloured by the track's own energy at that spot
  // (read from the analysis, so it costs no audio analysis while playing)
  let synLast = -1;
  function synBeat(now) {
    if (!window.NDSyn) return;
    const d = D('now'), u = UI[d.id]; if (!d.playing || !u.peaks) return;
    const pos = d.pos(now), b = Math.floor(d.beatIndex(pos)); if (b === synLast) return; synLast = b;
    const P = u.peaks, i = Math.min(P.peaks.length - 1, Math.max(0, Math.floor(pos * P.peakRate)));
    const full = P.peaks[i] || 0, low = P.peaksLow[i] || 0, bar = ((b % 4) + 4) % 4 === 0;
    try { NDSyn.note(null, clamp(1 - low / (full + 1e-6), 0, 1), clamp(full * (bar ? 1.2 : 0.8), 0, 1)); } catch (e) {}
  }
  // the FX follow the playing deck's tempo (also while the tab is hidden)
  setInterval(() => {
    const lead = leadDeck(), bpm = lead ? lead.effBpm(ctx.currentTime) : null;
    if (bpm && Math.abs(bpm - eng.fx.bpm) > 0.05 && !AM.plan) eng.fx.setBpm(bpm);
  }, 200);

  /* ---------------------------------------------------------------- boot */
  buildDeck('A'); buildDeck('B'); buildMixer(); buildFx(); buildPads(); applyRoles(); updateCutHint();
  $('#xfader').value = String(eng.xfPos);
  eng.klReady.then(ok => {
    $('#foot').textContent = 'Audio: ' + ctx.sampleRate + ' Hz · output latency ~' + Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000) + ' ms · key lock ' + (ok ? 'ready (KEY button on each deck)' : 'unavailable in this browser: tempo changes shift pitch');
  });
  if (window.NDAudio) NDAudio.frames(frame, 30); else (function loop() { frame(); requestAnimationFrame(loop); })();
  window.DJFX = { kickOut, swishLen, SWISH, phraseSkip, paintPlay, playPressed, UI, eng, tracks, addFiles, applyHint, saveMeta, loadDeck, AM, R, D, setAutomix, mixNow, cutAll, dropNext, S, saveS, ensureNext, setRoute, renderFx, toast, q1Of, pending: () => pendingDrop };
})();
