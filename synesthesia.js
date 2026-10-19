// Synesthesia: a light show that is the sound. One canvas over the page (pointer-events: none):
//   - every note blooms in its own colour: pitch class → hue round the wheel, octave → lightness, low notes on the
//     left and high notes on the right; drums by brightness (low thuds deep red, airy hats violet)
//   - touch a lot (a 6-second average of taps) and the whole screen slowly melts into a rotating rainbow kaleidoscope
//     made from the recent blooms; it melts back as the average drops
//   - ornaments: a fractal rainbow, a golden glow, a flowing ribbon
// Light by design: colour sprites rendered once, a fixed pool of blooms, and no work at all when off, hidden or idle
// (its own frame loop, which stops itself; NDAudio.frames never stops). Gentle on the eyes: every brightness change is
// eased (nothing strobes), and prefers-reduced-motion keeps it to the calm layer.
window.NDSyn = window.NDSyn || (() => {
	'use strict';
	const KEY = 'nd-syn', TAU = 6, MAXB = 60, HUES = 24, LIGHTS = [30, 45, 60, 75], SPR = 64, SEG = 10, SLICE = 256, A = 2 * Math.PI / SEG;
	const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
	let enabled = false;
	try { enabled = localStorage.getItem(KEY) === '1'; } catch {}
	const reduce = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
	const lite = () => !!(window.NDAudio && NDAudio.prefs.lite);
	const mounts = [], buttons = [];
	let cv = null, cx = null, W = 0, H = 0, dpr = 1, sprites = null, slice = null, sx = null, wedge = null, gold = null;
	let analyser = null, abuf = null, lev = 0, E = 0, K = 0, lastT = 0, raf = 0, last = 0;
	const pool = Array.from({ length: MAXB }, () => ({ t0: -1, x: 0, y: 0, r: 0, hi: 0, li: 0, life: 0.6, a: 0 }));
	let nb = 0;
	const orn = Array.from({ length: 4 }, () => ({ kind: '', t0: -1, dur: 0, x: 0, y: 0, w: 0, seed: 0, img: null }));
	const HSL = Array.from({ length: 72 }, (_, i) => `hsl(${i * 5},95%,62%)`);
	const stats = { frames: 0, ms: 0, max: 0 };

	// colour sprites: a soft glow per hue and lightness, drawn once
	function buildSprites() {
		sprites = [];
		for (let h = 0; h < HUES; h++) {
			const row = [];
			for (const L of LIGHTS) {
				const c = document.createElement('canvas'); c.width = c.height = SPR;
				const g = c.getContext('2d'), gr = g.createRadialGradient(SPR / 2, SPR / 2, 0, SPR / 2, SPR / 2, SPR / 2), hue = h * 360 / HUES;
				gr.addColorStop(0, `hsla(${hue},95%,${Math.min(92, L + 18)}%,1)`); gr.addColorStop(0.35, `hsla(${hue},95%,${L}%,0.55)`); gr.addColorStop(1, `hsla(${hue},95%,${L}%,0)`);
				g.fillStyle = gr; g.fillRect(0, 0, SPR, SPR); row.push(c);
			}
			sprites.push(row);
		}
		slice = document.createElement('canvas'); slice.width = slice.height = SLICE; sx = slice.getContext('2d');
	}
	function canvas() {
		if (cv) return;
		cv = document.createElement('canvas'); cv.className = 'nd-syn';
		cv.setAttribute('aria-hidden', 'true');
		Object.assign(cv.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '40', display: enabled ? 'block' : 'none' });
		document.body.append(cv); cx = cv.getContext('2d');
	}
	function fit() {
		const d = Math.min(window.devicePixelRatio || 1, lite() ? 1 : 1.5), w = Math.round(innerWidth * d), h = Math.round(innerHeight * d);
		if (w === W && h === H && d === dpr) return;
		W = cv.width = w; H = cv.height = h; dpr = d;
		const R = Math.hypot(W, H) / 2;
		wedge = new Path2D(); wedge.moveTo(0, 0); wedge.lineTo(R * 1.02, 0); wedge.lineTo(R * 1.02 * Math.cos(A), R * 1.02 * Math.sin(A)); wedge.closePath();
		gold = cx.createRadialGradient(W / 2, H * 0.55, 0, W / 2, H * 0.55, R);
		gold.addColorStop(0, 'rgba(255,214,110,0.55)'); gold.addColorStop(0.5, 'rgba(255,170,40,0.22)'); gold.addColorStop(1, 'rgba(255,140,0,0)');
	}
	const rectOf = () => { const m = mounts[mounts.length - 1]; if (!m) return null; const now = performance.now(); if (now - m.at > 500) { m.rect = m.el.getBoundingClientRect(); m.at = now; } return m.rect; };

	// ── frame loop: 30 fps (15 in Lite), stops itself when there is nothing left to draw ──
	function wake() { if (!raf && enabled && cv && !document.hidden) { lastT = 0; raf = requestAnimationFrame(loop); } }
	function loop(now) {
		raf = 0;
		if (!enabled || !cv || document.hidden) return;
		raf = requestAnimationFrame(loop);
		if (now - last < 1000 / (lite() ? 15 : 30) - 1) return;
		last = now;
		const c0 = performance.now(), alive = draw(now / 1000), ms = performance.now() - c0;
		stats.frames++; stats.ms += (ms - stats.ms) * 0.1; if (ms > stats.max) stats.max = ms;
		if (!alive) { cancelAnimationFrame(raf); raf = 0; cx.clearRect(0, 0, W, H); }
	}
	document.addEventListener('visibilitychange', wake);
	addEventListener('resize', () => { if (raf) fit(); });

	function draw(t) {
		const dt = lastT ? Math.min(0.1, t - lastT) : 0; lastT = t;
		E *= Math.exp(-dt / TAU);
		const target = reduce.matches ? 0 : clamp((E - 1.2) / 1.5, 0, 1); // about 1.2 taps a second, held, starts it
		K += (target - K) * (1 - Math.exp(-dt / 1.5));                     // and it eases in and out, never jumps
		if (analyser) {
			analyser.getByteTimeDomainData(abuf);
			let s = 0; for (let i = 0; i < abuf.length; i += 4) { const v = (abuf[i] - 128) / 128; s += v * v; }
			lev += (clamp(Math.sqrt(s * 4 / abuf.length) * 3, 0, 1) - lev) * (1 - Math.exp(-dt / 1));
		}
		fit(); cx.clearRect(0, 0, W, H);
		let alive = K > 0.002 || E > 0.05 || (analyser && lev > 0.01);
		// the dark veil that lets the kaleidoscope take the whole screen
		if (K > 0.002) { cx.globalCompositeOperation = 'source-over'; cx.globalAlpha = K * 0.55; cx.fillStyle = '#05031a'; cx.fillRect(0, 0, W, H); }
		cx.globalCompositeOperation = 'lighter';
		// calm layer: the blooms
		for (const b of pool) {
			if (b.t0 < 0) continue;
			const age = t - b.t0;
			if (age > b.life || age < 0) { if (age > b.life) b.t0 = -1; continue; }
			alive = true;
			const env = age < 0.08 ? age / 0.08 : (1 - (age - 0.08) / (b.life - 0.08)) ** 1.5, size = b.r * (0.6 + 0.7 * age / b.life) * (1 + lev * 0.4);
			cx.globalAlpha = b.a * env * (1 - K * 0.6);
			cx.drawImage(sprites[b.hi][b.li], b.x - size / 2, b.y - size / 2, size, size);
		}
		if (K > 0.002) kaleido(t, dt);
		for (const o of orn) if (o.t0 >= 0) { if (t - o.t0 > o.dur) o.t0 = -1; else { alive = true; ornDraw(o, t); } }
		cx.globalAlpha = 1; cx.globalCompositeOperation = 'source-over';
		return alive;
	}
	// kaleidoscope: blooms and three drifting seeds paint a small slice with trails; ten mirrored wedges of it fill the screen
	function kaleido(t, dt) {
		sx.globalCompositeOperation = 'destination-out'; sx.globalAlpha = 1 - Math.exp(-dt / 0.9); sx.fillRect(0, 0, SLICE, SLICE);
		sx.globalCompositeOperation = 'lighter';
		const shift = Math.floor(t * 2), k = SLICE / Math.max(W, H) * 2;
		for (const b of pool) {
			if (b.t0 < 0) continue;
			const age = t - b.t0; if (age < 0 || age > b.life) continue;
			const s = b.r * k * 1.4; sx.globalAlpha = 0.5 * b.a * (1 - age / b.life);
			sx.drawImage(sprites[(b.hi + shift) % HUES][b.li], b.x / W * SLICE - s / 2, b.y / H * SLICE - s / 2, s, s);
		}
		for (let i = 0; i < 3; i++) {
			const a = t * (0.21 + i * 0.07) + i * 2.1, s = 70 + 30 * Math.sin(t * 0.3 + i);
			sx.globalAlpha = 0.22; sx.drawImage(sprites[(shift + i * 8) % HUES][2], SLICE * (0.45 + 0.3 * Math.cos(a)) - s / 2, SLICE * (0.45 + 0.3 * Math.sin(a * 1.3)) - s / 2, s, s);
		}
		const R = Math.hypot(W, H) / 2, rot = t * 0.05 * (1 + lev);
		cx.save(); cx.translate(W / 2, H / 2); cx.globalAlpha = K * 0.9;
		for (let i = 0; i < SEG; i++) {
			cx.save(); cx.rotate(rot + i * A + (i & 1 ? A : 0)); if (i & 1) cx.scale(1, -1);
			cx.clip(wedge); cx.drawImage(slice, 0, 0, R, R); cx.restore();
		}
		cx.restore();
	}
	function ornDraw(o, t) {
		const age = t - o.t0, env = Math.min(1, age / 0.8) * Math.min(1, (o.dur - age) / 1.5);
		if (o.kind === 'gold') { cx.globalAlpha = env; cx.fillStyle = gold; cx.fillRect(0, 0, W, H); return; }
		if (o.kind === 'fractal') {
			const s = o.w * (0.8 + 0.4 * age / o.dur);
			cx.save(); cx.translate(o.x, o.y); if (!reduce.matches) cx.rotate(age * 0.25); cx.globalAlpha = env * 0.85;
			cx.drawImage(o.img, -s / 2, -s / 2, s, s); cx.restore(); return;
		}
		// flow: a rainbow ribbon drifting across the mounted area
		cx.globalAlpha = env * 0.7; cx.lineWidth = 5 * dpr; cx.lineCap = 'round';
		const n = 40, amp = o.w * 0.12, ph = reduce.matches ? 0 : age * 2;
		let px = 0, py = 0;
		for (let i = 0; i <= n; i++) {
			const x = o.x + o.w * i / n, y = o.y + Math.sin(i * 0.35 + ph + o.seed) * amp * Math.sin(Math.PI * i / n);
			if (i) { cx.strokeStyle = HSL[Math.floor(i * 1.6 + age * 8 + o.seed * 10) % 72]; cx.beginPath(); cx.moveTo(px, py); cx.lineTo(x, y); cx.stroke(); }
			px = x; py = y;
		}
	}
	const fractals = [null, null];
	function fractal(i) { // a rainbow tree, drawn once into its own canvas when it is fired
		const c = fractals[i] ||= Object.assign(document.createElement('canvas'), { width: 256, height: 256 }), g = c.getContext('2d');
		g.clearRect(0, 0, 256, 256); g.lineCap = 'round'; g.globalCompositeOperation = 'lighter';
		const spread = 0.35 + Math.random() * 0.3, hue0 = Math.random() * 360;
		const branch = (x, y, len, ang, d) => {
			const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
			g.strokeStyle = `hsla(${(hue0 + d * 40) % 360},95%,62%,0.8)`; g.lineWidth = Math.max(1, d * 0.9);
			g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
			if (d > 1) { branch(x2, y2, len * 0.72, ang - spread, d - 1); branch(x2, y2, len * 0.72, ang + spread, d - 1); }
		};
		for (let k = 0; k < 5; k++) branch(128, 128, 30, k * 2 * Math.PI / 5, 7); // five arms: a spiral flower
		return c;
	}

	function touch(x, y) {
		if (!enabled || !cv) return;
		if (!sprites) buildSprites();
		E += 1 / TAU; // a 6-second average of taps a second
		const r = rectOf(), b = pool[nb++ % MAXB];
		b.t0 = performance.now() / 1000; b.hi = Math.floor(b.t0 * 3) % HUES; b.li = 2; b.a = 0.4; b.life = 0.9; b.r = 90 * dpr;
		b.x = (x ?? (r ? r.left + Math.random() * r.width : innerWidth / 2)) * dpr; b.y = (y ?? (r ? r.top + Math.random() * r.height : innerHeight / 2)) * dpr;
		wake();
	}
	function note(hz, bright = 0.5, strength = 1) {
		if (!enabled || !cv) return;
		if (!sprites) buildSprites();
		const r = rectOf() || { left: 0, top: 0, width: innerWidth, height: innerHeight }, b = pool[nb++ % MAXB], st = clamp(strength, 0, 1.5);
		let f;
		if (hz) {
			const m = 69 + 12 * Math.log2(hz / 440), pc = ((Math.round(m) % 12) + 12) % 12, oct = Math.floor(m / 12) - 1;
			b.hi = pc * 2; b.li = oct <= 2 ? 0 : oct === 3 ? 1 : oct <= 5 ? 2 : 3; b.life = 0.75;
			f = clamp(Math.log2(hz / 40) / Math.log2(100), 0, 1); // 40 Hz on the left, 4 kHz on the right
		} else {
			const br = clamp(bright, 0, 1);
			b.hi = Math.round(br * 275 / 15) % HUES; b.li = br < 0.3 ? 0 : br < 0.6 ? 1 : br < 0.85 ? 2 : 3; b.life = 0.5;
			f = Math.random();
		}
		b.x = (r.left + r.width * (0.08 + 0.84 * f) + (Math.random() - 0.5) * 30) * dpr;
		b.y = (r.top + r.height * (0.15 + 0.7 * Math.random())) * dpr;
		b.a = 0.55 * Math.min(1, st); b.r = (26 + 70 * st) * dpr; b.t0 = performance.now() / 1000;
		wake();
	}
	function ornament(kind) {
		if (!enabled || !cv) return;
		if (!sprites) buildSprites();
		const kinds = ['fractal', 'gold', 'flow'];
		kind = kinds.includes(kind) ? kind : kinds[Math.floor(Math.random() * 3)];
		let o = orn.find(x => x.t0 < 0); if (!o) o = orn.reduce((a, x) => x.t0 < a.t0 ? x : a);
		const r = rectOf() || { left: 0, top: 0, width: innerWidth, height: innerHeight }, t = performance.now() / 1000;
		o.kind = kind; o.t0 = t; o.seed = Math.random() * 6;
		if (kind === 'gold') o.dur = 3.2;
		else if (kind === 'fractal') { o.dur = 4; o.img = fractal(orn.indexOf(o) & 1); o.w = Math.min(r.width, r.height, 420) * dpr; o.x = (r.left + r.width * (0.25 + 0.5 * Math.random())) * dpr; o.y = (r.top + r.height * (0.25 + 0.5 * Math.random())) * dpr; }
		else { o.dur = 3.5; o.x = r.left * dpr; o.w = r.width * dpr; o.y = (r.top + r.height * (0.3 + 0.4 * Math.random())) * dpr; }
		wake();
	}

	function mount(el, opts = {}) {
		canvas();
		const m = { el, rect: null, at: -1e9 };
		const down = e => touch(e.clientX, e.clientY);
		el.addEventListener('pointerdown', down, { passive: true });
		mounts.push(m);
		const h = {
			el, canvas: cv,
			setAnalyser(a) { analyser = a || null; abuf = a ? new Uint8Array(a.fftSize) : null; if (a) wake(); },
			unmount() { el.removeEventListener('pointerdown', down); const i = mounts.indexOf(m); if (i >= 0) mounts.splice(i, 1); },
		};
		if (opts.analyser) h.setAnalyser(opts.analyser);
		if (enabled && !sprites) buildSprites();
		return h;
	}
	function setEnabled(on) {
		enabled = !!on;
		try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch {}
		for (const b of buttons) { b.setAttribute('aria-pressed', String(enabled)); b.classList.toggle('is-on', enabled); }
		if (!cv) return;
		cv.style.display = enabled ? 'block' : 'none';
		if (enabled) { if (!sprites) buildSprites(); wake(); }
		else { if (raf) cancelAnimationFrame(raf); raf = 0; E = K = 0; for (const b of pool) b.t0 = -1; for (const o of orn) o.t0 = -1; if (cx) cx.clearRect(0, 0, W, H); }
	}
	let styled = false;
	function toggleButton(container) {
		if (!styled) { // zero-specificity defaults, so the host page's own button styles win
			styled = true;
			const s = document.createElement('style');
			s.textContent = ':where(.nd-syn-btn){font:inherit;font-size:.8rem;padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.2);background:transparent;color:inherit;cursor:pointer}:where(.nd-syn-btn.is-on){background:linear-gradient(90deg,#ff5f6d,#ffc371,#7dffb0,#5c74ff,#c86bff);color:#111;border-color:transparent}';
			document.head.append(s);
		}
		const b = document.createElement('button');
		b.type = 'button'; b.className = 'nd-syn-btn' + (enabled ? ' is-on' : ''); b.textContent = 'Synesthesia';
		b.setAttribute('aria-pressed', String(enabled)); b.title = 'A light show that follows the sound. Tap a lot and it melts into a kaleidoscope.';
		b.addEventListener('click', () => setEnabled(!enabled));
		buttons.push(b); container.append(b);
		return b;
	}

	return {
		mount, note, touch, ornament, toggleButton, stats,
		get enabled() { return enabled; }, set enabled(v) { setEnabled(v); },
		get level() { return { touch: E, kaleido: K, sound: lev }; },
	};
})();
