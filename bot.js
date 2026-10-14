// The Air Wiggler: an ASCII robot head that lives above the beat pad.
// Fake 3D, all math: the head is a signed-distance field (rounded box + saucer dome + ring + antenna)
// raymarched once per character cell, shaded into a character ramp, outlined with a Sobel edge-finder
// for that cartoon line, and smoothed over time so it breathes instead of flickering. Particles orbit
// it on tilted rings with spring physics; every pad hit kicks them outward in that pad's colour.
(() => {
	const COLS = 56, ROWS = 22, VIEW_H = 3.1; // world units visible top to bottom
	const N = COLS * ROWS, CY = -0.28;        // CY: where the head sits vertically
	const RAMP = '.,:;=+*oO#%@';
	const lum = new Float32Array(N), sm = new Float32Array(N), zb = new Float32Array(N);
	const mask = new Uint8Array(N), prev = new Uint8Array(N), cls = new Uint8Array(N), chars = new Array(N);
	let pre = null, aspect = 0.55, ch = VIEW_H / ROWS, cw = ch * aspect;
	const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
	const AMP = reduce ? 0.3 : 1, FPS = reduce ? 12 : 30;

	// Class codes → <b class="cN"> colours in the page CSS. 10+ are particle tints per pad colour.
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

	// ── State ──
	let t = 0, energy = 0, lastHit = -99, lastBeat = -99, beats = 0, blinkUntil = 0, nextBlink = 2;
	let wowUntil = 0, pulse = 0, nod = 0, wob = 0, wobV = 0, lookX = 0, lookY = 0, hitGroup = 'd';
	const P = [], sparks = [], rings = [];
	for (let i = 0; i < 72; i++) P.push({
		r: 1.45 + Math.random() * 0.9, a: (Math.random() - 0.5) * 2.4, b: (Math.random() - 0.5) * 1.2,
		th: Math.random() * Math.PI * 2, w: (0.35 + Math.random() * 0.7) * (Math.random() < 0.5 ? -1 : 1),
		ox: 0, oy: 0, oz: 0, vx: 0, vy: 0, vz: 0, g: 'x', gt: 0, pc: -1,
	});

	function mood() {
		if (t < wowUntil) return 'wow';
		if (t - lastHit < 0.45) return energy > 1.3 ? 'hype' : 'joy';
		if (energy > 1.3) return 'hype';
		if (t - lastHit > 25 && t - lastBeat > 3) return 'sleepy';
		return 'open';
	}

	// ── Frame ──
	function frame(dt) {
		t += dt;
		energy = Math.max(0, energy - dt * 0.35);
		pulse *= Math.exp(-dt * 9); nod *= Math.exp(-dt * 7);
		wobV += (-wob * 60 - wobV * 7) * dt; wob += wobV * dt; // springy head wobble after hits
		const m = mood(), sleepy = m === 'sleepy', sp = sleepy ? 0.35 : 1;

		// head pose: idle wander + looking at your pointer + nods/wobbles
		const yaw = AMP * (0.42 * Math.sin(t * 0.37 * sp) + 0.14 * Math.sin(t * 1.1 * sp)) + lookX * 0.35;
		const pitch = AMP * (0.1 * Math.sin(t * 0.53 * sp)) - lookY * 0.18 + nod * 0.22 + (sleepy ? 0.18 : 0);
		const roll = AMP * (0.07 * Math.sin(t * 0.29)) + wob;
		const s = 1 + AMP * 0.03 * Math.sin(t * (sleepy ? 0.9 : 1.7)) + pulse * 0.09;
		const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), spi = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
		// R = Ry·Rx·Rz (object → world); we march in object space with its transpose
		const R = [
			cyw * cr + syw * spi * sr, -cyw * sr + syw * spi * cr, syw * cp,
			cp * sr, cp * cr, -spi,
			-syw * cr + cyw * spi * sr, syw * sr + cyw * spi * cr, cyw * cp,
		];
		const dx = R[6], dy = R[7], dz = R[8];                        // world +z ray in object space
		const L = norm(-0.75, 0.6, -0.45), Lo = toObj(R, L), Ho = toObj(R, norm(L[0], L[1], L[2] - 1));
		const lit = t - lastBeat < 0.12 || t - lastHit < 0.15;
		const bound = 1.65 * s;

		// 1) raymarch every cell
		prev.set(mask);
		for (let r = 0, i = 0; r < ROWS; r++) {
			const v = (ROWS / 2 - r - 0.5) * ch;
			for (let c = 0; c < COLS; c++, i++) {
				const u = (c - COLS / 2 + 0.5) * cw, wy = v - CY;
				mask[i] = 0; zb[i] = 99; cls[i] = 0; chars[i] = ' ';
				const d2 = u * u + wy * wy;
				if (d2 > bound * bound) continue;
				const t0 = 3 - Math.sqrt(bound * bound - d2);              // start where the ray enters the bounding sphere
				const ox = (R[0] * u + R[3] * wy + R[6] * (t0 - 3)) / s, oy = (R[1] * u + R[4] * wy + R[7] * (t0 - 3)) / s, oz = (R[2] * u + R[5] * wy + R[8] * (t0 - 3)) / s;
				let tt = 0, hit = false, px = 0, py = 0, pz = 0;
				for (let k = 0; k < 28 && tt < 3.4; k++) {
					px = ox + dx * tt; py = oy + dy * tt; pz = oz + dz * tt;
					const d = sdf(px, py, pz);
					if (d < 0.008) { hit = true; break; }
					tt += d;
				}
				if (!hit) continue;
				mask[i] = 1; zb[i] = t0 - 3 + tt * s;
				const e = 0.02, a = sdf(px + e, py - e, pz - e), b = sdf(px - e, py - e, pz + e), cc = sdf(px - e, py + e, pz - e), dd = sdf(px + e, py + e, pz + e);
				const n = norm(a - b - cc + dd, -a - b + cc + dd, -a + b - cc + dd);
				const diff = Math.max(0, n[0] * Lo[0] + n[1] * Lo[1] + n[2] * Lo[2]);
				const face = Math.max(0, -(n[0] * dx + n[1] * dy + n[2] * dz));
				const spec = Math.max(0, n[0] * Ho[0] + n[1] * Ho[1] + n[2] * Ho[2]) ** 24;
				lum[i] = 0.04 + 0.5 * diff + 0.45 * (1 - face) ** 2 + 0.6 * spec;
				// pedalboard grille: faint horizontal slats across the front panel
				if (pz < -0.6 && py < -0.05 && Math.abs(px) < 0.8 && (py * 9 + 20) % 1 < 0.45) lum[i] *= 0.55;
				// lights: antenna ball, and a chase of 12 lamps around the saucer ring
				if (Math.hypot(px, py - 1.33, pz) < 0.14) { if (lit) { cls[i] = C_LIGHT; lum[i] = 1; } }
				else if (Math.abs(Math.hypot(px, pz) - 1.15) < 0.11 && Math.abs(py - 0.55) < 0.11) {
					const seg = Math.floor((Math.atan2(pz, px) + Math.PI) / (Math.PI * 2) * 12) % 12;
					if (seg === beats % 12 || (m === 'hype' && seg % 3 === Math.floor(t * 12) % 3)) { cls[i] = C_LIGHT; lum[i] = 1; }
				}
			}
		}

		// 2) temporal smoothing (only where the surface was already there, so edges never smear)
		for (let i = 0; i < N; i++) sm[i] = mask[i] && prev[i] ? sm[i] + (lum[i] - sm[i]) * 0.5 : lum[i];

		// 3) shade + cartoon outline (Sobel on the silhouette, plus strong creases in the shading)
		const M = (r, c) => r < 0 || c < 0 || r >= ROWS || c >= COLS ? 0 : mask[r * COLS + c];
		const S = (r, c) => r < 0 || c < 0 || r >= ROWS || c >= COLS ? 0 : sm[r * COLS + c];
		for (let r = 0, i = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++, i++) {
			if (!mask[i]) continue;
			const edge = !M(r - 1, c) || !M(r + 1, c) || !M(r, c - 1) || !M(r, c + 1);
			let gx, gy;
			if (edge) {
				gx = M(r - 1, c + 1) + 2 * M(r, c + 1) + M(r + 1, c + 1) - M(r - 1, c - 1) - 2 * M(r, c - 1) - M(r + 1, c - 1);
				gy = M(r + 1, c - 1) + 2 * M(r + 1, c) + M(r + 1, c + 1) - M(r - 1, c - 1) - 2 * M(r - 1, c) - M(r - 1, c + 1);
			} else {
				gx = S(r - 1, c + 1) + 2 * S(r, c + 1) + S(r + 1, c + 1) - S(r - 1, c - 1) - 2 * S(r, c - 1) - S(r + 1, c - 1);
				gy = S(r + 1, c - 1) + 2 * S(r + 1, c) + S(r + 1, c + 1) - S(r - 1, c - 1) - 2 * S(r - 1, c) - S(r - 1, c + 1);
			}
			if (cls[i] !== C_LIGHT && (edge || Math.hypot(gx, gy) > 2.2)) {
				chars[i] = edgeChar(gx, gy);
				if (edge && !cls[i]) cls[i] = C_EDGE;
			} else {
				chars[i] = cls[i] === C_LIGHT ? '@' : RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.floor(sm[i] * RAMP.length)))];
			}
		}

		// 4) face: eyes + mouth stamped where they project, if the face is turned toward us
		if (R[8] > 0.3) {
			const eyes = t < blinkUntil && m !== 'joy' ? EYES.blink : EYES[m];
			for (const ex of [-0.4, 0.4]) stamp(eyes, R, s, ex, 0.02, -0.74);
			stamp([MOUTH[m]], R, s, 0, -0.4, -0.74);
		}
		if (t > nextBlink) { blinkUntil = t + 0.13; nextBlink = t + 1.8 + Math.random() * 3.5; }

		// 5) particles: tilted orbits + spring offsets that hit impulses knock around
		const spin = (0.55 + energy * 0.9) * sp;
		for (const p of P) {
			p.th += p.w * spin * dt;
			p.vx += (-p.ox * 14 - p.vx * 2.4) * dt; p.vy += (-p.oy * 14 - p.vy * 2.4) * dt; p.vz += (-p.oz * 14 - p.vz * 2.4) * dt;
			p.ox += p.vx * dt; p.oy += p.vy * dt; p.oz += p.vz * dt;
			if (p.gt > 0) p.gt -= dt; else p.g = 'x';
			let x = p.r * Math.cos(p.th), y = 0, z = p.r * Math.sin(p.th);
			[y, z] = [y * Math.cos(p.a) - z * Math.sin(p.a), y * Math.sin(p.a) + z * Math.cos(p.a)];
			[x, y] = [x * Math.cos(p.b) - y * Math.sin(p.b), x * Math.sin(p.b) + y * Math.cos(p.b)];
			x = x * s + p.ox; y = y * s + p.oy + CY; z = z * s + p.oz;
			const i = cell(x, y);
			if (p.pc >= 0 && p.pc !== i && chars[p.pc] === ' ') { chars[p.pc] = '.'; cls[p.pc] = GROUP[p.g]; } // trail
			p.pc = i;
			if (i < 0 || z > zb[i]) continue;
			chars[i] = z < -0.7 ? (p.g === 'x' ? '*' : 'o') : z < 0.7 ? '+' : '.';
			cls[i] = GROUP[p.g];
		}

		// 6) sparks out of the antenna, shockwave rings out of the head
		for (let k = sparks.length - 1; k >= 0; k--) {
			const q = sparks[k];
			q.life -= dt;
			if (q.life <= 0) { sparks.splice(k, 1); continue; }
			q.vy -= 6 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
			const i = cell(q.x, q.y);
			if (i >= 0 && q.z < zb[i]) { chars[i] = q.vy > 0 ? "'" : '.'; cls[i] = GROUP[q.g]; }
		}
		for (let k = rings.length - 1; k >= 0; k--) {
			const g = rings[k];
			g.r += dt * 5.5;
			if (g.r > 2.6) { rings.splice(k, 1); continue; }
			for (let a = 0; a < 48; a++) {
				const ang = a / 48 * Math.PI * 2, i = cell(Math.cos(ang) * g.r, CY + Math.sin(ang) * g.r * 0.62);
				if (i >= 0 && !mask[i]) { chars[i] = g.r < 1.6 ? 'o' : '.'; cls[i] = GROUP[g.g]; }
			}
		}
		draw();
	}

	function stamp(rows, R, s, x, y, z) {
		const wx = s * (R[0] * x + R[1] * y + R[2] * z), wy = s * (R[3] * x + R[4] * y + R[5] * z) + CY;
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
	function cell(x, y) {
		const c = Math.round(x / cw + COLS / 2 - 0.5), r = Math.round(ROWS / 2 - 0.5 - y / ch);
		return r < 0 || c < 0 || r >= ROWS || c >= COLS ? -1 : r * COLS + c;
	}
	function edgeChar(gx, gy) { // gradient → the line perpendicular to it, corrected for tall character cells
		let a = Math.atan2(gy, gx / aspect) * 180 / Math.PI;
		if (a < 0) a += 180;
		return a < 22.5 || a >= 157.5 ? '|' : a < 67.5 ? '/' : a < 112.5 ? (gy < 0 ? '_' : '-') : '\\';
	}
	function norm(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }
	function toObj(R, v) { return [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]]; }

	function draw() { // run-length spans so the browser only gets a few dozen elements per frame
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
		pre.innerHTML = html;
	}

	function fit() { // size the font so exactly COLS characters fill the width, and learn the cell aspect
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
		aspect = ratio / lh;
		cw = ch * aspect;
		const tall = innerHeight * 0.22 / ROWS; // never let the bot eat more than ~22% of the screen height
		pre.style.fontSize = Math.min(13, tall, Math.floor(width / (COLS * ratio) * 10) / 10).toFixed(1) + 'px';
	}

	let raf = 0, last = 0, acc = 0;
	function loop(now) {
		raf = requestAnimationFrame(loop);
		const dt = Math.min(0.05, (now - (last || now)) / 1000);
		last = now; acc += dt;
		if (acc < 1 / FPS - 0.004) return;
		frame(acc); acc = 0;
	}

	window.wiggler = {
		mount(el) {
			pre = el;
			new ResizeObserver(fit).observe(el.parentElement);
			el.closest('dialog')?.addEventListener('pointermove', e => {
				const b = el.getBoundingClientRect();
				lookX = Math.max(-1, Math.min(1, (e.clientX - b.left - b.width / 2) / b.width * 2));
				lookY = Math.max(-1, Math.min(1, (e.clientY - b.top - b.height / 2) / b.height));
			});
		},
		start() { if (!pre || raf) return; fit(); wowUntil = t + 1.1; last = 0; raf = requestAnimationFrame(loop); },
		stop() { cancelAnimationFrame(raf); raf = 0; },
		hit(group = 'd', strength = 1) {
			energy = Math.min(2, energy + 0.22 * strength);
			lastHit = t; hitGroup = group; pulse = Math.min(1, pulse + 0.6 * strength);
			wobV += (Math.random() - 0.5) * 3 * strength;
			for (const p of P) {
				if (Math.random() > 0.55) continue;
				const l = Math.hypot(p.ox + 0.01, p.oy, p.oz) || 1, kick = (1.5 + Math.random() * 2.5) * strength;
				p.vx += (Math.cos(p.th) + p.ox / l) * kick; p.vy += (Math.random() - 0.3) * kick; p.vz += Math.sin(p.th) * kick;
				p.g = group; p.gt = 0.9;
			}
			const n = group === 'd' ? 3 : 6;
			for (let k = 0; k < n; k++) sparks.push({ x: 0, y: CY + 1.4, z: -0.2, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 2.2, vz: (Math.random() - 0.5) * 2, life: 0.5 + Math.random() * 0.5, g: group });
			if (strength >= 1 && rings.length < 3) rings.push({ r: 1.2, g: group });
		},
		beat(accent) { beats++; lastBeat = t; nod = accent ? 1 : 0.5; },
	};
})();
