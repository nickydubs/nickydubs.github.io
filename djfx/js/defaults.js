// Default playlist: when the deck opens with no tracks, load Nicky's own songs from music/playlist.json
// (served next to the app on the site). One file at a time and in order, so NOW and NEXT are ready
// first while the rest arrive. Anything dropped or opened by hand is simply added after them.
// Opened from the file system (file://) there is nothing to fetch, so it quietly does nothing.
(() => {
  const DIR = 'music/';
  async function load() {
    const app = window.DJFX;
    if (!app || app.tracks.length || location.protocol === 'file:') return;
    let list;
    try { list = (await (await fetch(DIR + 'playlist.json')).json()).tracks || []; } catch (e) { return; }
    for (const entry of list) {
      const name = typeof entry === 'string' ? entry : entry.file;
      try {
        const res = await fetch(DIR + encodeURIComponent(name));
        if (!res.ok) continue;
        const blob = await res.blob();
        const [t] = app.addFiles([new File([blob], name, { type: blob.type || 'audio/mp4' })]);
        // a known tempo from the playlist corrects the analyser only when it is clearly off (see applyHint)
        if (t && entry.bpm) { t.bpmHint = entry.bpm; if (t.meta) { app.applyHint(t); app.saveMeta(); } }
      } catch (e) { console.warn('default track skipped', name, e); }
    }
  }
  // wait a moment so a playlist dropped in straight away wins
  setTimeout(load, 300);
})();
