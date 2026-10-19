// Phone mode: one screen with only what a drive needs. NOW and NEXT, big PLAY and NEXT ON THE 1,
// four armable FX with FIRE ALL and CUT ALL, automix and adding tracks. Every button here presses
// the matching control of the full deck (still on the page, just hidden), so both modes stay in
// step and the engine needs no changes. "Pro" shows the full deck; the choice is remembered.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const KEY = 'djfx.phone';
  const FX = [['filter', 'Filter'], ['autofilter', 'Auto filter'], ['echo', 'Echo'], ['reverb', 'Reverb']];
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  let on = saved ?? matchMedia('(max-width: 720px)').matches;

  const ph = document.createElement('section');
  ph.id = 'phone'; ph.className = 'panel';
  ph.innerHTML = `
    <div class="ph-track ph-now"><span class="role">NOW</span><span class="ph-t" data-p="nowT">Add tracks to start</span><span class="ph-b mono" data-p="nowB">---.-</span></div>
    <div class="ph-track ph-next"><span class="role">NEXT</span><span class="ph-t" data-p="nextT">—</span><span class="ph-b mono" data-p="nextB"></span></div>
    <div class="ph-main"><button data-go="play" class="ph-play">▶ PLAY</button><button data-go="drop" class="ph-drop">▶ NEXT ON THE 1</button></div>
    <div class="ph-skip"><button data-go="pp" title="Back 32 bars, on the next bar line">« 32 bars</button><button data-go="pn" title="Forward 32 bars, on the next bar line">32 bars »</button></div>
    <div class="ph-loop"><button data-lp="lhalf" aria-label="Shorter loop">◀</button><button data-lp="loop" class="ph-lp">LOOP <span data-p="loopL">1 beat</span></button><button data-lp="ldouble" aria-label="Longer loop">▶</button><button data-go="kick" class="ph-kick" title="Back into the song on the next bar, with the high-pass on">OUT · HPF</button></div>
    <div class="ph-fx">${FX.map(([id, name]) => `<div class="ph-fxc" data-fxp="${id}"><span class="name">${name}${id === 'autofilter' ? ' <button class="ph-len" data-len="1" title="Auto filter cycle length: tap to change">8 bars</button>' : ''}</span><button data-arm="${id}">ARM</button><button data-fire="${id}">FIRE</button></div>`).join('')}</div>
    <div class="ph-cut"><button data-go="fireAll">FIRE ALL</button><button data-go="cutAll" class="ph-cutall">CUT ALL</button></div>
    <div class="ph-foot"><button data-go="am">Automix off</button><button data-go="add">+ Tracks</button><button data-go="pro">Pro ▸</button></div>`;
  document.querySelector('header').after(ph);

  const back = document.createElement('button');
  back.textContent = 'Phone mode'; back.id = 'phoneBack';
  back.addEventListener('click', () => set(true));
  $('header .row:last-child')?.prepend(back);

  const nowDeck = () => $('.deck.now') || $('#deckA');
  const nextDeck = () => $('.deck.next') || $('#deckB');
  const press = el => el && el.click();
  const GO = {
    play: () => press($('[data-a="play"]', nowDeck())),
    drop: () => press($('#dropNext')),
    fireAll: () => press($('#fireAll')),
    cutAll: () => press($('#cutAll')),
    am: () => press($('#amToggle')),
    add: () => press($('#openFiles')),
    pro: () => set(false),
    kick: () => window.DJFX?.kickOut(($('.deck.now') || $('#deckA')).id.slice(-1)),
    pp: () => window.DJFX?.phraseSkip(nowDeck().id.slice(-1), -1),
    pn: () => window.DJFX?.phraseSkip(nowDeck().id.slice(-1), 1),
  };
  ph.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.go) GO[b.dataset.go]();
    else if (b.dataset.lp) press($(`[data-a="${b.dataset.lp}"]`, nowDeck()));
    else if (b.dataset.len) window.DJFX?.swishLen(1);
    else if (b.dataset.arm) press($(`[data-fx="${b.dataset.arm}"] .arm`));
    else if (b.dataset.fire) press($(`[data-fx="${b.dataset.fire}"] .fire`));
    sync();
  });

  function set(v) {
    on = v; document.body.classList.toggle('phone', on);
    try { localStorage.setItem(KEY, JSON.stringify(on)); } catch (e) {}
    dispatchEvent(new Event('resize')); // let the canvases re-measure after the layout change
    sync();
  }

  // Mirror the full deck's state into the phone panel a few times a second (text and classes only).
  const txt = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };
  function sync() {
    if (!on) return;
    const n = nowDeck(), x = nextDeck();
    txt($('[data-p="nowT"]', ph), $('[data-f="title"]', n)?.textContent || '—');
    txt($('[data-p="nowB"]', ph), $('[data-f="bpm"]', n)?.textContent || '');
    txt($('[data-p="nextT"]', ph), $('[data-f="title"]', x)?.textContent || '—');
    txt($('[data-p="nextB"]', ph), $('[data-f="bpm"]', x)?.textContent || '');
    const playing = $('[data-a="play"]', n)?.classList.contains('on');
    $('.ph-play', ph).classList.toggle('on', !!playing);
    txt($('.ph-play', ph), playing ? '❚❚ PAUSE' : '▶ PLAY');
    $('.ph-drop', ph).classList.toggle('pending', !!$('#dropNext')?.classList.contains('pending'));
    $('.ph-cutall', ph).classList.toggle('pending', !!$('#cutAll')?.classList.contains('pending'));
    txt($('[data-go="am"]', ph), $('#amToggle')?.textContent || 'Automix');
    $('[data-go="am"]', ph).classList.toggle('on', !!$('#amToggle')?.classList.contains('on'));
    for (const [id] of FX) {
      const card = $(`[data-fx="${id}"]`), mine = $(`[data-fxp="${id}"]`, ph);
      if (!card || !mine) continue;
      mine.classList.toggle('armed', card.classList.contains('armed'));
      mine.classList.toggle('live', card.classList.contains('live'));
      $('[data-arm]', mine).classList.toggle('on', card.classList.contains('armed'));
      $('[data-fire]', mine).classList.toggle('on', card.classList.contains('live'));
    }
    txt($('[data-p="loopL"]', ph), $('[data-f="loop"]', n)?.textContent || '');
    $('.ph-lp', ph).classList.toggle('on', !!$('[data-a="loop"]', n)?.classList.contains('on'));
    const len = $('[data-fx="autofilter"] [data-k="div"] .kv')?.textContent;
    if (len) txt($('.ph-len', ph), len);
  }
  setInterval(sync, 150);
  set(on);
})();
