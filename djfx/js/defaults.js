// Default playlist: when the deck opens with no tracks, play Nicky's own songs listed in music/playlist.json.
// The audio streams from each entry's url (Flow Music's public storage), so no song files sit in the public
// site repo. Built for phone data:
//  - only NOW and NEXT download at the start; each later song downloads when it is about to be needed;
//  - every song is kept in this browser's cache after its first download, so it never costs data again;
//  - "Save songs offline" downloads the rest ahead of time (do it on Wi-Fi).
// Anything dropped or opened by hand is simply added after them. From file:// there is nothing to fetch.
(() => {
  const DIR = 'music/', CACHE = 'djfx-songs-v1', START = 2, AHEAD = 3; // NOW + NEXT at first; once playing, keep one spare
  let list = [], idx = 0, busy = false, app = null;
  const nameOf = e => typeof e === 'string' ? e : e.file;
  // a playlist entry streams from its own url (Flow Music's storage) or falls back to a file next to the app
  const url = e => (typeof e === 'object' && e.url) || DIR + encodeURIComponent(nameOf(e));

  async function cached(entry) {
    try { return await (await caches.open(CACHE)).match(url(entry)); } catch (e) { return null; }
  }
  async function getBlob(entry) {
    const u = url(entry);
    try {
      const c = await caches.open(CACHE);
      let r = await c.match(u);
      if (!r) { r = await fetch(u); if (!r.ok) return null; await c.put(u, r.clone()); }
      return await r.blob();
    } catch (e) { // no Cache Storage (old browser, private mode): plain fetch
      const r = await fetch(u); return r.ok ? r.blob() : null;
    }
  }

  async function addNext() {
    if (idx >= list.length) return;
    const entry = list[idx++], name = nameOf(entry);
    try {
      const blob = await getBlob(entry);
      if (!blob) return;
      const [t] = app.addFiles([new File([blob], name, { type: blob.type || 'audio/mp4' })]);
      // a known tempo from the playlist corrects the analyser only when it is clearly off (see applyHint)
      if (t && entry.bpm) { t.bpmHint = entry.bpm; if (t.meta) { app.applyHint(t); app.saveMeta(); } }
    } catch (e) { console.warn('default track skipped', name, e); }
    paint();
  }
  async function topUp() { // once music plays, download the next song only when fewer than AHEAD unplayed tracks are left
    if (busy || !app || idx >= list.length) return;
    if (!Object.values(app.eng.decks).some(d => d.playing)) return;
    if (app.tracks.filter(t => !t.played).length >= AHEAD) return;
    busy = true; await addNext(); busy = false;
  }

  // ── "Save songs offline" button (phone panel and the full deck's playlist bar) ──
  const btns = [];
  async function savedCount() { let n = 0; for (const e of list) if (await cached(e)) n++; return n; }
  async function paint(note) {
    if (!btns.length) return;
    const n = await savedCount(), all = n === list.length;
    btns.forEach(b => { b.textContent = note || (all ? '✓ Songs saved on this device' : `⬇ Save songs offline (${n}/${list.length} saved · use Wi-Fi)`); b.disabled = all || !!note; });
  }
  async function saveAll() {
    let i = 0;
    for (const e of list) { i++; paint(`Saving ${i}/${list.length}…`); await getBlob(e); }
    paint();
  }
  function addButtons() {
    if (!('caches' in window)) return;
    const mk = cls => { const b = document.createElement('button'); b.className = cls; b.addEventListener('click', saveAll); btns.push(b); return b; };
    document.querySelector('#phone')?.append(mk('ph-save'));
    document.querySelector('#openFiles')?.parentElement?.append(mk('save-off'));
    paint();
  }

  async function load() {
    app = window.DJFX;
    if (!app || app.tracks.length || location.protocol === 'file:') return;
    try { list = (await (await fetch('music/playlist.json')).json()).tracks || []; } catch (e) { return; }
    addButtons();
    for (let k = 0; k < START; k++) await addNext();   // NOW and NEXT
    setInterval(topUp, 2000);
  }
  // wait a moment so a playlist dropped in straight away wins
  setTimeout(load, 300);
})();
