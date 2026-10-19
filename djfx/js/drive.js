// Drive mode: the default screen, for driving or playing live. Two big buttons, pressed one after the other:
//   NEXT walks a simple flow (BUILD: the filter rises for a few bars → LOOP + ECHO: hold the last bar → DROP: the
//   next track lands on the 1 at its drop, FX cut), then starts again for the new track;
//   FX MOMENT fires one tasteful random effect on the beat, from the effects picked in Pro.
// A small row has play/pause, skip ±32 bars, Auto (automix: swell + cut on the 1 unless Pro says blend), tracks and Pro.
// "Pro" shows the full deck, plus the set-and-forget settings that Drive uses. The choice is remembered.
(() => {
  const A = window.DJFX; if (!A) return;
  const $ = (s, el = document) => el.querySelector(s);
  const eng = A.eng, ctx = eng.ctx, S = A.S, DJ = window.DJ;
  const KEY = 'djfx.drive';
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  let on = saved ?? true;
  const st = { step: 'build', last: null, timers: [] };
  const MOMENTS = { echo: 'Echo throw', reverb: 'Reverb wash', filter: 'Filter dip', autofilter: 'Auto filter', trans: 'Chop', flanger: 'Flanger', crush: 'Crush', noise: 'Noise rise' };
  const KINDS = ['fractal', 'gold', 'flow'];

  const el = document.createElement('section');
  el.id = 'drive'; el.className = 'panel';
  el.innerHTML = `
    <div class="dv-track dv-now"><span class="role">NOW</span><span class="dv-t" data-p="nowT">Add tracks to start</span><span class="dv-b mono" data-p="nowB">---.-</span></div>
    <p class="dv-where mono" data-p="where"></p>
    <div class="dv-track dv-next"><span class="role">NEXT</span><span class="dv-t" data-p="nextT">—</span><span class="dv-b mono" data-p="nextB"></span></div>
    <div class="dv-big"><button data-go="next" class="dv-nextb"><b data-p="stepL">▶ PLAY</b><small data-p="stepH">start the set</small></button>
      <button data-go="moment" class="dv-moment"><b>FX MOMENT</b><small data-p="momH">a random effect, on the beat</small></button></div>
    <div class="dv-row"><button data-go="play" class="dv-play">▶</button><button data-go="pp" title="Back 32 bars, on the next bar line">« 32</button><button data-go="pn" title="Forward 32 bars, on the next bar line">32 »</button>
      <button data-go="cut" title="Cut every effect now">Cut FX</button><button data-go="auto">Auto</button><button data-go="add">+ Tracks</button><button data-go="pro">Pro ▸</button><span data-p="syn"></span></div>`;
  document.querySelector('header').after(el);

  const back = document.createElement('button');
  back.textContent = 'Drive mode'; back.id = 'driveBack';
  back.addEventListener('click', () => set(true));
  $('header .row:last-child')?.prepend(back);

  /* -- the flow -- */
  const now = () => A.D('now'), next = () => A.D('next');
  const beatTime = (d, t) => { const p = d.pos(t), nb = d.gridPos(p + 0.02 * d.rateAt(t), 1, 'ceil'); return d.timeOfPos(d.rawPos(t) + (nb - p)); };
  const later = (t, fn) => st.timers.push(setTimeout(fn, Math.max(0, (t - ctx.currentTime) * 1000 - 60)));
  function routeNow() { if (S.route !== 'now') A.setRoute('now'); }
  function build() {
    const d = now(), f = eng.fx.by.filter, T0 = d.nextDownbeat(0.05); if (!T0) return;
    routeNow();
    const T1 = d.timeOfPos(d.rawPos(T0) + S.drive.buildBars * 4 * d.beatLen) || T0 + 8;
    DJ.setAt(f.hp.frequency, 10, T0); f.hp.frequency.exponentialRampToValueAtTime(650, T1);
    DJ.setAt(f.hp.Q, 2.2, T0);
    st.step = 'loop';
  }
  function loopEcho() {
    const d = now(); routeNow();
    d.setLoop(4, 4);                                   // the bar it is in
    if (S.drive.loopEcho) { const e = eng.fx.by.echo; e.fire(true, ctx.currentTime + 0.01); A.renderFx(); }
    st.step = 'drop';
  }
  function drop() {
    const I = next(); if (!I.loaded) { A.toast('The next track is still loading'); return; }
    const c = A.UI[I.id].cues, land = S.drive.land;
    const at = land === 'drop' && c && c.drop != null ? c.drop : land === 'mixIn' && c ? c.mixIn : A.q1Of(I);
    A.dropNext(0, true, at);
    st.step = 'build';
  }
  function nextPressed() {
    eng.resume();
    if (A.pending()) return;
    if (!now().playing) { A.playPressed(A.R.now); st.step = 'build'; return; }
    if (A.AM.plan) { A.toast('Auto is mixing: turn Auto off to drive by hand'); return; }
    ({ build, loop: loopEcho, drop })[st.step]();
    sync();
  }

  /* -- FX MOMENT: one random effect on the next beat, then it lets go -- */
  function moment() {
    const d = now(); if (!d.playing) { A.toast('Press PLAY first'); return; }
    const pool = S.drive.moments.filter(id => eng.fx.by[id] && id !== st.last);
    const id = pool.length ? pool[Math.floor(Math.random() * pool.length)] : S.drive.moments[0] || 'echo';
    st.last = id; routeNow();
    const t = ctx.currentTime, T = beatTime(d, t) || t + 0.02, b = 60 / d.effBpm(t), s = eng.fx.by[id];
    const pulse = beats => { s.fire(true, T); A.renderFx(); later(T + beats * b, () => { s.fire(false, T + beats * b); A.renderFx(); }); };
    if (id === 'filter') {                               // a low-pass dip over a bar and back up over the next
      const lp = s.lp.frequency;
      DJ.setAt(lp, Math.min(22000, lp.value), T); lp.exponentialRampToValueAtTime(420, T + 4 * b); lp.exponentialRampToValueAtTime(22000, T + 8 * b);
      DJ.setAt(s.lp.Q, 2.5, T);
      later(T + 8 * b, () => s.apply(ctx.currentTime + 0.05, 0.05));
    } else if (id === 'echo') pulse(1);
    else if (id === 'reverb') pulse(2);
    else if (id === 'crush') pulse(2);
    else if (id === 'trans') pulse(4);
    else if (id === 'noise') pulse(8);
    else pulse(id === 'autofilter' ? 16 : 8);
    $('[data-p="momH"]', el).textContent = MOMENTS[id];
    if (window.NDSyn) try { NDSyn.ornament(KINDS[Math.floor(Math.random() * KINDS.length)]); } catch (e) {}
  }

  const GO = {
    next: nextPressed, moment,
    play: () => A.playPressed(A.R.now),
    pp: () => A.phraseSkip(A.R.now, -1), pn: () => A.phraseSkip(A.R.now, 1),
    cut: () => { st.timers.forEach(clearTimeout); st.timers = []; A.cutAll(true); if (st.step !== 'build' && now().loop.on) now().exitLoop(); st.step = now().loop.on ? 'drop' : 'build'; },
    auto: () => A.setAutomix(!A.AM.on),
    add: () => $('#openFiles')?.click(),
    pro: () => set(false),
  };
  el.addEventListener('click', e => { const b = e.target.closest('button[data-go]'); if (b) { GO[b.dataset.go](); sync(); } });

  /* -- Pro: the set-and-forget settings Drive uses -- */
  const ds = document.createElement('section');
  ds.id = 'driveSet'; ds.className = 'panel';
  ds.innerHTML = `<span class="lbl">Drive settings · set them once, Drive mode uses them</span>
    <div class="row"><span class="hint">FX MOMENT picks from:</span>${Object.entries(MOMENTS).map(([id, n]) => `<button data-m="${id}">${n}</button>`).join('')}</div>
    <div class="row"><label class="hint">BUILD rises over <select data-s="buildBars"><option value="4">4 bars</option><option value="8">8 bars</option><option value="16">16 bars</option></select></label>
      <label class="hint">DROP lands the next track on <select data-s="land"><option value="drop">its drop</option><option value="mixIn">its intro (mix in)</option><option value="q1">Q1</option></select></label>
      <label class="hint"><input type="checkbox" data-s="loopEcho"> echo on the loop</label>
      <label class="hint">Auto mixes with <select data-s="style"><option value="swell">a swell, then a cut on the 1</option><option value="blend">a smooth 32-bar blend</option></select></label></div>`;
  $('#fxunit').after(ds);
  function paintSet() {
    ds.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', S.drive.moments.includes(b.dataset.m)));
    $('[data-s="buildBars"]', ds).value = String(S.drive.buildBars); $('[data-s="land"]', ds).value = S.drive.land;
    $('[data-s="loopEcho"]', ds).checked = !!S.drive.loopEcho; $('[data-s="style"]', ds).value = S.style;
  }
  ds.addEventListener('click', e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    const m = S.drive.moments, i = m.indexOf(b.dataset.m);
    if (i >= 0) { if (m.length > 1) m.splice(i, 1); } else m.push(b.dataset.m);
    A.saveS(); paintSet();
  });
  ds.addEventListener('change', e => {
    const k = e.target.dataset.s; if (!k) return;
    if (k === 'style') S.style = e.target.value;
    else S.drive[k] = k === 'buildBars' ? Number(e.target.value) : k === 'loopEcho' ? e.target.checked : e.target.value;
    A.saveS();
  });
  paintSet();

  /* -- synesthesia (if the site's synesthesia.js loaded): a light show from the music -- */
  if (window.NDSyn) {
    try {
      const an = ctx.createAnalyser(); an.fftSize = 256; eng.sum.connect(an);
      NDSyn.mount(document.body, { analyser: an });
      NDSyn.toggleButton($('[data-p="syn"]', el));
    } catch (e) { console.warn('synesthesia unavailable', e); }
  }

  function set(v) {
    on = v; document.body.classList.toggle('drive', on);
    try { localStorage.setItem(KEY, JSON.stringify(on)); } catch (e) {}
    dispatchEvent(new Event('resize'));
    if (!on) paintSet();
    sync();
  }

  /* -- mirror the deck a few times a second (text and classes only) -- */
  const txt = (e, s) => { if (e && e.textContent !== s) e.textContent = s; };
  const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const STEP = { build: ['BUILD ↗', () => 'the filter rises for ' + S.drive.buildBars + ' bars'], loop: ['LOOP + ECHO', () => 'hold this bar'], drop: ['DROP ▶', () => (next().track ? next().track.name : 'next track') + ', on the 1'] };
  function sync() {
    if (!on) return;
    const n = now(), x = next(), t = ctx.currentTime, P = $('[data-p="nowT"]', el);
    if (n.track !== st.trk) { st.trk = n.track; st.step = 'build'; }   // a new track on NOW: the flow starts again
    txt(P, n.track ? n.track.name : 'Add tracks to start');
    txt($('[data-p="nowB"]', el), n.loaded ? n.effBpm(t).toFixed(1) : '---.-');
    txt($('[data-p="nextT"]', el), x.track ? x.track.name : '—');
    txt($('[data-p="nextB"]', el), x.loaded ? x.bpm.toFixed(1) : '');
    const c = n.loaded && A.UI[n.id].cues, pos = n.loaded ? n.pos(t) : 0, r = n.loaded ? n.rateAt(t) : 1;
    txt($('[data-p="where"]', el), !n.playing ? '' : n.loop.on ? 'looping · press DROP' : c && pos < c.mixOut ? 'mix out in ' + fmt((c.mixOut - pos) / r) + ' · ends in ' + fmt((c.end - pos) / r) : c ? 'past the mix out · ends in ' + fmt(Math.max(0, c.end - pos) / r) : '');
    const pd = A.pending(), playing = n.playing, nb = $('.dv-nextb', el);
    let L, H;
    if (pd) { L = 'DROP…'; H = 'on the next 1'; }
    else if (!playing) { L = '▶ PLAY'; H = n.loaded || A.tracks.length ? 'start the set' : 'add tracks first'; }
    else if (A.AM.on) { L = 'AUTO'; H = $('#amStatus')?.textContent || 'mixing by itself'; }
    else { if (st.step !== 'build' && st.step !== 'drop' && n.loop.on) st.step = 'drop'; [L] = STEP[st.step]; H = STEP[st.step][1](); }
    txt($('[data-p="stepL"]', el), L); txt($('[data-p="stepH"]', el), H);
    nb.classList.toggle('pending', !!pd); nb.dataset.step = playing ? st.step : 'play';
    const pb = $('.dv-play', el); pb.classList.toggle('on', playing); txt(pb, playing ? '❚❚' : '▶');
    const ab = $('[data-go="auto"]', el); ab.classList.toggle('on', A.AM.on); txt(ab, A.AM.on ? 'Auto on' : 'Auto');
  }
  setInterval(sync, 150);
  set(on);
  A.drive = { set, sync, st, moment, nextPressed };
})();
