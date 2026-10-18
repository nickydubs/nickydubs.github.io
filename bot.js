// The Air Wiggler: an ASCII robot head that lives above the beat pad.
// Built to cost nothing while you play: the head (a signed-distance field raymarched into a
// character ramp, with a Sobel outline) is rendered ONCE per size. After that, each frame only
// swaps the eyes, mouth and the lamps on its saucer ring, and touches the page only when a
// character actually changed. Nods, wobbles and hit pulses are CSS transforms (GPU, no layout).
// Particles are faked inside the same character grid: at most 28 sparks, a few numbers each, so
// they add no page elements and hit() still only bumps a counter.
(() => {
	const COLS = 56, ROWS = 22, VIEW_H = 3.1; // world units visible top to bottom
	const N = COLS * ROWS, CY = -0.28;        // CY: where the head sits vertically
	const RAMP = '.,:;=+*oO#%@';
	const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
	const FPS = reduce ? 6 : 15;
	let pre = null, aspect = 0.55, ch = VIEW_H / ROWS, cw = ch * aspect;

	// Class codes → <b class="cN"> colours in the page CSS (10+ tint the lamps per pad colour).
	const C_FACE = 1, C_LIGHT = 2, C_EDGE = 3, GROUP = { x: 10, d: 11, k: 12, h: 13, b: 14, u: 15 };

	// ── The head, as one distance function (object space, y up, face looking toward -z) ──
	function sdf(x, y, z) {
		const qx = Math.abs(x) - 0.88, qy = Math.abs(y + 0.15) - 0.48, qz = Math.abs(z) - 0.53;
		const head = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - 0.2;
		const dome = Math.max(Math.hypot(x, y - 0.25, z) - 0.72, 0.3 - y);
		const k = 0.14, h = Math.max(k - Math.abs(head - dome), 0) / k;
		let d = Math.min(head, dome) - h * h * k / 4;                          // smooth union: head melts into dome
		d = Math.min(d, Math.hypot(Math.hypot(x, z) - 1.15, y - 0.55) - 0.07); // saucer ring
		d = Math.min(d, Math.hypot(Math.abs(x) - 1.12, y + 0.15, z) - 0.22);   // ear knobs
		const sy = Math.min(Math.max(y, 0.9), 1.25);
		d = Math.min(d, Math.hypot(x, y - sy, z) - 0.035);                     // antenna stalk
		return Math.min(d, Math.hypot(x, y - 1.33, z) - 0.11);                // antenna ball
	}

	// ── Mood sprites (spaces are see-through) ──
	const EYES = {
		open: ['.-.', '(@)'], wow: ['.-.', '(O)'], joy: ['   ', '/^\\'],
		hype: ['\\ /', '(*)'], sleepy: ['   ', '___'], blink: ['   ', '-=-'],
	};
	const MOUTH = { open: '\\_/', wow: 'O', joy: '\\___/', hype: '\\vVv/', sleepy: '~' };

	// ── The pre-rendered head (filled by render(), reused every frame) ──
	const baseChars = new Array(N).fill(' '), baseCls = new Uint8Array(N), mask = new Uint8Array(N);
	const lamp = new Int8Array(N).fill(-1);   // saucer-ring lamp segment 0..11 per cell, or -1
	const antenna = new Uint8Array(N);
	const chars = new Array(N), cls = new Uint8Array(N);
	// a slight three-quarter pose so the head reads as 3D while it holds still
	const YAW = 0.18, PITCH = 0.06;
	const cyw = Math.cos(YAW), syw = Math.sin(YAW), cp = Math.cos(PITCH), spi = Math.sin(PITCH);
	const R = [cyw, syw * spi, syw * cp, 0, cp, -spi, -syw, cyw * spi, cyw * cp]; // R = Ry·Rx, object → world

	function render() {
		const lum = new Float32Array(N), dx = R[6], dy = R[7], dz = R[8];
		const L = norm(-0.75, 0.6, -0.45), Lo = toObj(L), Ho = toObj(norm(L[0], L[1], L[2] - 1));
		const bound = 1.65;
		lamp.fill(-1); antenna.fill(0); mask.fill(0); baseCls.fill(0); baseChars.fill(' ');
		for (let r = 0, i = 0; r < ROWS; r++) {
			const v = (ROWS / 2 - r - 0.5) * ch;
			for (let c = 0; c < COLS; c++, i++) {
				const u = (c - COLS / 2 + 0.5) * cw, wy = v - CY, d2 = u * u + wy * wy;
				if (d2 > bound * bound) continue;
				const t0 = 3 - Math.sqrt(bound * bound - d2);
				const ox = R[0] * u + R[3] * wy + R[6] * (t0 - 3), oy = R[1] * u + R[4] * wy + R[7] * (t0 - 3), oz = R[2] * u + R[5] * wy + R[8] * (t0 - 3);
				let tt = 0, hit = false, px = 0, py = 0, pz = 0;
				for (let k = 0; k < 40 && tt < 3.4; k++) {
					px = ox + dx * tt; py = oy + dy * tt; pz = oz + dz * tt;
					const d = sdf(px, py, pz);
					if (d < 0.006) { hit = true; break; }
					tt += d;
				}
				if (!hit) continue;
				mask[i] = 1;
				const e = 0.02, a = sdf(px + e, py - e, pz - e), b = sdf(px - e, py - e, pz + e), cc = sdf(px - e, py + e, pz - e), dd = sdf(px + e, py + e, pz + e);
				const n = norm(a - b - cc + dd, -a - b + cc + dd, -a + b - cc + dd);
				const diff = Math.max(0, n[0] * Lo[0] + n[1] * Lo[1] + n[2] * Lo[2]);
				const face = Math.max(0, -(n[0] * dx + n[1] * dy + n[2] * dz));
				const spec = Math.max(0, n[0] * Ho[0] + n[1] * Ho[1] + n[2] * Ho[2]) ** 24;
				lum[i] = 0.04 + 0.5 * diff + 0.45 * (1 - face) ** 2 + 0.6 * spec;
				// pedalboard grille: faint horizontal slats across the front panel
				if (pz < -0.6 && py < -0.05 && Math.abs(px) < 0.8 && (py * 9 + 20) % 1 < 0.45) lum[i] *= 0.55;
				if (Math.hypot(px, py - 1.33, pz) < 0.14) antenna[i] = 1;
				else if (Math.abs(Math.hypot(px, pz) - 1.15) < 0.11 && Math.abs(py - 0.55) < 0.11)
					lamp[i] = Math.floor((Math.atan2(pz, px) + Math.PI) / (Math.PI * 2) * 12) % 12;
			}
		}
		// shade + cartoon outline (Sobel on the silhouette, plus strong creases in the shading)
		const M = (r, c) => r < 0 || c < 0 || r >= ROWS || c >= COLS ? 0 : mask[r * COLS + c];
		const S = (r, c) => r < 0 || c < 0 || r >= ROWS || c >= COLS ? 0 : lum[r * COLS + c];
		for (let r = 0, i = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++, i++) {
			if (!mask[i]) continue;
			const edge = !M(r - 1, c) || !M(r + 1, c) || !M(r, c - 1) || !M(r, c + 1);
			const F = edge ? M : S;
			const gx = F(r - 1, c + 1) + 2 * F(r, c + 1) + F(r + 1, c + 1) - F(r - 1, c - 1) - 2 * F(r, c - 1) - F(r + 1, c - 1);
			const gy = F(r + 1, c - 1) + 2 * F(r + 1, c) + F(r + 1, c + 1) - F(r - 1, c - 1) - 2 * F(r - 1, c) - F(r - 1, c + 1);
			if (edge || Math.hypot(gx, gy) > 2.2) { baseChars[i] = edgeChar(gx, gy); if (edge) baseCls[i] = C_EDGE; }
			else baseChars[i] = RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.floor(lum[i] * RAMP.length)))];
		}
		lastHtml = '';
	}

	// ── Live state: cheap numbers only ──
	let t = 0, energy = 0, lastHit = -99, lastBeat = -99, beats = 0, blinkUntil = 0, nextBlink = 2;
	let wowUntil = 0, pulse = 0, nod = 0, wob = 0, wobV = 0, lookX = 0, hitGroup = 'd', lastHtml = '';

	// ── Fake particles: sparks off the antenna on hits, a ripple of dots off the saucer ring on accents ──
	const SPARK = "*+x'.", MAX_SPARKS = 28, sparks = [];
	let pendHit = 0, pendRing = 0;
	function toGrid(x, y, z) {
		const wx = R[0] * x + R[1] * y + R[2] * z, wy = R[3] * x + R[4] * y + R[5] * z + CY;
		return [wx / cw + COLS / 2 - 0.5, ROWS / 2 - 0.5 - wy / ch];
	}
	function spawn(c, r, vc, vr, max, k, slow) { if (sparks.length < MAX_SPARKS) sparks.push({ c, r, vc, vr, life: 0, max, k, slow }); }
	function particles(dt, tint) {
		if (reduce) { sparks.length = 0; pendHit = pendRing = 0; return; }
		if (pendHit) {
			const [ac, ar] = toGrid(0, 1.33, 0);
			for (; pendHit > 0; pendHit--) {
				const a = Math.random() * Math.PI * 2, v = 9 + Math.random() * 11;
				spawn(ac, ar, Math.cos(a) * v, Math.sin(a) * v * 0.5 - 5, 0.45 + Math.random() * 0.35, tint, false);
			}
		}
		if (pendRing) {
			pendRing = 0;
			for (let j = 0; j < 8; j++) {
				const a = j / 8 * Math.PI * 2, [rc, rr] = toGrid(Math.cos(a) * 1.2, 0.55, Math.sin(a) * 1.2);
				spawn(rc, rr, Math.cos(a) * 7, Math.sin(a) * 1.5, 0.5, C_LIGHT, true);
			}
		}
		for (let j = sparks.length - 1; j >= 0; j--) {
			const p = sparks[j];
			p.life += dt; if (!p.slow) p.vr += 16 * dt;
			p.c += p.vc * dt; p.r += p.vr * dt;
			const c = Math.round(p.c), r = Math.round(p.r);
			if (p.life > p.max || c < 0 || c >= COLS || r < 0 || r >= ROWS) { sparks.splice(j, 1); continue; }
			const i = r * COLS + c;
			if (cls[i] === C_FACE) continue; // never paint over the eyes or mouth
			chars[i] = p.slow ? '.' : SPARK[Math.min(SPARK.length - 1, Math.floor(p.life / p.max * SPARK.length))];
			cls[i] = p.k;
		}
	}

	function mood() {
		if (t < wowUntil) return 'wow';
		if (t - lastHit < 0.45) return energy > 1.3 ? 'hype' : 'joy';
		if (energy > 1.3) return 'hype';
		if (t - lastHit > 25 && t - lastBeat > 3) return 'sleepy';
		return 'open';
	}

	function frame(dt) {
		t += dt;
		energy = Math.max(0, energy - dt * 0.35);
		pulse *= Math.exp(-dt * 9); nod *= Math.exp(-dt * 7);
		wobV += (-wob * 60 - wobV * 7) * dt; wob += wobV * dt;
		const m = mood(), sleepy = m === 'sleepy';

		// characters: the pre-rendered head, plus lamps and a face
		const lit = t - lastBeat < 0.12 || t - lastHit < 0.15;
		const tint = t - lastHit < 0.6 ? GROUP[hitGroup] : C_LIGHT;
		for (let i = 0; i < N; i++) {
			chars[i] = baseChars[i]; cls[i] = baseCls[i];
			if (antenna[i] && lit) { chars[i] = '@'; cls[i] = tint; }
			else if (lamp[i] >= 0 && (lamp[i] === beats % 12 || (m === 'hype' && lamp[i] % 3 === Math.floor(t * 12) % 3))) { chars[i] = '@'; cls[i] = tint; }
		}
		const eyes = t < blinkUntil && m !== 'joy' ? EYES.blink : EYES[m];
		for (const ex of [-0.4, 0.4]) stamp(eyes, ex, 0.02, -0.74);
		stamp([MOUTH[m]], 0, -0.4, -0.74);
		if (t > nextBlink) { blinkUntil = t + 0.13; nextBlink = t + 1.8 + Math.random() * 3.5; }
		particles(dt, tint);
		draw();

		// motion: GPU transforms only (no reflow, no re-render)
		const amp = reduce ? 0.3 : 1, sp = sleepy ? 0.35 : 1;
		const turn = amp * 4 * Math.sin(t * 0.37 * sp) + lookX * 3;               // degrees of gentle sway
		const dip = amp * 2 * Math.sin(t * 0.53 * sp) + nod * 6 + (sleepy ? 4 : 0); // px of nod
		const s = 1 + amp * 0.02 * Math.sin(t * (sleepy ? 0.9 : 1.7)) + pulse * 0.06;
		pre.style.transform = `translateY(${dip.toFixed(1)}px) rotate(${(wob * 12 + turn * 0.3).toFixed(2)}deg) scale(${s.toFixed(3)})`;
	}

	function stamp(rows, x, y, z) {
		const wx = R[0] * x + R[1] * y + R[2] * z, wy = R[3] * x + R[4] * y + R[5] * z + CY;
		const c0 = Math.round(wx / cw + COLS / 2 - 0.5), r0 = Math.round(ROWS / 2 - 0.5 - wy / ch);
		rows.forEach((row, ri) => {
			const r = r0 - (rows.length - 1) + ri, start = c0 - (row.length >> 1);
			for (let k = 0; k < row.length; k++) {
				const c = start + k, i = r * COLS + c;
				if (row[k] === ' ' || r < 0 || r >= ROWS || c < 0 || c >= COLS || !mask[i]) continue;
				chars[i] = row[k]; cls[i] = C_FACE;
			}
		});
	}
	function edgeChar(gx, gy) { // gradient → the line perpendicular to it, corrected for tall character cells
		let a = Math.atan2(gy, gx / aspect) * 180 / Math.PI;
		if (a < 0) a += 180;
		return a < 22.5 || a >= 157.5 ? '|' : a < 67.5 ? '/' : a < 112.5 ? (gy < 0 ? '_' : '-') : '\\';
	}
	function norm(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }
	function toObj(v) { return [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]]; }

	function draw() { // run-length spans; skipped entirely when nothing changed since last frame
		let html = '', run = 0, buf = '';
		const flush = () => { if (buf) html += run ? `<b class="c${run}">${buf}</b>` : buf; buf = ''; };
		for (let r = 0, i = 0; r < ROWS; r++) {
			for (let c = 0; c < COLS; c++, i++) {
				const k = chars[i] === ' ' ? run : cls[i];
				if (k !== run) { flush(); run = k; }
				buf += chars[i];
			}
			buf += '\n';
		}
		flush();
		if (html !== lastHtml) { pre.innerHTML = html; lastHtml = html; }
	}

	function fit() { // size the font so exactly COLS characters fill the width, learn the cell aspect, re-render
		const host = pre?.parentElement;
		if (!host || !host.clientWidth) return;
		const hs = getComputedStyle(host), width = host.clientWidth - parseFloat(hs.paddingLeft) - parseFloat(hs.paddingRight);
		const probe = document.createElement('span');
		probe.textContent = 'M'.repeat(40);
		probe.style.cssText = 'position:absolute;visibility:hidden;font-size:100px;white-space:pre';
		pre.append(probe);
		const ratio = probe.getBoundingClientRect().width / 4000;
		probe.remove();
		const lh = parseFloat(getComputedStyle(pre).lineHeight) / parseFloat(getComputedStyle(pre).fontSize) || 1;
		const a = ratio / lh;
		const tall = innerHeight * 0.22 / ROWS; // never let the bot eat more than ~22% of the screen height
		pre.style.fontSize = Math.min(13, tall, Math.floor(width / (COLS * ratio) * 10) / 10).toFixed(1) + 'px';
		if (Math.abs(a - aspect) > 0.005 || !mask.some(Boolean)) { aspect = a; cw = ch * aspect; render(); }
	}

	let raf = 0, last = 0, acc = 0;
	function loop(now) {
		raf = requestAnimationFrame(loop);
		const dt = Math.min(0.1, (now - (last || now)) / 1000);
		last = now; acc += dt;
		if (acc < 1 / FPS - 0.004) return;
		frame(acc); acc = 0;
	}

	window.wiggler = {
		mount(el) {
			pre = el;
			pre.style.willChange = 'transform';
			pre.style.transformOrigin = '50% 60%';
			new ResizeObserver(fit).observe(el.parentElement);
			el.closest('dialog')?.addEventListener('pointermove', e => {
				const b = el.getBoundingClientRect();
				lookX = Math.max(-1, Math.min(1, (e.clientX - b.left - b.width / 2) / b.width * 2));
			}, { passive: true });
		},
		start() { if (!pre || raf) return; fit(); wowUntil = t + 1.1; last = 0; raf = requestAnimationFrame(loop); },
		stop() { cancelAnimationFrame(raf); raf = 0; },
		hit(group = 'd', strength = 1) { // numbers only: the next frame picks them up
			energy = Math.min(2, energy + 0.22 * strength);
			lastHit = t; hitGroup = group; pulse = Math.min(1, pulse + 0.6 * strength);
			wobV += (Math.random() - 0.5) * 3 * strength;
			pendHit = Math.min(8, pendHit + 3 + Math.round(strength * 2));
		},
		beat(accent) { beats++; lastBeat = t; nod = accent ? 1 : 0.5; if (accent) pendRing = 1; },
	};
})();
