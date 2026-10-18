// Nicky Dubs beat pad: 16 pads, seven kits synthesized right here in the browser (no samples to download,
// nothing copyrighted), plus reverb + delay. Sounds are pre-rendered into buffers, so a hit is just
// "start this buffer now": the lowest latency the browser can do. Lives in a popup so the page can't
// scroll under your fingers, with the Air Wiggler (bot.js) reacting above the pads.
(() => {
	const pad = document.querySelector('.pad'), rig = document.querySelector('.rig');
	if (!pad || !rig) return;
	const grid = pad.querySelector('.pad__grid');
	const fileIn = pad.querySelector('.pad__file');
	const KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyQ', 'KeyW', 'KeyE', 'KeyR',
		'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV'];
	let mode = 'pads'; // 'pads' or 'synth': what the bottom half of the rig is showing
	const KEY_LABELS = ['1', '2', '3', '4', 'Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];
	let SR = 48000; // replaced by the sound card's own rate once audio starts, so nothing gets resampled
	const hz = n => 440 * 2 ** ((n - 69) / 12); // MIDI note → frequency

	// ── Sound design (each builder draws into an offline context) ──
	function envGain(c, t, attack, peak, decay) {
		const g = c.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(peak, t + attack);
		g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
		return g;
	}
	function noise(c, sec) {
		const b = c.createBuffer(1, Math.ceil(c.sampleRate * sec), c.sampleRate);
		const d = b.getChannelData(0);
		for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
		const s = c.createBufferSource();
		s.buffer = b;
		return s;
	}
	function filt(c, type, freq, q = 0.7) {
		const f = c.createBiquadFilter();
		f.type = type; f.frequency.value = freq; f.Q.value = q;
		return f;
	}
	function chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[0]; }
	function shaper(c, k) {
		const ws = c.createWaveShaper(), n = 1024, curve = new Float32Array(n);
		for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
		ws.curve = curve;
		return ws;
	}

	const S = {
		kick: (f0, f1, dec) => (c, out) => {
			const o = c.createOscillator();
			o.frequency.setValueAtTime(f0, 0);
			o.frequency.exponentialRampToValueAtTime(f1, 0.11);
			chain(o, envGain(c, 0, 0.002, 1, dec), out);
			const n = noise(c, 0.02);
			chain(n, filt(c, 'highpass', 2500), envGain(c, 0, 0.001, 0.35, 0.012), out);
			o.start(0); n.start(0);
		},
		snare: (tone, dec, bright = 1800) => (c, out) => {
			const o = c.createOscillator(); o.type = 'triangle';
			o.frequency.setValueAtTime(tone * 1.4, 0);
			o.frequency.exponentialRampToValueAtTime(tone, 0.03);
			chain(o, envGain(c, 0, 0.001, 0.55, 0.11), out);
			const n = noise(c, dec + 0.05);
			chain(n, filt(c, 'highpass', bright), envGain(c, 0, 0.001, 0.75, dec), out);
			o.start(0); n.start(0);
		},
		hat: (dec, peak = 0.5) => (c, out) => { // the 808 trick: six detuned square waves, filtered metallic
			const hp = filt(c, 'highpass', 7000), bp = filt(c, 'bandpass', 10000, 0.8);
			chain(bp, hp, envGain(c, 0, 0.001, peak, dec), out);
			for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) {
				const o = c.createOscillator(); o.type = 'square'; o.frequency.value = f * 1.6;
				o.connect(bp); o.start(0);
			}
		},
		roll: (c, out) => { for (const t of [0, 0.075, 0.15, 0.2, 0.25]) S.hatAt(t)(c, out); },
		hatAt: t => (c, out) => {
			const hp = filt(c, 'highpass', 7500), g = c.createGain();
			g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.4, t + 0.001); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
			const n = noise(c, 0.06); chain(n, hp, g, out); n.start(t);
		},
		clap: (c, out) => {
			const n = noise(c, 0.4), g = c.createGain();
			let t = 0;
			g.gain.setValueAtTime(0.0001, 0);
			for (let i = 0; i < 3; i++, t += 0.011) { g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.1, t + 0.009); }
			g.gain.setValueAtTime(0.8, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
			chain(n, filt(c, 'bandpass', 1300, 1.2), g, out); n.start(0);
		},
		rim: (c, out) => {
			const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = 1750;
			chain(o, envGain(c, 0, 0.001, 0.6, 0.035), out);
			const n = noise(c, 0.04); chain(n, filt(c, 'bandpass', 3000, 2), envGain(c, 0, 0.001, 0.4, 0.02), out);
			o.start(0); n.start(0);
		},
		shaker: (c, out) => { const n = noise(c, 0.2); chain(n, filt(c, 'highpass', 5500), envGain(c, 0, 0.025, 0.35, 0.09), out); n.start(0); },
		tom: f => (c, out) => {
			const o = c.createOscillator();
			o.frequency.setValueAtTime(f * 1.5, 0); o.frequency.exponentialRampToValueAtTime(f, 0.08);
			chain(o, envGain(c, 0, 0.002, 0.9, 0.45), out); o.start(0);
		},
		cowbell: (c, out) => {
			const bp = filt(c, 'bandpass', 2640, 1.5);
			chain(bp, envGain(c, 0, 0.001, 0.5, 0.35), out);
			for (const f of [540, 800]) { const o = c.createOscillator(); o.type = 'square'; o.frequency.value = f; o.connect(bp); o.start(0); }
		},
		// Electric-piano chord: FM "tine" per note (modulator decays fast = the bell-y bark of a Rhodes).
		keys: notes => (c, out) => {
			const lp = filt(c, 'lowpass', 3200), bus = c.createGain(); bus.gain.value = 0.9 / notes.length ** 0.6;
			chain(bus, lp, out);
			for (const n of notes) {
				const f = hz(n), car = c.createOscillator(), mod = c.createOscillator(), idx = c.createGain();
				car.frequency.value = f; mod.frequency.value = f;
				idx.gain.setValueAtTime(f * 2.2, 0); idx.gain.exponentialRampToValueAtTime(f * 0.15, 0.25);
				chain(mod, idx, car.frequency);
				chain(car, envGain(c, 0, 0.004, 0.6, 1.7), bus);
				car.start(0); mod.start(0);
			}
		},
		horns: notes => (c, out) => {
			const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
			lp.frequency.setValueAtTime(500, 0); lp.frequency.linearRampToValueAtTime(3200, 0.04); lp.frequency.exponentialRampToValueAtTime(900, 0.35);
			const g = envGain(c, 0, 0.012, 0.32, 0.42);
			chain(lp, g, out);
			for (const n of notes) for (const d of [-8, 0, 7]) {
				const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(n); o.detune.value = d;
				o.connect(lp); o.start(0);
			}
		},
		vibes: notes => (c, out) => {
			const trem = c.createGain(), lfo = c.createOscillator(), depth = c.createGain();
			lfo.frequency.value = 5.5; depth.gain.value = 0.25; trem.gain.value = 0.75;
			chain(lfo, depth, trem.gain); lfo.start(0);
			chain(trem, out);
			for (const n of notes) for (const [mult, amp, dec] of [[1, 0.45, 1.8], [4, 0.12, 0.3]]) {
				const o = c.createOscillator(); o.frequency.value = hz(n) * mult;
				chain(o, envGain(c, 0, 0.002, amp, dec), trem); o.start(0);
			}
		},
		upright: n => (c, out) => {
			const f = hz(n), lp = filt(c, 'lowpass', 900);
			chain(lp, envGain(c, 0, 0.008, 0.95, 0.75), out);
			for (const [type, amp] of [['sine', 1], ['triangle', 0.4]]) {
				const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = f; g.gain.value = amp;
				chain(o, g, lp); o.start(0);
			}
		},
		bass808: n => (c, out) => {
			const f = hz(n), o = c.createOscillator();
			o.frequency.setValueAtTime(f * 2.2, 0); o.frequency.exponentialRampToValueAtTime(f, 0.06);
			chain(o, shaper(c, 2.6), envGain(c, 0, 0.003, 0.8, 1.5), out); o.start(0);
		},
		ride: (c, out) => { // bell + wash: detuned squares through a bandpass, long tail
			const bp = filt(c, 'bandpass', 6500, 0.6), hp = filt(c, 'highpass', 4000);
			chain(bp, hp, envGain(c, 0, 0.001, 0.32, 0.9), out);
			for (const f of [313, 377, 481, 588, 727]) { const o = c.createOscillator(); o.type = 'square'; o.frequency.value = f * 2.9; o.connect(bp); o.start(0); }
			const n = noise(c, 1); chain(n, filt(c, 'highpass', 8000), envGain(c, 0, 0.001, 0.12, 0.7), out); n.start(0);
		},
		crash: (c, out) => { const n = noise(c, 1.8); chain(n, filt(c, 'highpass', 4500), envGain(c, 0, 0.002, 0.6, 1.4), out); n.start(0); },
		tamb: (c, out) => {
			const n = noise(c, 0.3), g = c.createGain(); g.gain.setValueAtTime(0.0001, 0);
			for (const t of [0, 0.018, 0.04]) { g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.015); }
			g.gain.setValueAtTime(0.3, 0.06); g.gain.exponentialRampToValueAtTime(0.0001, 0.22);
			chain(n, filt(c, 'bandpass', 8000, 1.5), g, out); n.start(0);
		},
		conga: f => (c, out) => {
			const o = c.createOscillator();
			o.frequency.setValueAtTime(f * 1.3, 0); o.frequency.exponentialRampToValueAtTime(f, 0.03);
			chain(o, envGain(c, 0, 0.001, 0.8, 0.22), out); o.start(0);
		},
		laser: (c, out) => {
			const o = c.createOscillator(); o.type = 'sawtooth';
			o.frequency.setValueAtTime(3200, 0); o.frequency.exponentialRampToValueAtTime(120, 0.35);
			chain(o, filt(c, 'lowpass', 4000), envGain(c, 0, 0.002, 0.35, 0.3), out); o.start(0);
		},
		big: (c, out) => { S.snare(185, 0.32, 1200)(c, out); S.clap(c, out); }, // dubstep snare: snare + clap layered
		pad: (notes, bright = 1400) => (c, out) => { // slow detuned saws, a warm wash under the drums
			const lp = filt(c, 'lowpass', bright), g = c.createGain();
			g.gain.setValueAtTime(0.0001, 0); g.gain.linearRampToValueAtTime(0.5 / notes.length ** 0.5, 0.25); g.gain.exponentialRampToValueAtTime(0.0001, 2.6);
			chain(lp, g, out);
			for (const n of notes) for (const d of [-9, 9]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(n); o.detune.value = d; o.connect(lp); o.start(0); }
		},
		strings: notes => S.pad(notes, 3200), // disco strings: the pad, brighter
		stab: notes => (c, out) => { // short bright saw chord, filter snapping shut
			const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 4;
			lp.frequency.setValueAtTime(4500, 0); lp.frequency.exponentialRampToValueAtTime(500, 0.25);
			chain(lp, envGain(c, 0, 0.002, 0.45 / notes.length ** 0.5, 0.3), out);
			for (const n of notes) for (const d of [-6, 6]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(n); o.detune.value = d; o.connect(lp); o.start(0); }
		},
		organ: notes => (c, out) => { // house organ: a few sine harmonics, short and percussive
			const bus = c.createGain(); bus.gain.value = 0.7 / notes.length ** 0.6;
			chain(bus, envGain(c, 0, 0.003, 1, 0.55), out);
			for (const n of notes) for (const [m, a] of [[1, 0.6], [2, 0.35], [3, 0.2], [4, 0.1]]) {
				const o = c.createOscillator(), g = c.createGain(); o.frequency.value = hz(n) * m; g.gain.value = a; chain(o, g, bus); o.start(0);
			}
		},
		reese: n => (c, out) => { // jungle reese: two detuned saws, low-passed, phasing against each other
			const lp = filt(c, 'lowpass', 520, 1.5);
			chain(lp, shaper(c, 1.8), envGain(c, 0, 0.01, 0.7, 1.1), out);
			for (const d of [-22, 22]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(n); o.detune.value = d; o.connect(lp); o.start(0); }
			const sub = c.createOscillator(); sub.frequency.value = hz(n); chain(sub, envGain(c, 0, 0.01, 0.6, 1.1), out); sub.start(0);
		},
		sub: n => (c, out) => { // clean sub, plus an octave of triangle so phone speakers can hear it
			const o = c.createOscillator(), h = c.createOscillator(), hg = c.createGain(), env = envGain(c, 0, 0.006, 0.9, 0.8);
			o.frequency.value = hz(n); h.type = 'triangle'; h.frequency.value = hz(n) * 2; hg.gain.value = 0.25;
			chain(o, env, out); chain(h, hg, env); o.start(0); h.start(0);
		},
		wobble: n => (c, out) => { // dubstep wobble: saw + square through a resonant filter swept by an LFO
			const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 9; lp.frequency.value = 600;
			const lfo = c.createOscillator(), depth = c.createGain(); lfo.frequency.value = 7; depth.gain.value = 520;
			chain(lfo, depth, lp.frequency); lfo.start(0);
			chain(lp, shaper(c, 2.2), envGain(c, 0, 0.005, 0.55, 0.85), out);
			for (const [t, d] of [['sawtooth', -7], ['square', 7]]) { const o = c.createOscillator(); o.type = t; o.frequency.value = hz(n); o.detune.value = d; o.connect(lp); o.start(0); }
		},
		slap: n => (c, out) => { // funk slap bass: a bright pluck that closes fast
			const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
			lp.frequency.setValueAtTime(3000, 0); lp.frequency.exponentialRampToValueAtTime(350, 0.18);
			chain(lp, envGain(c, 0, 0.002, 0.8, 0.45), out);
			for (const t of ['sawtooth', 'triangle']) { const o = c.createOscillator(); o.type = t; o.frequency.value = hz(n); o.connect(lp); o.start(0); }
		},
	};

	// The kits. Each pad: [name, sound, render length (s), colour, mute group (MPC-style choke)].
	// The newer kits share one layout: 8 drums on top, then 4 chords, then 4 bass notes.
	const KITS = {
		soul: { name: 'Soul MPC', dusty: true, pads: [
			['Kick', S.kick(160, 48, 0.42), 0.6, 'd'], ['Snare', S.snare(190, 0.2), 0.35, 'd'], ['Hat', S.hat(0.05), 0.12, 'd', 'hat'], ['Open hat', S.hat(0.4), 0.5, 'd', 'hat'],
			['Rim', S.rim, 0.1, 'd'], ['Clap', S.clap, 0.4, 'd'], ['Shaker', S.shaker, 0.2, 'd'], ['Tom', S.tom(110), 0.6, 'd'],
			['Dm9', S.keys([50, 53, 57, 60, 64]), 2, 'k'], ['G13', S.keys([43, 53, 59, 64]), 2, 'k'], ['Cmaj9', S.keys([48, 55, 59, 62, 64]), 2, 'k'], ['Am11', S.keys([45, 55, 60, 62, 64]), 2, 'k'],
			['Horns', S.horns([65, 69, 72]), 0.5, 'h'], ['Vibes', S.vibes([69, 76]), 1.9, 'h'], ['Bass D', S.upright(38), 0.85, 'b', 'bass'], ['Bass G', S.upright(43), 0.85, 'b', 'bass'],
		] },
		808: { name: '808 Trap', dusty: false, pads: [
			['Kick', S.kick(120, 42, 0.55), 0.7, 'd'], ['Snare', S.snare(220, 0.16, 2400), 0.3, 'd'], ['Clap', S.clap, 0.4, 'd'], ['Hat', S.hat(0.04, 0.4), 0.1, 'd', 'hat'],
			['Open hat', S.hat(0.32, 0.4), 0.4, 'd', 'hat'], ['Hat roll', S.roll, 0.35, 'd', 'hat'], ['Rim', S.rim, 0.1, 'd'], ['Cowbell', S.cowbell, 0.4, 'd'],
			...[36, 39, 41, 43, 44, 46, 48, 51].map(n => [`808 ${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12]}`, S.bass808(n), 1.6, 'b', 'bass']),
		] },
		jungle: { name: 'Jungle', dusty: true, pads: [
			['Kick', S.kick(150, 50, 0.32), 0.5, 'd'], ['Snare', S.snare(210, 0.22, 1500), 0.4, 'd'], ['Hat', S.hat(0.045), 0.12, 'd', 'hat'], ['Ride', S.ride, 1.2, 'd'],
			['Ghost', S.snare(240, 0.07, 2600), 0.15, 'd'], ['Rim', S.rim, 0.1, 'd'], ['Crash', S.crash, 1.8, 'h'], ['Tom', S.tom(95), 0.6, 'd'],
			['Am9', S.pad([57, 60, 64, 67, 71]), 2.7, 'k'], ['Fmaj7', S.pad([53, 57, 60, 64]), 2.7, 'k'], ['Dm9', S.pad([50, 57, 60, 64, 65]), 2.7, 'k'], ['Em7', S.pad([52, 55, 59, 62]), 2.7, 'k'],
			['Reese A', S.reese(33), 1.2, 'b', 'bass'], ['Reese C', S.reese(36), 1.2, 'b', 'bass'], ['Reese D', S.reese(38), 1.2, 'b', 'bass'], ['Reese E', S.reese(40), 1.2, 'b', 'bass'],
		] },
		liquid: { name: 'Liquid DnB', dusty: false, pads: [
			['Kick', S.kick(140, 46, 0.3), 0.45, 'd'], ['Snare', S.snare(200, 0.18, 2000), 0.35, 'd'], ['Hat', S.hat(0.04, 0.4), 0.1, 'd', 'hat'], ['Open hat', S.hat(0.3, 0.4), 0.4, 'd', 'hat'],
			['Ghost', S.snare(230, 0.06, 2600), 0.15, 'd'], ['Shaker', S.shaker, 0.2, 'd'], ['Rim', S.rim, 0.1, 'd'], ['Ride', S.ride, 1.2, 'd'],
			['Fmaj9', S.keys([53, 57, 60, 64, 67]), 2, 'k'], ['Em9', S.keys([52, 55, 59, 62, 66]), 2, 'k'], ['Dm9', S.keys([50, 53, 57, 60, 64]), 2, 'k'], ['Cmaj9', S.keys([48, 55, 59, 62, 64]), 2, 'k'],
			['Sub F', S.sub(41), 0.9, 'b', 'bass'], ['Sub E', S.sub(40), 0.9, 'b', 'bass'], ['Sub D', S.sub(38), 0.9, 'b', 'bass'], ['Sub C', S.sub(36), 0.9, 'b', 'bass'],
		] },
		dubstep: { name: 'Dubstep', dusty: false, pads: [
			['Kick', S.kick(130, 40, 0.5), 0.7, 'd'], ['Snare', S.big, 0.5, 'd'], ['Hat', S.hat(0.05), 0.12, 'd', 'hat'], ['Open hat', S.hat(0.35), 0.45, 'd', 'hat'],
			['Crash', S.crash, 1.8, 'h'], ['Rim', S.rim, 0.1, 'd'], ['Laser', S.laser, 0.4, 'h'], ['Clap', S.clap, 0.4, 'd'],
			['Fm', S.stab([53, 56, 60]), 0.35, 'k'], ['Db', S.stab([49, 53, 56]), 0.35, 'k'], ['Ab', S.stab([56, 60, 63]), 0.35, 'k'], ['Eb', S.stab([51, 55, 58]), 0.35, 'k'],
			['Wob F', S.wobble(41), 0.9, 'b', 'bass'], ['Wob G#', S.wobble(44), 0.9, 'b', 'bass'], ['Wob A#', S.wobble(46), 0.9, 'b', 'bass'], ['Wob D#', S.wobble(39), 0.9, 'b', 'bass'],
		] },
		house: { name: 'House', dusty: false, pads: [
			['Kick', S.kick(140, 50, 0.5), 0.6, 'd'], ['Clap', S.clap, 0.4, 'd'], ['Hat', S.hat(0.04), 0.1, 'd', 'hat'], ['Open hat', S.hat(0.28), 0.4, 'd', 'hat'],
			['Shaker', S.shaker, 0.2, 'd'], ['Rim', S.rim, 0.1, 'd'], ['Conga', S.conga(330), 0.3, 'd'], ['Cowbell', S.cowbell, 0.4, 'd'],
			['Am7', S.organ([57, 60, 64, 67]), 0.7, 'k'], ['Dm7', S.organ([50, 57, 60, 65]), 0.7, 'k'], ['Em7', S.organ([52, 55, 59, 62]), 0.7, 'k'], ['Fmaj7', S.organ([53, 57, 60, 64]), 0.7, 'k'],
			['Bass A', S.slap(33), 0.5, 'b', 'bass'], ['Bass D', S.slap(38), 0.5, 'b', 'bass'], ['Bass E', S.slap(40), 0.5, 'b', 'bass'], ['Bass F', S.slap(41), 0.5, 'b', 'bass'],
		] },
		disco: { name: 'Roller Disco', dusty: true, pads: [
			['Kick', S.kick(130, 48, 0.4), 0.55, 'd'], ['Snare', S.snare(220, 0.15, 2600), 0.3, 'd'], ['Hat', S.hat(0.04), 0.1, 'd', 'hat'], ['Open hat', S.hat(0.35), 0.45, 'd', 'hat'],
			['Tamb', S.tamb, 0.25, 'd'], ['Clap', S.clap, 0.4, 'd'], ['Conga', S.conga(260), 0.3, 'd'], ['Cowbell', S.cowbell, 0.4, 'd'],
			['Em7', S.strings([52, 59, 62, 67]), 2.7, 'k'], ['Am7', S.strings([57, 60, 64, 67]), 2.7, 'k'], ['D', S.strings([50, 57, 62, 66]), 2.7, 'k'], ['Cmaj7', S.strings([48, 55, 59, 64]), 2.7, 'k'],
			['Slap E', S.slap(40), 0.5, 'b', 'bass'], ['Slap A', S.slap(45), 0.5, 'b', 'bass'], ['Slap D', S.slap(38), 0.5, 'b', 'bass'], ['Slap C', S.slap(36), 0.5, 'b', 'bass'],
		] },
	};

	async function renderPad(def, dusty) {
		const [, build, len] = def;
		const c = new OfflineAudioContext(1, Math.ceil(SR * len), SR);
		let out = c.destination;
		if (dusty) { // a little tape warmth + rolled-off top for the MPC feel
			const g = c.createGain(); g.gain.value = 0.9;
			chain(g, shaper(c, 1.6), filt(c, 'lowpass', 7500), out);
			out = g;
		}
		build(c, out);
		const buf = await c.startRendering();
		const d = buf.getChannelData(0);
		let peak = 0;
		for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
		if (peak > 0.9) for (let i = 0; i < d.length; i++) d[i] *= 0.9 / peak; // never clip, keep the kit's balance otherwise
		return buf;
	}
	const KIT_ORDER = ['soul', '808', 'jungle', 'liquid', 'dubstep', 'house', 'disco']; // '808' would sort first on its own
	const buffers = {}, custom = Object.fromEntries(Object.keys(KITS).map(k => [k, []])), renders = {};
	let rendering = null;
	function renderKit(id) { // one kit's pads, rendered once
		return renders[id] ||= Promise.all(KITS[id].pads.map(p => renderPad(p, KITS[id].dusty))).then(b => { buffers[id] = b; });
	}
	function renderAll() { // the kit on screen first, then the rest one by one so opening stays quick
		return rendering ||= (async () => { await renderKit(kit); for (const id of KIT_ORDER) await renderKit(id); })();
	}

	// ── Memory: what you tweak is saved in this browser (IndexedDB), and every change can be undone ──
	const store = (() => {
		let db = null;
		const open = () => db ||= new Promise((res, rej) => {
			const r = indexedDB.open('airwiggler', 1);
			r.onupgradeneeded = () => r.result.createObjectStore('kv');
			r.onsuccess = () => res(r.result);
			r.onerror = () => rej(r.error);
		});
		const run = async (mode, fn) => {
			const d = await open();
			return new Promise((res, rej) => {
				const t = d.transaction('kv', mode), q = fn(t.objectStore('kv'));
				t.oncomplete = () => res(q.result);
				t.onerror = () => rej(t.error);
			});
		};
		return { get: k => run('readonly', s => s.get(k)).catch(() => undefined), put: (k, v) => run('readwrite', s => s.put(v, k)).catch(() => {}) };
	})();
	const ctl = {};                       // every undoable control: path → { get, set }
	const hist = { list: [], pos: 0 };    // each entry: [[path, from, to], ...] for one gesture
	const HIST_MAX = 1e6;
	let pendingEdit = {}, editTimer = 0, saveTimer = 0, restoring = false;
	// Controls call touch() with their value from before the change. A gesture is committed once it has
	// been still for 400 ms (you let go of the knob, stopped scrolling, etc.), so one drag = one undo step.
	function touch(path, before) {
		if (restoring) return;
		if (!(path in pendingEdit)) pendingEdit[path] = before;
		clearTimeout(editTimer);
		editTimer = setTimeout(commit, 400);
		saveSoon();
	}
	function commit() {
		clearTimeout(editTimer);
		const ch = Object.entries(pendingEdit).map(([p, f]) => [p, f, ctl[p].get()]).filter(([, f, t]) => f !== t);
		pendingEdit = {};
		if (!ch.length) return;
		hist.list.length = hist.pos;
		hist.list.push(ch);
		if (hist.list.length > HIST_MAX) hist.list.splice(0, hist.list.length - HIST_MAX);
		hist.pos = hist.list.length;
		undoUi(); saveSoon();
	}
	function step(dir) {
		commit();
		if (dir < 0 ? !hist.pos : hist.pos >= hist.list.length) return;
		const ch = dir < 0 ? hist.list[--hist.pos] : hist.list[hist.pos++];
		restoring = true;
		for (const [p, f, t] of ch) ctl[p]?.set(dir < 0 ? f : t);
		restoring = false;
		undoUi(); saveSoon();
		window.wiggler?.hit('u', 0.5);
	}
	const undoBtn = pad.querySelector('.pad__undo'), redoBtn = pad.querySelector('.pad__redo');
	function undoUi() {
		if (!undoBtn) return;
		undoBtn.disabled = !hist.pos; redoBtn.disabled = hist.pos >= hist.list.length;
		undoBtn.title = `Undo (Ctrl+Z) · ${hist.pos.toLocaleString()} step${hist.pos === 1 ? '' : 's'} back`;
		redoBtn.title = `Redo (Ctrl+Shift+Z) · ${(hist.list.length - hist.pos).toLocaleString()} ahead`;
	}
	undoBtn?.addEventListener('click', () => step(-1));
	redoBtn?.addEventListener('click', () => step(1));
	addEventListener('keydown', e => {
		if (!rig.open || !(e.ctrlKey || e.metaKey) || e.code !== 'KeyZ' && e.code !== 'KeyY') return;
		e.preventDefault();
		step(e.code === 'KeyY' || e.shiftKey ? 1 : -1);
	});
	function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveAll, 800); }
	function saveAll() {
		const values = {};
		for (const p in ctl) values[p] = ctl[p].get();
		store.put('state', { values, patch: synthUi?.patch(), dirty: synthUi?.isDirty() });
		store.put('history', { list: hist.list, pos: hist.pos });
	}
	addEventListener('pagehide', () => { commit(); saveAll(); });

	// ── Live audio graph ──
	// pads → bus ──┬─────────────────────────────→ compIn → [bus compressor] → master → soft clipper → speakers
	//              └→ sends → reverb / delay / crush / shift → returns ─┘
	// A pad picked as the sidechain key goes to keyBus instead: it skips the compressor and drives its detector.
	// No DynamicsCompressorNode anywhere: Chrome's has a fixed ~6 ms look-ahead you can feel. The compressor and
	// bitcrusher below are tiny AudioWorklets with zero look-ahead, and a tanh waveshaper catches the final peaks.
	let ac, bus, keyBus, keySum, clickBus, sendBus, compIn, postComp, master, compNode = null, crushNode = null;
	let recTap, loopIn, recNode = null, workletReady = null; // loop bank: what gets recorded, where loops play
	let tempo = 120;
	const hooks = []; // run when the tempo changes
	const WORKLET = `
	class Comp extends AudioWorkletProcessor {
		static get parameterDescriptors() { return ['thr', 'ratio', 'att', 'rel', 'makeup', 'key'].map(name => ({ name, defaultValue: 0 })); }
		constructor() { super(); this.env = 0; this.n = 0; }
		process(I, O, p) {
			const inp = I[0], key = I[1], out = O[0], len = out[0].length, knee = 6;
			const det = p.key[0] > 0.5 ? key : inp;
			const thr = p.thr[0], slope = 1 / Math.max(1, p.ratio[0]) - 1, mk = 10 ** (p.makeup[0] / 20);
			const aA = Math.exp(-1 / (Math.max(0.0001, p.att[0]) * sampleRate)), aR = Math.exp(-1 / (Math.max(0.001, p.rel[0]) * sampleRate));
			for (let i = 0; i < len; i++) {
				let x = 0;
				for (let c = 0; c < det.length; c++) x = Math.max(x, Math.abs(det[c][i]));
				const over = 20 * Math.log10(x + 1e-9) - thr;
				const g = 2 * over < -knee ? 0 : 2 * Math.abs(over) <= knee ? slope * (over + knee / 2) ** 2 / (2 * knee) : slope * over;
				const t = -g;
				this.env = t > this.env ? aA * this.env + (1 - aA) * t : aR * this.env + (1 - aR) * t;
				const gl = 10 ** (-this.env / 20) * mk;
				for (let c = 0; c < out.length; c++) { const s = inp[c] || inp[0]; out[c][i] = s ? s[i] * gl : 0; }
			}
			if ((this.n += len) > 2048) { this.n = 0; this.port.postMessage(this.env); }
			return true;
		}
	}
	class Crush extends AudioWorkletProcessor {
		static get parameterDescriptors() { return [{ name: 'bits', defaultValue: 12 }, { name: 'rate', defaultValue: 26040 }]; }
		constructor() { super(); this.ph = 1; this.h = [0, 0]; }
		process(I, O, p) {
			const inp = I[0], out = O[0];
			if (!inp.length) return true;
			const q = 2 ** (p.bits[0] - 1), step = p.rate[0] / sampleRate;
			for (let i = 0; i < out[0].length; i++) {
				this.ph += step;
				const take = this.ph >= 1;
				if (take) this.ph -= Math.floor(this.ph);
				for (let c = 0; c < out.length; c++) {
					if (take) this.h[c] = Math.round((inp[c] || inp[0])[i] * q) / q;
					out[c][i] = this.h[c];
				}
			}
			return true;
		}
	}
	class Rec extends AudioWorkletProcessor { // records between two audio-clock times, sample-accurate
		constructor() {
			super(); this.on = Infinity; this.off = Infinity; this.L = []; this.R = []; this.n = 0;
			this.port.onmessage = ({ data: m }) => {
				if (m.start !== undefined) { this.on = m.start; this.off = Infinity; this.L = []; this.R = []; this.n = 0; }
				if (m.stop !== undefined) this.off = m.stop;
				if (m.cancel) { this.on = this.off = Infinity; this.L = []; this.R = []; this.n = 0; }
			};
		}
		process(I) {
			const inp = I[0], n = inp[0] ? inp[0].length : 128, t0 = currentTime, t1 = t0 + n / sampleRate;
			if (t1 <= this.on) return true;
			const a = Math.max(0, Math.round((this.on - t0) * sampleRate)), b = Math.min(n, Math.round((this.off - t0) * sampleRate));
			if (b > a) {
				const l = inp[0], r = inp[1] || inp[0];
				this.L.push(l ? l.slice(a, b) : new Float32Array(b - a)); this.R.push(r ? r.slice(a, b) : new Float32Array(b - a));
				this.n += b - a;
			}
			if (t1 >= this.off || this.n > sampleRate * 90) {
				const L = new Float32Array(this.n), R = new Float32Array(this.n);
				for (let k = 0, o = 0; k < this.L.length; o += this.L[k].length, k++) { L.set(this.L[k], o); R.set(this.R[k], o); }
				this.port.postMessage({ L, R }, [L.buffer, R.buffer]);
				this.on = this.off = Infinity; this.L = []; this.R = []; this.n = 0;
			}
			return true;
		}
	}
	registerProcessor('nd-rec', Rec);
	registerProcessor('nd-comp', Comp);
	registerProcessor('nd-crush', Crush);`;

	// ── The rack: every knob is [key, label, min, max, default, curve, format]. Curves: lin, exp, or a list. ──
	const DIVS = [['1/64T', 1 / 24], ['1/64', 1 / 16], ['1/32T', 1 / 12], ['1/32', 1 / 8], ['1/16T', 1 / 6], ['1/16', 1 / 4], ['1/16D', 3 / 8],
		['1/8T', 1 / 3], ['1/8', 1 / 2], ['1/8D', 3 / 4], ['1/4T', 2 / 3], ['1/4', 1], ['1/4D', 1.5], ['1/2', 2], ['1 bar', 4]]; // in beats
	const SHIFTS = [['1/32T', 1 / 12], ['1/32', 1 / 8], ['1/16T', 1 / 6], ['1/16', 1 / 4], ['1/8T', 1 / 3], ['1/8', 1 / 2], ['1/4T', 2 / 3],
		['1/4', 1], ['1/2', 2], ['1 bar', 4], ['2 bars', 8], ['4 bars', 16]];
	const KEYS_SC = [['off', 'Off'], ['kick', 'Kick'], ['drums', 'Drums'], ['bass', 'Bass'], ['keys', 'Keys'], ['click', 'Click']];
	const pct = v => Math.round(v * 100) + '%', ms = v => (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ms', khz = v => v < 1000 ? Math.round(v) + ' Hz' : (v / 1000).toFixed(1) + ' kHz';
	const RACK = [
		{ id: 'rev', name: 'Reverb', on: true, nod: 'Plate after the EMT 140 (1957), returned through the Abbey Road EQ trick', knobs: [
			['pre', 'Pre-delay', 0, 250, 20, 'lin', ms], ['len', 'Length', 0.3, 8, 2.2, 'exp', v => v.toFixed(1) + ' s'],
			['dens', 'Density', 0, 1, 0.85, 'lin', pct], ['spread', 'Spread', 0, 1, 0.7, 'lin', pct], ['lvl', 'Level', 0, 1, 0.3, 'lin', pct]] },
		{ id: 'dly', name: 'Delay', on: false, sync: true, nod: 'Tape echo after the Roland RE-201 Space Echo (1974): darker and dirtier every repeat', knobs: [
			['time', 'Time', 0, 1, 9 / 14, 'lin', null], ['fb', 'Feedback', 0, 0.95, 0.4, 'lin', pct], ['tone', 'Tone', 400, 12000, 3200, 'exp', khz],
			['wow', 'Wow', 0, 1, 0.15, 'lin', pct], ['lvl', 'Level', 0, 1, 0.5, 'lin', pct]] },
		{ id: 'crush', name: 'Crush', on: false, nod: 'Grit after the E-mu SP-1200 (1987): defaults to its 12-bit, 26.04 kHz', knobs: [
			['lo', 'Lo-cut', 20, 2000, 100, 'exp', khz], ['crush', 'Crush', 0, 1, 0.31, 'lin', v => `${Math.round(16 - 13 * v)}-bit`],
			['drive', 'Drive', 0, 1, 0.3, 'lin', pct], ['hi', 'Hi-cut', 1000, 20000, 12000, 'exp', khz], ['lvl', 'Level', 0, 1, 0.5, 'lin', pct]] },
		{ id: 'shift', name: 'Shift', on: false, nod: 'Beat shifter, a nod to the Eventide H910 Harmonizer (1975): throws the beat back in time', knobs: [
			['amt', 'Shift', 0, SHIFTS.length - 1, 5, SHIFTS, null], ['rep', 'Repeats', 0, 0.95, 0.3, 'lin', pct],
			['warp', 'Warp', 0, 1, 0, 'lin', pct], ['chaos', 'Chaos', 0, 1, 0, 'lin', pct], ['lvl', 'Level', 0, 1, 0.5, 'lin', pct]] },
		{ id: 'comp', name: 'Comp', on: true, key: 'off', nod: 'Final bus compressor in the spirit of the SSL G-series (1977), with zero look-ahead', knobs: [
			['thr', 'Threshold', -40, 0, -14, 'lin', v => v.toFixed(1) + ' dB'], ['ratio', 'Ratio', 1, 20, 3, 'exp', v => v.toFixed(1) + ':1'],
			['att', 'Attack', 0.1, 100, 10, 'exp', ms], ['rel', 'Release', 20, 1500, 200, 'exp', ms], ['makeup', 'Makeup', 0, 18, 3, 'lin', v => '+' + v.toFixed(1) + ' dB']] },
	];
	const P = {}; // live settings, real units
	for (const m of RACK) { P[m.id] = { on: m.on, sync: m.sync, key: m.key }; for (const k of m.knobs) P[m.id][k[0]] = k[4]; }
	const delaySec = () => Math.min(8, P.dly.sync ? DIVS[Math.round(P.dly.time * (DIVS.length - 1))][1] * 60 / tempo : 0.01 * 200 ** P.dly.time);
	const shiftSec = () => Math.min(32, SHIFTS[P.shift.amt][1] * 60 / tempo);

	// Each effect is built as a fresh little graph between its send and return, so "Cut FX" can throw the
	// whole thing away (tails and all) and build a clean one.
	const FX = {}, nodes = {};
	const set = (param, v, tau = 0.02) => param.setTargetAtTime(v, ac.currentTime, tau);
	const BUILD = {
		rev() {
			const pre = ac.createDelay(0.3), conv = ac.createConvolver(), hp = filt(ac, 'highpass', 400), lp = filt(ac, 'lowpass', 9000);
			chain(pre, conv, hp, lp);
			return { input: pre, output: lp, pre, conv };
		},
		dly() {
			const dl = ac.createDelay(8), sat = shaper(ac, 1.3), tone = filt(ac, 'lowpass', 3200), fb = ac.createGain();
			const lfo = ac.createOscillator(), depth = ac.createGain();
			lfo.frequency.value = 0.55; chain(lfo, depth, dl.delayTime); lfo.start();
			chain(dl, sat, tone, fb, dl);
			return { input: dl, output: tone, dl, tone, fb, depth, lfo };
		},
		crush() {
			const lo = filt(ac, 'highpass', 100), drive = ac.createGain(), sat = shaper(ac, 2.5), hi = filt(ac, 'lowpass', 12000), trim = ac.createGain();
			chain(lo, drive, sat);
			if (crushNode) { crushNode.disconnect(); chain(sat, crushNode, hi); } else chain(sat, hi);
			chain(hi, trim);
			return { input: lo, output: trim, lo, drive, sat, hi, trim };
		},
		shift() {
			const dl = ac.createDelay(32), rep = ac.createGain(), lfo = ac.createOscillator(), depth = ac.createGain();
			lfo.frequency.value = 0.25; chain(lfo, depth, dl.delayTime); lfo.start();
			chain(dl, rep, dl);
			return { input: dl, output: dl, dl, rep, depth, lfo };
		},
	};
	function irFor({ len, dens, spread }) { // decaying noise; low density = sparse grainy reflections, spread = stereo width
		const n = Math.ceil(ac.sampleRate * len), ir = ac.createBuffer(2, n, ac.sampleRate);
		const L = ir.getChannelData(0), R = ir.getChannelData(1), p = 0.004 + dens * dens * 0.996, amp = 1 / Math.sqrt(p);
		let e = 0;
		for (let i = 0; i < n; i++) {
			const env = Math.exp(-6.9 * i / n), a = Math.random() < p ? (Math.random() * 2 - 1) * amp : 0, b = Math.random() < p ? (Math.random() * 2 - 1) * amp : 0;
			L[i] = a * env; R[i] = (spread * b + (1 - spread) * a) * env;
			e += L[i] * L[i];
		}
		const k = 1 / Math.sqrt(e || 1); // same loudness at any length/density; Level does the rest
		for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; }
		return ir;
	}
	let irTimer = 0;
	function apply(id) {
		if (!ac) return;
		if (id === 'comp') return applyComp();
		const s = P[id], f = FX[id];
		set(nodes[id].send.gain, s.on ? 1 : 0);
		if (id === 'rev') {
			set(f.pre.delayTime, s.pre / 1000);
			set(nodes.rev.ret.gain, s.lvl * 40);
			clearTimeout(irTimer);
			if (!f.conv.buffer) f.conv.buffer = irFor(s);
			else irTimer = setTimeout(() => { FX.rev.conv.buffer = irFor(s); }, 120);
		} else if (id === 'dly') {
			set(f.dl.delayTime, delaySec(), 0.05);
			set(f.fb.gain, s.fb); set(f.tone.frequency, s.tone); set(f.depth.gain, s.wow * 0.0035); set(nodes.dly.ret.gain, s.lvl);
		} else if (id === 'crush') {
			set(f.lo.frequency, s.lo); set(f.drive.gain, 30 ** s.drive); set(f.hi.frequency, s.hi);
			set(f.trim.gain, 1 / (1 + s.drive * 1.5)); set(nodes.crush.ret.gain, s.lvl);
			if (crushNode) { set(crushNode.parameters.get('bits'), 16 - 13 * s.crush, 0.005); set(crushNode.parameters.get('rate'), Math.max(800, ac.sampleRate * (1 - s.crush) ** 1.7), 0.005); }
		} else if (id === 'shift') {
			set(f.dl.delayTime, shiftSec(), 0.03); // the glide between shift lengths is the "rip": a tape-speed swoop
			set(f.rep.gain, s.rep); set(f.depth.gain, s.warp * 0.03); set(f.lfo.frequency, tempo / 60 / 4); set(nodes.shift.ret.gain, s.lvl);
		}
	}
	function applyComp() {
		if (!ac) return;
		const s = P.comp;
		compIn.disconnect();
		if (s.on && compNode) {
			compIn.connect(compNode);
			const prm = n => compNode.parameters.get(n);
			set(prm('thr'), s.thr); set(prm('ratio'), s.ratio); set(prm('att'), s.att / 1000); set(prm('rel'), s.rel / 1000); set(prm('makeup'), s.makeup);
			set(prm('key'), s.key === 'off' ? 0 : 1, 0.001);
		} else {
			compIn.connect(postComp);
			meter(0);
		}
		try { clickBus.disconnect(keySum); } catch {}
		if (s.key === 'click') clickBus.connect(keySum);
	}
	function build(id) {
		if (FX[id]) { nodes[id].send.disconnect(); FX[id].output.disconnect(); FX[id].lfo?.stop(); }
		FX[id] = BUILD[id]();
		nodes[id].send.connect(FX[id].input);
		FX[id].output.connect(nodes[id].ret);
		apply(id);
	}
	// Which pads count as the sidechain key
	function isKey(def) {
		const k = P.comp.key;
		if (!def || k === 'off' || k === 'click' || !P.comp.on || !compNode) return false;
		return k === 'kick' ? /kick/i.test(def[0]) : k === 'drums' ? def[3] === 'd' : k === 'bass' ? def[3] === 'b' : def[3] === 'k' || def[3] === 'h';
	}

	function audio() {
		if (ac) return ac;
		ac = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
		SR = ac.sampleRate;
		master = ac.createGain(); master.gain.value = 0.6; // the clipper adds ~4 dB on quiet signals; this evens it out
		chain(master, shaper(ac, 1.4), ac.destination);
		postComp = ac.createGain(); postComp.connect(master);
		compIn = ac.createGain(); compIn.connect(postComp);
		bus = ac.createGain(); keyBus = ac.createGain(); keySum = ac.createGain(); clickBus = ac.createGain(); sendBus = ac.createGain();
		bus.connect(compIn); keyBus.connect(postComp); keyBus.connect(keySum); clickBus.connect(master);
		bus.connect(sendBus); keyBus.connect(sendBus);
		recTap = ac.createGain(); bus.connect(recTap); keyBus.connect(recTap); // "Pads" source: pads + their FX, never the loops or click
		loopIn = ac.createGain(); loopIn.connect(compIn);
		for (const id of ['rev', 'dly', 'crush', 'shift']) {
			nodes[id] = { send: ac.createGain(), ret: ac.createGain() };
			sendBus.connect(nodes[id].send); nodes[id].ret.connect(compIn); nodes[id].ret.connect(recTap);
			build(id);
		}
		workletReady = (ac.audioWorklet ? ac.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))) : Promise.reject()).then(() => {
			recNode = new AudioWorkletNode(ac, 'nd-rec', { outputChannelCount: [1] });
			const sink = ac.createGain(); sink.gain.value = 0; // keeps the recorder running without making sound
			chain(recTap, recNode, sink, ac.destination);
			compNode = new AudioWorkletNode(ac, 'nd-comp', { numberOfInputs: 2, outputChannelCount: [2] });
			compNode.connect(postComp); keySum.connect(compNode, 0, 1);
			compNode.port.onmessage = e => meter(e.data);
			crushNode = new AudioWorkletNode(ac, 'nd-crush', { outputChannelCount: [2] });
			build('crush'); applyComp();
		}).catch(() => {}); // no worklets (very old browsers): everything still plays, just without comp + crusher
		showLatency();
		return ac;
	}
	// Honest numbers: the browser's processing buffer + what the OS/sound card adds after it.
	const latOut = pad.querySelector('.pad__lat');
	function showLatency() {
		if (!ac || !latOut) return;
		const ms = ((ac.baseLatency || 0) + (ac.outputLatency || 0)) * 1000;
		latOut.textContent = ms ? `~${ms.toFixed(1)} ms` : '';
		latOut.title = `Browser buffer ${((ac.baseLatency || 0) * 1000).toFixed(1)} ms + output ${((ac.outputLatency || 0) * 1000).toFixed(1)} ms at ${ac.sampleRate} Hz`;
	}
	// Cut FX: throw away every effect's tail (rebuild them clean); your settings stay.
	pad.querySelector('.pad__cut').addEventListener('click', () => { if (ac) for (const id of ['rev', 'dly', 'crush', 'shift']) build(id); });

	// Beat clock for the shifter's Chaos knob: a logistic map (the classic road to chaos) picks the next shift
	let chaosX = 0.4;
	function chaosTick() {
		setTimeout(chaosTick, 60000 / tempo);
		const s = P.shift;
		if (!ac || !s.on || s.chaos <= 0 || !rig.open) return;
		chaosX = (3.57 + 0.43 * s.chaos) * chaosX * (1 - chaosX);
		if (Math.random() < s.chaos) FX.shift.dl.delayTime.setTargetAtTime(Math.min(32, SHIFTS[Math.floor(chaosX * SHIFTS.length)][1] * 60 / tempo), ac.currentTime, 0.03);
		else apply('shift');
	}
	chaosTick();
	hooks.push(() => { if (ac) { apply('dly'); apply('shift'); } });

	// ── Rack UI: a tab per effect (with its on/off LED), one row of knobs for the selected one ──
	const rackEl = pad.querySelector('.rack');
	let grEl = null;
	function meter(db) { grEl?.style.setProperty('--gr', Math.min(1, db / 12).toFixed(3)); }
	if (rackEl) {
		const tabs = document.createElement('div'), panel = document.createElement('div');
		tabs.className = 'rack__tabs'; tabs.setAttribute('role', 'tablist'); panel.className = 'rack__panel';
		rackEl.append(tabs, panel);
		const panels = {};
		const select = id => {
			tabs.querySelectorAll('.rack__name').forEach(b => b.setAttribute('aria-selected', b.dataset.m === id));
			for (const [k, el] of Object.entries(panels)) el.hidden = k !== id;
		};
		for (const m of RACK) {
			const tab = document.createElement('div');
			tab.className = 'rack__tab';
			tab.innerHTML = `<button type="button" class="rack__led" aria-pressed="${m.on}" aria-label="${m.name} on/off" title="${m.name} on/off"></button>`
				+ `<button type="button" class="rack__name" data-m="${m.id}" role="tab">${m.name}${m.id === 'comp' ? '<i class="rack__gr" title="Gain reduction"></i>' : ''}</button>`;
			tabs.append(tab);
			if (m.id === 'comp') grEl = tab.querySelector('.rack__gr');
			const led = tab.querySelector('.rack__led');
			led.addEventListener('click', () => { audio(); P[m.id].on = !P[m.id].on; led.setAttribute('aria-pressed', P[m.id].on); apply(m.id); touch(`rack.${m.id}.on`, !P[m.id].on); });
			ctl[`rack.${m.id}.on`] = { get: () => P[m.id].on, set: v => { P[m.id].on = v; led.setAttribute('aria-pressed', v); apply(m.id); } };
			tab.querySelector('.rack__name').addEventListener('click', () => select(m.id));
			const pn = document.createElement('div');
			pn.className = 'rack__mod'; pn.hidden = true; pn.setAttribute('role', 'tabpanel');
			pn.innerHTML = `<div class="rack__head"><p class="rack__nod" title="${m.nod}">${m.nod}</p></div><div class="rack__knobs"></div>`;
			panels[m.id] = pn; panel.append(pn);
			const row = pn.querySelector('.rack__knobs'), head = pn.querySelector('.rack__head');
			for (const [key, lab, min, max, def, curve, fmt] of m.knobs) {
				const wrap = document.createElement('div');
				wrap.className = 'kn';
				wrap.innerHTML = `<span class="knob" aria-label="${m.name} ${lab}"></span><b class="kn__v"></b><small>${lab}</small>`;
				row.append(wrap);
				const out = wrap.querySelector('.kn__v'), list = Array.isArray(curve);
				const toReal = v => list ? Math.round(v) : curve === 'exp' ? min * (max / min) ** v : min + (max - min) * v;
				const toKnob = r => list ? r : curve === 'exp' ? Math.log(r / min) / Math.log(max / min) : (r - min) / (max - min);
				const show = () => {
					const r = P[m.id][key];
					out.textContent = list ? curve[r][0]
						: key === 'time' ? (P.dly.sync ? DIVS[Math.round(r * (DIVS.length - 1))][0] : ms(delaySec() * 1000)) : fmt(r);
				};
				if (key === 'time') hooks.push(show);
				const path = `rack.${m.id}.${key}`;
				const kn = knob(wrap.querySelector('.knob'), {
					min: 0, max: list ? curve.length - 1 : 1, step: list ? 1 : 0.005, value: toKnob(def),
					onInput: v => { const before = P[m.id][key]; P[m.id][key] = toReal(v); show(); apply(m.id); touch(path, before); },
				});
				ctl[path] = { get: () => P[m.id][key], set: r => { P[m.id][key] = r; kn.set(toKnob(r), false); show(); apply(m.id); } };
				show();
			}
			// extras: tempo sync for the delay, sidechain source for the compressor
			if (m.sync !== undefined) {
				const b = document.createElement('button');
				b.type = 'button'; b.className = 'rack__opt'; b.setAttribute('aria-pressed', 'true'); b.textContent = 'Sync';
				b.title = 'Snap the delay time to the metronome tempo';
				b.addEventListener('click', () => { P.dly.sync = !P.dly.sync; b.setAttribute('aria-pressed', P.dly.sync); hooks.forEach(f => f()); touch('rack.dly.sync', !P.dly.sync); });
				ctl['rack.dly.sync'] = { get: () => P.dly.sync, set: v => { P.dly.sync = v; b.setAttribute('aria-pressed', v); hooks.forEach(f => f()); } };
				head.append(b);
			}
			if (m.key !== undefined) {
				const b = document.createElement('button');
				b.type = 'button'; b.className = 'rack__opt'; b.title = 'Sidechain: which sound pumps the compressor (tap to cycle)';
				const lbl = () => { b.textContent = 'SC: ' + KEYS_SC.find(k => k[0] === P.comp.key)[1]; b.setAttribute('aria-pressed', P.comp.key !== 'off'); };
				b.addEventListener('click', () => { const before = P.comp.key, i = KEYS_SC.findIndex(k => k[0] === P.comp.key); P.comp.key = KEYS_SC[(i + 1) % KEYS_SC.length][0]; lbl(); applyComp(); touch('rack.comp.key', before); });
				ctl['rack.comp.key'] = { get: () => P.comp.key, set: v => { P.comp.key = v; lbl(); applyComp(); } };
				lbl(); head.append(b);
			}
		}
		select('rev');
	}

	// ── Pads ──
	let kit = 'soul';
	const voices = {}; // mute group → playing voice
	const els = KEY_LABELS.map((k, i) => {
		const b = document.createElement('button');
		b.type = 'button'; b.className = 'pad__btn';
		b.innerHTML = `<span class="pad__key">${k}</span><span class="pad__name"></span>`;
		grid.append(b);
		b.addEventListener('pointerdown', e => { if (e.button === 0) { e.preventDefault(); hit(i); } });
		b.addEventListener('click', e => { if (e.detail === 0) hit(i); }); // Enter/Space when tabbed to
		b.addEventListener('contextmenu', e => { e.preventDefault(); loadInto = i; audio(); fileIn.click(); });
		return b;
	});
	function label() {
		KITS[kit].pads.forEach((p, i) => {
			const own = custom[kit][i];
			els[i].querySelector('.pad__name').textContent = own ? own.name : p[0];
			els[i].dataset.c = own ? 'u' : p[3];
		});
		if (kitSel) { kitSel.value = kit; kitSel.classList.toggle('is-on', mode === 'pads'); }
		pad.querySelector('[data-mode="synth"]')?.classList.toggle('is-on', mode === 'synth');
	}
	function setMode(m) {
		mode = m;
		grid.hidden = m !== 'pads';
		const sy = pad.querySelector('.synth');
		if (sy) sy.hidden = m !== 'synth';
		if (m !== 'synth') synthUi?.panic();
		label();
	}
	const kitSel = pad.querySelector('.pad__kit');
	if (kitSel) {
		kitSel.innerHTML = KIT_ORDER.map(id => `<option value="${id}">${KITS[id].name}</option>`).join('');
		kitSel.addEventListener('change', () => { kit = kitSel.value; renderKit(kit); setMode('pads'); });
		kitSel.addEventListener('pointerdown', () => { if (mode !== 'pads') setMode('pads'); });
	}
	pad.querySelector('[data-mode="synth"]')?.addEventListener('click', () => setMode('synth'));
	label();

	async function hit(i) {
		const c = audio();
		if (c.state === 'suspended') c.resume();
		const own = custom[kit][i];
		if (!own && !buffers[kit]) await renderKit(kit);
		playPad(kit, i, c.currentTime);            // sound first; every visual waits until it's scheduled
		els[i].animate([{ transform: 'scale(0.93)', filter: 'brightness(1.9)' }, { transform: 'scale(1)', filter: 'brightness(1)' }],
			{ duration: 260, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)' });
		window.wiggler?.hit(own ? 'u' : KITS[kit].pads[i][3], i === 0 || /kick/i.test(KITS[kit].pads[i][0]) ? 1.2 : 0.8);
		roll?.capture(kit, i, 1);
		league?.score('p' + i);
	}
	// The sound itself, now or at a scheduled time (the piano roll books hits slightly ahead)
	function playPad(k, i, at, vel = 1) {
		const own = custom[k]?.[i], def = KITS[k]?.pads[i];
		const buf = own ? own.buffer : buffers[k]?.[i];
		if (!buf || !def) return;
		const group = own ? null : def[4], t = Math.max(ac.currentTime, at);
		if (group && voices[group]) { // choke: closed hat cuts open hat, a new 808 note cuts the last
			const v = voices[group];
			v.g.gain.setTargetAtTime(0, t, 0.008);
			v.src.stop(t + 0.05);
		}
		const src = ac.createBufferSource(), g = ac.createGain();
		src.buffer = buf; g.gain.value = vel;
		chain(src, g, !own && isKey(def) ? keyBus : bus);
		src.start(t);
		if (group) { voices[group] = { src, g }; src.onended = () => { if (voices[group]?.src === src) delete voices[group]; }; }
	}

	// ── Beats: loops picked for Nicky, played on the kits, to jam over with the pads or the synth ──
	// Each lane is [pad, pattern], one character per 16th note: x = hit, o = soft hit, 1-8 = the pad that many
	// steps on from `pad` (chords and bass notes), anything else = rest. Lanes loop at their own length.
	const D16 = (...bars) => bars.join('');
	const BEATS = [
		{ name: 'Amen jungle', kit: 'jungle', bpm: 168, swing: 0, lanes: [
			[0, D16('x.x.......xx....', '..xx......x.....')], [1, D16('....x..o.o..x..o', '.o..x..o.o....x.')],
			[3, 'x.x.x.x.x.x.x.x.'], [8, D16('1...............', '2...............')], [12, D16('1...........1...', '3.........3.....')]] },
		{ name: 'Liquid roller', kit: 'liquid', bpm: 174, swing: 0, lanes: [
			[0, 'x.........x.....'], [1, '....x.......x...'], [4, '.......o......o.'], [2, '..x...x...x...x.'], [5, 'o.o.o.o.o.o.o.o.'],
			[8, D16('1...............', '2...............')], [12, D16('1.........1.....', '2.........2.....')]] },
		{ name: 'Halftime dubstep', kit: 'dubstep', bpm: 140, swing: 0, lanes: [
			[0, D16('x.........x.....', 'x......x..x.....')], [1, '........x.......'], [2, 'x.o.x.o.x.o.x.o.'],
			[4, D16('x...............', '................')], [6, D16('................', '...............x')],
			[12, D16('1.1.....1...1.1.', '2.2.....2...2...')]] },
		{ name: 'UK garage 2-step', kit: 'house', bpm: 132, swing: 0.2, lanes: [
			[0, D16('x.........x.....', 'x......x..x.....')], [1, '....x.......x...'], [2, '..x...x...x...x.'], [5, '.......o.o.....o'],
			[8, D16('1..1..1.........', '2..2..2.........')], [12, D16('1.........1.....', '2.........2.....')]] },
		{ name: 'Deep house', kit: 'house', bpm: 124, swing: 0.1, lanes: [
			[0, 'x...x...x...x...'], [1, '....x.......x...'], [3, '..x...x...x...x.'], [4, '.o.o.o.o.o.o.o.o'],
			[8, D16('...1..1....1....', '...2..2....2....')], [12, D16('..1...1...1...1.', '..2...2...2...2.')]] },
		{ name: 'Roller disco', kit: 'disco', bpm: 118, swing: 0, lanes: [
			[0, 'x...x...x...x...'], [1, '....x.......x...'], [3, '..x...x...x...x.'], [4, 'o.o.o.o.o.o.o.o.'], [6, '......o..o....o.'],
			[8, D16('1...............', '2...............', '3...............', '4...............')],
			[12, D16('1.1.....1.1...1.', '2.2.....2.2...2.', '3.3.....3.3...3.', '4.4.....4.4...4.')]] },
		{ name: 'Boom bap soul', kit: 'soul', bpm: 90, swing: 0.25, lanes: [
			[0, 'x......x..x.....'], [1, '....x.......x...'], [2, 'x.x.x.x.x.x.x.x.'],
			[8, D16('1...............', '2...............')], [14, D16('1......1..1.....', '2......2..2.....')]] },
		{ name: 'Trap 808', kit: '808', bpm: 140, swing: 0, lanes: [
			[0, D16('x.........x.....', 'x......x..x.....')], [2, '........x.......'], [3, 'x.x.x.x.x.x.xxxx'],
			[8, D16('1.........1.....', '3......3..2.....')]] },
	];
	let beatOn = null, beatNext = null, bStep = 0, bAt = 0, bTimer = 0;
	function flash(i, at) {
		setTimeout(() => els[i].animate([{ filter: 'brightness(1.9)' }, { filter: 'brightness(1)' }], { duration: 180 }), Math.max(0, (at - ac.currentTime) * 1000));
	}
	function beatHit(b, i, at, vel) { playPad(b.kit, i, at, vel); if (b.kit === kit && mode === 'pads') flash(i, at); }
	function beatTick() { // books the next ~120 ms of hits ahead of time, so the groove never waits on the page
		while (beatOn && bAt < ac.currentTime + 0.12) {
			if (bStep % 16 === 0 && beatNext) { useBeat(beatNext); bStep = 0; } // switch beats on the next bar
			const b = beatOn, spb = 60 / (metro?.bpm || b.bpm) / 4, at = bAt + (bStep % 2 ? b.swing * spb : 0);
			for (const [p, pat] of b.lanes) {
				const ch = pat[bStep % pat.length];
				if (ch === 'x' || ch === 'o') beatHit(b, p, at, ch === 'x' ? 1 : 0.45);
				else if (ch >= '1' && ch <= '8') beatHit(b, p + (+ch - 1), at, 0.9);
			}
			if (bStep % 4 === 0) { const acc = bStep % 16 === 0; setTimeout(() => window.wiggler?.beat(acc), Math.max(0, (at - ac.currentTime) * 1000)); }
			bStep++; bAt += spb;
		}
	}
	function useBeat(b) {
		beatOn = b; beatNext = null;
		ctl['metro.bpm']?.set(b.bpm);
		if (mode === 'pads' && kit !== b.kit) { kit = b.kit; label(); }
		beatUi();
	}
	async function beatPlay(b) {
		const c = audio();
		if (c.state === 'suspended') c.resume();
		await renderKit(b.kit);
		if (beatOn) { beatNext = b; return; } // already rolling: change over on the next bar
		useBeat(b); bStep = 0; bAt = c.currentTime + 0.08;
		bTimer = setInterval(beatTick, 25); beatTick();
	}
	function beatStop() { clearInterval(bTimer); bTimer = 0; beatOn = beatNext = null; beatUi(); }
	const beatBar = document.createElement('div');
	beatBar.className = 'beats'; beatBar.setAttribute('role', 'group'); beatBar.setAttribute('aria-label', 'Beats to jam over');
	beatBar.innerHTML = `<select class="track beats__pick" aria-label="Pick a beat">${BEATS.map((b, i) => `<option value="${i}">${b.name} · ${b.bpm}</option>`).join('')}</select><button class="track beats__go" type="button" aria-pressed="false">▶ Play beat</button>`;
	grid.before(beatBar);
	const beatPick = beatBar.querySelector('.beats__pick'), beatGo = beatBar.querySelector('.beats__go');
	function beatUi() {
		beatGo.textContent = beatOn ? '■ Stop beat' : '▶ Play beat';
		beatGo.setAttribute('aria-pressed', String(!!beatOn)); beatGo.classList.toggle('is-on', !!beatOn);
	}
	beatGo.addEventListener('click', () => beatOn ? beatStop() : beatPlay(BEATS[beatPick.value]));
	beatPick.addEventListener('change', () => { if (beatOn) beatPlay(BEATS[beatPick.value]); });

	// Most sample files start with a few ms of silence; cut it so the hit lands the instant you tap.
	function trim(buf) {
		const d = buf.getChannelData(0);
		let i = 0;
		while (i < d.length && Math.abs(d[i]) < 0.003) i++;
		i = Math.max(0, i - Math.round(buf.sampleRate * 0.0005)); // keep 0.5 ms so the attack doesn't click
		if (i < buf.sampleRate * 0.002 || i >= d.length) return buf;
		const out = ac.createBuffer(buf.numberOfChannels, buf.length - i, buf.sampleRate);
		for (let ch = 0; ch < buf.numberOfChannels; ch++) out.copyToChannel(buf.getChannelData(ch).subarray(i), ch);
		return out;
	}

	// Right-click a pad → load your own sound into it (this kit only, this visit only).
	let loadInto = -1;
	fileIn.addEventListener('change', async () => {
		const f = fileIn.files[0];
		fileIn.value = '';
		if (!f || loadInto < 0) return;
		if (f.size > 15e6) { alert('That file is a bit big. Try something under 15 MB.'); return; }
		try {
			const buffer = trim(await audio().decodeAudioData(await f.arrayBuffer()));
			custom[kit][loadInto] = { buffer, name: f.name.replace(/\.[^.]+$/, '').slice(0, 14) };
			label();
			hit(loadInto);
		} catch {
			alert("Couldn't read that one. WAV, MP3, OGG or M4A work best.");
		}
	});

	// ── Knobs: drag up/down (Shift = fine), mouse wheel, or arrow keys when focused. Double-click resets. ──
	function knob(el, { min, max, step, value, onInput, keyStep = Math.max(step, (max - min) / 50) }) {
		const def = value;
		const set = (v, fire = true) => {
			v = Math.min(max, Math.max(min, Math.round(v / step) * step));
			value = +v.toFixed(3);
			el.style.setProperty('--a', `${-135 + (value - min) / (max - min) * 270}deg`);
			el.setAttribute('aria-valuenow', value);
			if (fire) onInput(value);
		};
		Object.assign(el, { tabIndex: 0 });
		el.setAttribute('role', 'slider');
		el.setAttribute('aria-valuemin', min); el.setAttribute('aria-valuemax', max);
		let y0 = 0, v0 = 0;
		el.addEventListener('pointerdown', e => { e.preventDefault(); el.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = value; el.focus(); });
		el.addEventListener('pointermove', e => {
			if (!el.hasPointerCapture(e.pointerId)) return;
			const px = Math.min(700, Math.max(150, (max - min) / step * 2.5)) * (e.shiftKey ? 4 : 1); // pixels for the full sweep
			set(v0 + (y0 - e.clientY) / px * (max - min));
		});
		el.addEventListener('wheel', e => { e.preventDefault(); set(value - Math.sign(e.deltaY) * step); }, { passive: false });
		el.addEventListener('keydown', e => {
			const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
			if (!d) return;
			e.preventDefault(); e.stopPropagation(); set(value + d * keyStep * (e.shiftKey ? 0.2 : 1));
		});
		el.addEventListener('dblclick', () => set(def));
		set(value, false);
		return { get: () => value, set };
	}

	// ── Metronome: clicks are scheduled on the audio clock (not timers), so they never drift ──
	const metro = (() => {
		const box = pad.querySelector('.metro');
		if (!box) return { stop() {} };
		const out = box.querySelector('.metro__bpm'), led = box.querySelector('.metro__led'), onBtn = box.querySelector('.metro__on');
		let bpm = 120, running = false, timer = 0, next = 0, beat = 0, clicks = null, gain = null, lastAt = 0, lastIdx = -1;
		const show = () => { out.textContent = bpm.toFixed(1); if (tempo !== bpm) { tempo = bpm; hooks.forEach(f => f()); } };
		const setBpm = v => { bpm = Math.min(300, Math.max(30, +v.toFixed(1))); show(); coarse.set(Math.floor(bpm), false); fine.set(+(bpm % 1).toFixed(1), false); };
		const coarse = knob(box.querySelector('[data-knob="coarse"]'), { min: 30, max: 300, step: 1, keyStep: 1, value: 120, onInput: v => { const before = bpm; bpm = v + fine.get(); show(); touch('metro.bpm', before); } });
		const fine = knob(box.querySelector('[data-knob="fine"]'), { min: 0, max: 0.9, step: 0.1, keyStep: 0.1, value: 0, onInput: v => { const before = bpm; bpm = coarse.get() + v; show(); touch('metro.bpm', before); } });
		ctl['metro.bpm'] = { get: () => bpm, set: v => setBpm(v) };
		async function makeClicks() { // two short blips, pre-rendered like the pads
			const one = async (f, len) => {
				const c = new OfflineAudioContext(1, Math.ceil(SR * len), SR), o = c.createOscillator();
				o.frequency.value = f; chain(o, envGain(c, 0, 0.0005, 0.6, len - 0.002), c.destination); o.start(0);
				return c.startRendering();
			};
			return Promise.all([one(1760, 0.03), one(1175, 0.025)]);
		}
		function tick() {
			while (next < ac.currentTime + 0.12) {
				const src = ac.createBufferSource(), accent = beat % 4 === 0, at = next;
				src.buffer = clicks[accent ? 0 : 1]; chain(src, gain); src.start(at);
				setTimeout(() => {
					led.classList.toggle('is-accent', accent);
					led.animate([{ opacity: 1 }, { opacity: 0.15 }], { duration: 120 });
					window.wiggler?.beat(accent);
				}, Math.max(0, (at - ac.currentTime) * 1000));
				lastAt = at; lastIdx = beat;
				next += 60 / bpm; beat++;
			}
		}
		async function start() {
			if (running) return;
			audio(); if (ac.state === 'suspended') await ac.resume();
			clicks ||= await makeClicks();
			if (!gain) { gain = ac.createGain(); gain.gain.value = 0.5; gain.connect(clickBus); }
			running = true; beat = 0; next = ac.currentTime + 0.06;
			tick(); timer = setInterval(tick, 25);
			onBtn.setAttribute('aria-pressed', 'true');
		}
		function stop() { running = false; clearInterval(timer); onBtn.setAttribute('aria-pressed', 'false'); }
		onBtn.addEventListener('click', () => running ? stop() : start());
		// Tap tempo: the tempo is set on the 3rd tap, then keeps refining (average of the last 6 taps).
		const taps = [];
		box.querySelector('.metro__tap').addEventListener('pointerdown', e => {
			e.preventDefault();
			const now = performance.now();
			if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
			taps.push(now); if (taps.length > 6) taps.shift();
			e.currentTarget.animate([{ background: 'var(--orange)' }, { background: 'transparent' }], { duration: 150 });
			if (taps.length < 3) return;
			const before = bpm;
			setBpm(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
			touch('metro.bpm', before);
		});
		show();
		// The beat grid the loop bank locks to: first beat (or bar line, if `bar`) at or after `after`
		function nextBeat(after, bar) {
			const spb = 60 / bpm;
			let k = Math.ceil((after - lastAt) / spb - 1e-6);
			while (bar && (lastIdx + k) % 4 !== 0) k++;
			return lastAt + k * spb;
		}
		return { stop, start, nextBeat, get running() { return running; }, get bpm() { return bpm; } };
	})();

	// ── Loop bank: 8 slots you record right here, RC-505 style ──
	// Empty slot → count-in (a bar of click) → records from the downbeat → tap again to stop (snapped to whole
	// beats) → it loops, locked to the beat grid. Then each tap is play/pause. Long-press or Del clears a slot.
	const loops = (() => {
		const box = pad.querySelector('.loops');
		if (!box) return null;
		const LKEYS = ['Digit5', 'Digit6', 'Digit7', 'Digit8', 'KeyT', 'KeyY', 'KeyU', 'KeyI'], LLAB = ['5', '6', '7', '8', 'T', 'Y', 'U', 'I'];
		const REPS = [['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125]];
		const opt = { loop: true, count: true, rev: false, mic: false, rep: 1 };
		const S = LLAB.map(() => ({ state: 'empty', buf: null, rbuf: null, anchor: 0, src: null, g: null, playAt: 0, off: 0 }));
		let recSlot = -1, pending = null, delMode = false, micSrc = null, scratch = null, repeats = [];
		const spb = () => 60 / tempo;

		box.innerHTML = `<div class="loops__slots"></div><div class="loops__bar">
			<button type="button" class="chip" data-o="loop" aria-pressed="true" title="On: slots loop. Off: one-shot, each tap plays it once">Loop</button>
			<button type="button" class="chip" data-o="count" aria-pressed="true" title="Count-in: a bar of click first, recording starts on the downbeat and snaps to whole beats">Count-in</button>
			<button type="button" class="chip" data-o="mic" aria-pressed="false" title="Record source: the pads (with FX), or your microphone">Src: Pads</button>
			<button type="button" class="chip" data-o="rev" aria-pressed="false" title="Play the loops backwards">Rev</button>
			<button type="button" class="chip chip--hold" data-o="scratch" title="Hold to scratch the loops">Scratch</button>
			<button type="button" class="chip chip--hold" data-o="repeat" title="Hold to beat-repeat the loops; let go and they snap back in time">Repeat</button>
			<button type="button" class="chip" data-o="rep" title="Beat-repeat size">1/8</button>
			<button type="button" class="chip chip--del" data-o="del" aria-pressed="false" title="Tap Del, then the slot to clear (or long-press a slot)">Del</button>
			<button type="button" class="chip chip--view" data-o="roll" aria-pressed="false" title="Piano roll: record, draw and loop notes for the synth and pads">Roll</button>
			<button type="button" class="chip chip--view" data-o="league" aria-pressed="false" title="Wiggle League: your score and the leaderboard">🏆 0</button>
		</div>`;
		const slotEls = LLAB.map((k, i) => {
			const b = document.createElement('button');
			b.type = 'button'; b.className = 'loop'; b.dataset.s = 'empty';
			b.innerHTML = `<span class="loop__key">${k}</span><span class="loop__txt"></span>`;
			b.setAttribute('aria-label', `Loop slot ${k}`);
			box.querySelector('.loops__slots').append(b);
			let hold = 0, held = false;
			b.addEventListener('pointerdown', e => {
				if (e.button) return;
				e.preventDefault(); held = false;
				hold = setTimeout(() => { held = true; clear(i); }, 650);
				tap(i);
			});
			for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(hold));
			b.addEventListener('click', e => { if (e.detail === 0) tap(i); });
			b.addEventListener('contextmenu', e => e.preventDefault());
			return b;
		});
		const chip = o => box.querySelector(`[data-o="${o}"]`);

		// ── Recording ──
		async function ensureMic() {
			if (micSrc) return true;
			try {
				const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
				micSrc = ac.createMediaStreamSource(stream);
				return true;
			} catch {
				alert("Couldn't open your microphone. Check the browser's permission for this site.");
				return false;
			}
		}
		function route() { // feed the recorder from the pads or the mic
			if (!recNode) return;
			try { recTap.disconnect(recNode); } catch {}
			try { micSrc?.disconnect(recNode); } catch {}
			(opt.mic && micSrc ? micSrc : recTap).connect(recNode);
		}
		// The mic hears you late: your ears get the click after the output latency, and the mic adds its own.
		const micLag = () => opt.mic ? (ac.baseLatency || 0) + (ac.outputLatency || 0) + 0.01 : 0;
		async function record(i) {
			audio(); if (ac.state === 'suspended') await ac.resume();
			try { await workletReady; } catch { alert('Recording needs a newer browser (AudioWorklet).'); return; }
			if (opt.mic && !(await ensureMic())) return;
			recNode.port.onmessage = e => onRecorded(e.data);
			route();
			let at;
			if (opt.count) {
				await metro.start();
				at = metro.nextBeat(ac.currentTime + spb() * 3, true); // at least 3 clicks, then the next bar line
			} else at = ac.currentTime + 0.01;
			Object.assign(S[i], { state: 'armed', startAt: at });
			recSlot = i;
			recNode.port.postMessage({ start: at + micLag() });
			setTimeout(() => { if (recSlot === i) window.wiggler?.hit('h', 1); }, Math.max(0, (at - ac.currentTime) * 1000));
		}
		function stopRec(i) {
			const s = S[i], t = ac.currentTime;
			if (t < s.startAt) { recNode.port.postMessage({ cancel: true }); s.state = 'empty'; recSlot = -1; return; } // still counting in
			let end = t;
			if (opt.count && metro.running) end = s.startAt + Math.max(1, Math.round((t - s.startAt) / spb())) * spb();
			pending = { i, len: Math.round((end - s.startAt) * ac.sampleRate), end };
			s.state = 'finishing';
			recNode.port.postMessage({ stop: Math.max(end + micLag(), t) });
		}
		function onRecorded({ L, R }) {
			const p = pending || { i: recSlot, len: L.length, end: ac.currentTime };
			pending = null; recSlot = -1;
			if (p.i < 0) return; // the slot was cleared mid-recording
			const s = S[p.i], len = Math.min(p.len, L.length);
			if (len < ac.sampleRate * 0.05) { s.state = 'empty'; return; } // nothing really recorded
			const buf = ac.createBuffer(2, len, ac.sampleRate), rbuf = ac.createBuffer(2, len, ac.sampleRate);
			[L, R].forEach((d, ch) => {
				const fade = Math.min(64, len >> 2), c = d.subarray(0, len), r = rbuf.getChannelData(ch);
				for (let k = 0; k < fade; k++) { c[k] *= k / fade; c[len - 1 - k] *= k / fade; } // de-click the loop seam
				buf.copyToChannel(c, ch);
				for (let k = 0; k < len; k++) r[k] = c[len - 1 - k];
			});
			Object.assign(s, { buf, rbuf, anchor: s.startAt, state: 'stopped' });
			play(p.i, Math.max(p.end, ac.currentTime + 0.005)); // starts right where the recording ended, so it stays in time
			persist();
			league?.bonus(100);
		}

		// ── Playback, phase-locked to the loop's own downbeat so everything stays in time ──
		const locked = () => metro.running || S.some(s => s.state === 'playing');
		function play(i, at) {
			const s = S[i];
			stopVoice(s);
			const t = at ?? (opt.count && metro.running ? metro.nextBeat(ac.currentTime + 0.01) : ac.currentTime + 0.005);
			const dur = s.buf.duration;
			let off = 0;
			if (opt.loop && (at !== undefined || locked())) {
				off = ((t - s.anchor) % dur + dur) % dur;
				if (opt.rev) off = (dur - off) % dur;
			} else s.anchor = t;
			const src = ac.createBufferSource(), g = ac.createGain();
			src.buffer = opt.rev ? s.rbuf : s.buf;
			src.loop = opt.loop;
			chain(src, g, loopIn);
			src.start(t, off);
			Object.assign(s, { src, g, playAt: t, off, state: 'playing' });
			src.onended = () => { if (s.src === src) { s.src = null; s.state = 'stopped'; } };
		}
		function stopVoice(s) {
			if (!s.src) return;
			const t = ac.currentTime;
			s.g.gain.setTargetAtTime(0, t, 0.005);
			s.src.onended = null; s.src.stop(t + 0.03);
			s.src = null;
		}
		function pause(i) { stopVoice(S[i]); S[i].state = 'stopped'; }
		function clear(i) {
			const s = S[i];
			if (recSlot === i) { recNode?.port.postMessage({ cancel: true }); recSlot = -1; pending = null; }
			stopVoice(s);
			const had = !!s.buf;
			Object.assign(s, { state: 'empty', buf: null, rbuf: null });
			if (had) persist();
			slotEls[i].animate([{ filter: 'brightness(2.5)' }, { filter: 'none' }], { duration: 250 });
		}
		function tap(i) {
			audio();
			if (delMode) { clear(i); setDel(false); return; }
			const s = S[i];
			if (recSlot >= 0 && recSlot !== i) { if (S[recSlot].state !== 'finishing') stopRec(recSlot); return; }
			if (s.state === 'empty') record(i);
			else if (s.state === 'armed' || s.state === 'recording') stopRec(i);
			else if (s.state === 'playing') opt.loop ? pause(i) : play(i, ac.currentTime + 0.005);
			else if (s.state === 'stopped') opt.loop ? play(i) : play(i, ac.currentTime + 0.005);
		}
		// Recorded loops are kept in this browser, so they're still here next visit
		const persist = () => store.put('loops', S.map(s => s.buf ? { L: s.buf.getChannelData(0).slice(), R: s.buf.getChannelData(1).slice(), sr: s.buf.sampleRate } : null));
		let saved = null;
		function materialize() {
			if (!ac || !saved) return;
			saved.forEach((d, i) => {
				if (!d || S[i].buf) return;
				const buf = ac.createBuffer(2, d.L.length, d.sr), rbuf = ac.createBuffer(2, d.L.length, d.sr);
				[d.L, d.R].forEach((c, ch) => { buf.copyToChannel(c, ch); const r = rbuf.getChannelData(ch); for (let k = 0; k < c.length; k++) r[k] = c[c.length - 1 - k]; });
				Object.assign(S[i], { buf, rbuf, anchor: 0, state: 'stopped' });
			});
			saved = null;
		}
		function setDel(on) { delMode = on; chip('del').setAttribute('aria-pressed', on); box.classList.toggle('is-del', on); }

		// ── Loop FX: reverse, scratch, beat repeat ──
		const playing = () => S.map((s, i) => [s, i]).filter(([s]) => s.state === 'playing' && s.src);
		const resync = () => { for (const [, i] of playing()) play(i, ac.currentTime + 0.01); };
		function scratchOn() {
			if (scratch || !playing().length) return;
			const t = ac.currentTime, wob = ac.createOscillator(), depth = ac.createGain(), chop = ac.createOscillator(), cut = ac.createGain();
			wob.frequency.value = tempo / 60 * 2; depth.gain.value = 0.85; // forward-back hand motion, twice a beat
			chop.type = 'square'; chop.frequency.value = tempo / 60 * 4; cut.gain.value = 0.5; // crossfader chops on 16ths
			wob.connect(depth);
			for (const [s] of playing()) depth.connect(s.src.playbackRate);
			loopIn.gain.setValueAtTime(0.5, t); chain(chop, cut, loopIn.gain);
			wob.start(t); chop.start(t);
			scratch = { wob, chop };
			window.wiggler?.hit('h', 1.2);
		}
		function scratchOff() {
			if (!scratch) return;
			const t = ac.currentTime;
			scratch.wob.stop(t); scratch.chop.stop(t); scratch = null;
			loopIn.gain.cancelScheduledValues(t); loopIn.gain.setValueAtTime(1, t);
			resync(); // the scratch drifted the loops; drop them back on the grid
		}
		function repeatOn() {
			if (repeats.length) return;
			const t = ac.currentTime + 0.005, slice = REPS[opt.rep][1] * spb();
			for (const [s] of playing()) {
				const dur = s.src.buffer.duration, pos = (s.off + (t - s.playAt)) % dur;
				const start = Math.floor(pos / slice) * slice, end = Math.min(dur, start + slice);
				const src = ac.createBufferSource(), g = ac.createGain();
				src.buffer = s.src.buffer; src.loop = true; src.loopStart = start; src.loopEnd = end;
				chain(src, g, loopIn); src.start(t, start);
				s.g.gain.setTargetAtTime(0, t, 0.003); // the original keeps running silently underneath
				repeats.push({ src, g, s });
			}
			if (repeats.length) window.wiggler?.hit('k', 1);
		}
		function repeatOff() {
			const t = ac.currentTime;
			for (const r of repeats) { r.g.gain.setTargetAtTime(0, t, 0.003); r.src.stop(t + 0.02); r.s.g?.gain.setTargetAtTime(1, t, 0.003); }
			repeats = [];
		}
		const hold = (o, on, off) => {
			const b = chip(o);
			b.addEventListener('pointerdown', e => { e.preventDefault(); b.setAttribute('aria-pressed', 'true'); audio(); on(); });
			for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => { if (b.getAttribute('aria-pressed') === 'true') { b.setAttribute('aria-pressed', 'false'); off(); } });
		};
		hold('scratch', scratchOn, scratchOff);
		hold('repeat', repeatOn, repeatOff);
		chip('loop').addEventListener('click', e => {
			opt.loop = !opt.loop; e.currentTarget.setAttribute('aria-pressed', opt.loop);
			for (const [s] of playing()) s.src.loop = opt.loop;
		});
		chip('count').addEventListener('click', e => { opt.count = !opt.count; e.currentTarget.setAttribute('aria-pressed', opt.count); });
		chip('rev').addEventListener('click', e => {
			opt.rev = !opt.rev; e.currentTarget.setAttribute('aria-pressed', opt.rev);
			if (ac) resync();
		});
		chip('mic').addEventListener('click', async e => {
			const b = e.currentTarget;
			audio();
			if (!opt.mic && !(await ensureMic())) return;
			opt.mic = !opt.mic; b.setAttribute('aria-pressed', opt.mic); b.textContent = opt.mic ? 'Src: Mic' : 'Src: Pads';
			route();
		});
		chip('rep').addEventListener('click', e => { opt.rep = (opt.rep + 1) % REPS.length; e.currentTarget.textContent = REPS[opt.rep][0]; });
		chip('del').addEventListener('click', () => setDel(!delMode));

		// ── Slot lights: count-in countdown, recording beat count, playback progress ──
		let raf = 0;
		function ui() {
			raf = rig.open ? requestAnimationFrame(ui) : 0;
			if (!ac) return;
			const t = ac.currentTime;
			S.forEach((s, i) => {
				const el = slotEls[i], txt = el.firstChild.nextSibling;
				if (s.state === 'armed' && t >= s.startAt) s.state = 'recording';
				el.dataset.s = s.state;
				if (s.state === 'armed') txt.textContent = Math.ceil((s.startAt - t) / spb());
				else if (s.state === 'recording') txt.textContent = opt.count && metro.running ? Math.floor((t - s.startAt) / spb()) + 1 : (t - s.startAt).toFixed(1);
				else if (s.state === 'playing') {
					const d = s.buf.duration, ph = ((s.off + Math.max(0, t - s.playAt)) % d) / d;
					el.style.setProperty('--p', (opt.rev ? 1 - ph : ph).toFixed(3));
					txt.textContent = '';
				} else txt.textContent = s.state === 'empty' ? '' : s.state === 'finishing' ? '…' : '';
			});
		}
		addEventListener('keydown', e => {
			if (!rig.open || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
			if (mode === 'synth' && e.code.startsWith('Key')) return; // T-I belong to the piano in synth mode
			const i = LKEYS.indexOf(e.code);
			if (i < 0) return;
			e.preventDefault(); tap(i);
		});
		return {
			wake() { materialize(); if (!raf) raf = requestAnimationFrame(ui); },
			load(arr) { saved = arr; materialize(); },
			sleep() { S.forEach((s, i) => { if (recSlot === i) clear(i); else if (s.state === 'playing') pause(i); }); repeatOff(); scratchOff(); setDel(false); },
		};
	})();

	// ── PianiSynth panel: patch bank, four pages of knobs, ADSR target LEDs, and a playable keyboard ──
	const synthUi = (() => {
		const box = pad.querySelector('.synth'), PS = window.PianiSynth;
		if (!box || !PS) return null;
		const SP = { ...PS.INIT };               // the sound you're hearing right now
		const bankB = Array(128).fill(null);     // your own patches: { name, p }
		let patch = 'A:0', dirty = false, eng = null, octave = 0;
		const engine = () => {
			if (!eng) { audio(); eng = PS.createEngine(ac, bus); eng.load(SP); }
			return eng;
		};
		const pct = v => Math.round(v * 100) + '%', hzf = v => v < 1000 ? Math.round(v) + ' Hz' : (v / 1000).toFixed(1) + ' kHz';
		const secs = v => v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s';
		const SEMIS = Array.from({ length: 49 }, (_, i) => i - 24), sgn = v => (v > 0 ? '+' : '') + v;
		// [key, label, min, max, curve, format] or [key, label, values, labels]
		const PAGES = {
			Osc: [['w1', 'Osc 1', [0, 1, 2, 3], PS.WAVES], ['w2', 'Osc 2', [0, 1, 2, 3], PS.WAVES], ['pw', 'Pulse W', 0.05, 0.95, 'lin', pct],
				['pwm', 'PWM', 0, 1, 'lin', pct], ['mix', 'Osc 2 lvl', 0, 1, 'lin', pct]],
			Tone: [['det', 'Detune', 0, 50, 'lin', v => Math.round(v) + 'c'], ['semi', 'Osc 2 st', SEMIS, SEMIS.map(sgn)],
				['fm', 'FM', 0, 10, 'lin', v => v.toFixed(1)], ['ratio', 'FM ratio', PS.RATIOS.map((_, i) => i), PS.RATIOS.map(r => r + ':1')],
				['lfo', 'PWM rate', 0.05, 12, 'exp', v => v.toFixed(2) + ' Hz']],
			Filter: [['cut', 'Cutoff', 40, 18000, 'exp', hzf], ['res', 'Reso', 0, 20, 'lin', v => v.toFixed(1)], ['famt', 'Env→Filt', 0, 1, 'lin', pct],
				['pamt', 'Env→Pitch', SEMIS, SEMIS.map(v => sgn(v) + 'st')], ['lvl', 'Level', 0, 1, 'lin', pct]],
			Env: [['a', 'Attack', 0.001, 4, 'exp', secs], ['d', 'Decay', 0.01, 4, 'exp', secs], ['s', 'Sustain', 0, 1, 'lin', pct],
				['r', 'Release', 0.01, 6, 'exp', secs], ['glide', 'Glide', 0, 1, 'lin', secs]],
		};

		box.innerHTML = `<div class="synth__bar">
				<button type="button" class="chip synth__prev" aria-label="Previous patch">◀</button>
				<select class="synth__patch" aria-label="Patch"></select>
				<button type="button" class="chip synth__next" aria-label="Next patch">▶</button>
				<button type="button" class="chip synth__save" title="Save this sound into a B slot">Save</button>
				<button type="button" class="chip synth__export" title="Download your B bank as a file">⇩</button>
				<button type="button" class="chip synth__import" title="Load a B bank file">⇧</button>
				<input type="file" class="synth__file" accept=".json,application/json" hidden>
			</div>
			<div class="rack synth__rack"><div class="rack__tabs synth__tabs" role="tablist"></div><div class="synth__pages"></div></div>
			<div class="keys"><button type="button" class="chip keys__oct" data-d="-1" aria-label="Octave down">−</button><div class="keys__bed"></div><button type="button" class="chip keys__oct" data-d="1" aria-label="Octave up">+</button></div>`;
		const sel = box.querySelector('.synth__patch'), tabs = box.querySelector('.synth__tabs'), pages = box.querySelector('.synth__pages');

		// ── Knob pages ──
		const views = {};
		const touchSP = (k, before) => { if (!restoring) { dirty = true; markDirty(); } touch('synth.' + k, before); };
		const setSP = (k, v) => { SP[k] = v; if (eng) { eng.P[k] = v; eng.live(); } };
		for (const [name, knobs] of Object.entries(PAGES)) {
			const t = document.createElement('button');
			t.type = 'button'; t.className = 'rack__name synth__tab'; t.textContent = name; t.setAttribute('role', 'tab');
			t.addEventListener('click', () => show(name));
			tabs.append(t);
			const pg = document.createElement('div');
			pg.className = 'rack__mod'; pg.hidden = true;
			pg.innerHTML = `<div class="rack__head"></div><div class="rack__knobs"></div>`;
			views[name] = { tab: t, pg };
			pages.append(pg);
			const row = pg.querySelector('.rack__knobs');
			for (const [k, label, a, b, curve, fmt] of knobs) {
				const list = Array.isArray(a);
				const wrap = document.createElement('div');
				wrap.className = 'kn';
				wrap.innerHTML = `<span class="knob" aria-label="Synth ${label}"></span><b class="kn__v"></b><small>${label}</small>`;
				row.append(wrap);
				const out = wrap.querySelector('.kn__v');
				const toReal = v => list ? a[Math.round(v)] : curve === 'exp' ? a * (b / a) ** v : a + (b - a) * v;
				const toKnob = r => list ? Math.max(0, a.indexOf(r)) : curve === 'exp' ? Math.log(r / a) / Math.log(b / a) : (r - a) / (b - a);
				const showV = () => { out.textContent = list ? b[Math.max(0, a.indexOf(SP[k]))] : fmt(SP[k]); };
				const kn = knob(wrap.querySelector('.knob'), {
					min: 0, max: list ? a.length - 1 : 1, step: list ? 1 : 0.005, keyStep: list ? 1 : undefined, value: toKnob(SP[k]),
					onInput: v => { const before = SP[k]; setSP(k, toReal(v)); showV(); touchSP(k, before); },
				});
				ctl['synth.' + k] = { get: () => SP[k], set: r => { setSP(k, r); kn.set(toKnob(r), false); showV(); } };
				showV();
			}
		}
		// Filter type chip + the ADSR target LEDs (red = the envelope drives it)
		const head = n => views[n].pg.querySelector('.rack__head');
		const ftChip = document.createElement('button');
		ftChip.type = 'button'; ftChip.className = 'rack__opt'; ftChip.title = 'Filter type';
		const ftShow = () => { ftChip.textContent = ['Low-pass', 'Band-pass', 'High-pass'][SP.ft]; };
		ftChip.addEventListener('click', () => { const before = SP.ft; setSP('ft', (SP.ft + 1) % 3); ftShow(); touchSP('ft', before); });
		ctl['synth.ft'] = { get: () => SP.ft, set: v => { setSP('ft', v); ftShow(); } };
		head('Filter').append(Object.assign(document.createElement('p'), { className: 'rack__nod', textContent: 'Subtractive filter, per voice' }), ftChip);
		ftShow();
		head('Env').append(Object.assign(document.createElement('p'), { className: 'rack__nod', textContent: 'ADSR drives:' }));
		for (const [k, label] of [['tA', 'Amp'], ['tF', 'Filt'], ['tP', 'Pitch'], ['tM', 'FM']]) {
			const b = document.createElement('button');
			b.type = 'button'; b.className = 'rack__opt synth__led'; b.textContent = label;
			b.title = `Envelope → ${label}`;
			const ledShow = () => b.setAttribute('aria-pressed', !!SP[k]);
			b.addEventListener('click', () => { const before = SP[k]; setSP(k, !SP[k]); ledShow(); touchSP(k, before); });
			ctl['synth.' + k] = { get: () => SP[k], set: v => { setSP(k, v); ledShow(); } };
			head('Env').append(b);
			ledShow();
		}
		head('Osc').append(Object.assign(document.createElement('p'), { className: 'rack__nod', textContent: 'Subtractive + FM hybrid. Pulse width + PWM for the juicy stuff' }));
		head('Tone').append(Object.assign(document.createElement('p'), { className: 'rack__nod', textContent: 'FM: a sine modulator on both oscillators' }));
		function show(name) { for (const [n, v] of Object.entries(views)) { v.pg.hidden = n !== name; v.tab.setAttribute('aria-selected', n === name); } }
		show('Osc');

		// ── Patches: bank A = 128 factory sounds (tweak freely, but they can't be overwritten), bank B = yours ──
		const nm = id => { const [bk, i] = id.split(':'); return bk === 'A' ? PS.PRESETS[i].name : bankB[i]?.name || 'empty'; };
		const num = id => id[0] + String(+id.slice(2) + 1).padStart(3, '0');
		function fill() {
			const og = bk => {
				const g = document.createElement('optgroup');
				g.label = bk === 'A' ? 'Bank A · factory' : 'Bank B · yours';
				for (let i = 0; i < 128; i++) { const id = `${bk}:${i}`; g.append(new Option(`${num(id)}  ${nm(id)}`, id)); }
				return g;
			};
			sel.replaceChildren(og('A'), og('B'));
			sel.value = patch;
			markDirty();
		}
		function markDirty() {
			const o = sel.querySelector(`option[value="${patch}"]`);
			if (o) o.textContent = `${num(patch)}  ${nm(patch)}${dirty ? ' *' : ''}`;
		}
		function load(id) {
			const [bk, i] = id.split(':');
			const src = bk === 'A' ? PS.PRESETS[i].p : bankB[i]?.p || PS.INIT;
			const prevDirty = dirty;
			dirty = false;
			if (prevDirty) { const o = sel.querySelector(`option[value="${patch}"]`); if (o) o.textContent = `${num(patch)}  ${nm(patch)}`; }
			patch = id; sel.value = id;
			const was = restoring; restoring = true;
			for (const k of Object.keys(PS.INIT)) ctl['synth.' + k]?.set(src[k] ?? PS.INIT[k]);
			restoring = was;
			eng?.allOff();
			saveSoon();
		}
		sel.addEventListener('change', () => { commit(); load(sel.value); sel.blur(); });
		const nudge = d => { const ids = [...sel.options].map(o => o.value), i = ids.indexOf(patch); commit(); load(ids[(i + d + ids.length) % ids.length]); };
		box.querySelector('.synth__prev').addEventListener('click', () => nudge(-1));
		box.querySelector('.synth__next').addEventListener('click', () => nudge(1));
		box.querySelector('.synth__save').addEventListener('click', () => {
			commit();
			let slot = patch[0] === 'B' ? +patch.slice(2) : bankB.findIndex(x => !x);
			if (slot < 0) {
				const n = prompt('Bank B is full. Overwrite which B slot? (1-128)', '1');
				if (!n) return;
				slot = Math.min(127, Math.max(0, (parseInt(n, 10) || 1) - 1));
			}
			const name = prompt(`Save to B${String(slot + 1).padStart(3, '0')} as:`, patch[0] === 'B' && bankB[slot] ? bankB[slot].name : nm(patch));
			if (name === null) return;
			bankB[slot] = { name: name.trim().slice(0, 24) || 'My patch', p: { ...SP } };
			store.put('bankB', bankB);
			patch = `B:${slot}`; dirty = false;
			fill(); saveSoon();
			window.wiggler?.hit('u', 1);
		});
		box.querySelector('.synth__export').addEventListener('click', () => {
			const a = document.createElement('a');
			a.href = URL.createObjectURL(new Blob([JSON.stringify({ type: 'airwiggler-bank-b', v: 1, bank: bankB }, null, 1)], { type: 'application/json' }));
			a.download = 'airwiggler-bank-B.json';
			a.click();
			setTimeout(() => URL.revokeObjectURL(a.href), 1000);
		});
		const fileIn = box.querySelector('.synth__file');
		box.querySelector('.synth__import').addEventListener('click', () => fileIn.click());
		fileIn.addEventListener('change', async () => {
			const f = fileIn.files[0];
			fileIn.value = '';
			if (!f) return;
			try {
				const data = JSON.parse(await f.text());
				if (data.type !== 'airwiggler-bank-b' || !Array.isArray(data.bank)) throw 0;
				data.bank.slice(0, 128).forEach((x, i) => {
					bankB[i] = x && typeof x.name === 'string' && x.p && typeof x.p === 'object'
						? { name: x.name.slice(0, 24), p: Object.fromEntries(Object.keys(PS.INIT).map(k => [k, typeof x.p[k] === typeof PS.INIT[k] ? x.p[k] : PS.INIT[k]])) }
						: null;
				});
				store.put('bankB', bankB);
				fill();
				alert(`Loaded ${bankB.filter(Boolean).length} patches into bank B.`);
			} catch {
				alert("That file isn't an Air Wiggler bank.");
			}
		});

		// ── Keyboard: on-screen (multi-touch, slide between keys) + computer keys A–K, sharps W E T Y U O P ──
		const bed = box.querySelector('.keys__bed');
		const WHITE = [0, 2, 4, 5, 7, 9, 11];
		let whites = 0;
		const base = () => 48 + octave * 12; // C3
		function layout() {
			const n = Math.max(8, Math.min(15, Math.floor(bed.clientWidth / 34) || 10));
			if (n === whites) return;
			whites = n;
			bed.replaceChildren();
			for (let w = 0; w < n; w++) {
				const semi = Math.floor(w / 7) * 12 + WHITE[w % 7];
				const k = document.createElement('div');
				k.className = 'key'; k.dataset.o = semi;
				k.style.left = `${w / n * 100}%`; k.style.width = `${100 / n}%`;
				bed.append(k);
				if ([0, 1, 3, 4, 5].includes(w % 7) && w < n - 1) {
					const bk = document.createElement('div');
					bk.className = 'key key--b'; bk.dataset.o = semi + 1;
					bk.style.left = `${(w + 0.68) / n * 100}%`; bk.style.width = `${64 / n}%`;
					bed.append(bk);
				}
			}
			label();
		}
		function label() {
			for (const k of bed.children) {
				k.dataset.n = base() + +k.dataset.o;
				k.textContent = k.dataset.o % 12 === 0 ? 'C' + ((base() + +k.dataset.o) / 12 - 1) : '';
			}
		}
		const down = new Map(); // pointer or key code → note
		const caps = new Map(); // id → piano-roll capture token
		function press(id, note, vel = 0.8) {
			if (down.get(id) === note) return;
			release(id);
			const c = audio(); if (c.state === 'suspended') c.resume();
			engine().noteOn(note, vel);
			down.set(id, note);
			caps.set(id, roll?.capture('synth', note, vel));
			league?.score('s' + note);
			bed.querySelector(`[data-n="${note}"]`)?.classList.add('is-down');
			window.wiggler?.hit('k', 0.6);
		}
		function release(id) {
			const n = down.get(id);
			if (n === undefined) return;
			down.delete(id);
			roll?.end(caps.get(id)); caps.delete(id);
			if (![...down.values()].includes(n)) { eng?.noteOff(n); bed.querySelector(`[data-n="${n}"]`)?.classList.remove('is-down'); }
		}
		const noteAt = (x, y) => { const el = document.elementFromPoint(x, y); return el?.parentElement === bed ? +el.dataset.n : null; };
		bed.addEventListener('pointerdown', e => {
			e.preventDefault();
			bed.setPointerCapture(e.pointerId);
			const n = noteAt(e.clientX, e.clientY);
			if (n !== null) press(e.pointerId, n);
		});
		bed.addEventListener('pointermove', e => {
			if (!down.has(e.pointerId)) return;
			const n = noteAt(e.clientX, e.clientY);
			if (n !== null) press(e.pointerId, n); // glissando
		});
		for (const ev of ['pointerup', 'pointercancel']) bed.addEventListener(ev, e => release(e.pointerId));
		box.querySelectorAll('.keys__oct').forEach(b => b.addEventListener('click', () => { octave = Math.max(-3, Math.min(3, octave + +b.dataset.d)); label(); }));
		const KEYMAP = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };
		addEventListener('keydown', e => {
			if (!rig.open || mode !== 'synth' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target.tagName === 'SELECT') return;
			if (e.code === 'KeyZ' || e.code === 'KeyX') { e.preventDefault(); octave = Math.max(-3, Math.min(3, octave + (e.code === 'KeyX' ? 1 : -1))); label(); return; }
			if (!(e.code in KEYMAP)) return;
			e.preventDefault();
			press(e.code, base() + KEYMAP[e.code]);
		});
		addEventListener('keyup', e => release(e.code));
		new ResizeObserver(layout).observe(bed);
		fill();
		return {
			patch: () => patch,
			isDirty: () => dirty,
			name: () => nm(patch),
			engine,
			noteOn: (n, v) => press('midi' + n, n, v),
			noteOff: n => release('midi' + n),
			restore(state, bank) {
				if (bank) bank.forEach((x, i) => { bankB[i] = x || null; });
				if (state?.patch) load(state.patch);
				fill();
			},
			markClean() { dirty = false; markDirty(); },
			setDirty() { dirty = true; markDirty(); },
			panic() { for (const id of [...down.keys()]) release(id); eng?.allOff(); },
		};
	})();

	// ── Piano roll: up to 1024 bars of notes for the synth and the pads, played in live or drawn in ──
	const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
	const roll = (() => {
		const box = pad.querySelector('.roll');
		if (!box) return null;
		const BARS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
		const QS = [['No snap', 0], ['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125], ['1/8T', 1 / 3], ['1/16T', 1 / 6]];
		const COLORS = { d: '#5c74ff', k: '#ff7a3d', h: '#ff4f7b', b: '#34d6ff', u: '#22c55e' };
		let notes = [], bars = 4, qi = 3, lane = 'synth';
		let playing = false, recording = false, armedAt = 0, anchorTime = 0, anchorBeat = 0, rspb = 0.5, schedTo = 0, timer = 0, pass = 0, raf = 0;
		let recBefore = null;
		const fresh = new Set(); // notes recorded this pass: they play back from the next time round
		const q = () => QS[qi][1], len = () => bars * 4;
		const beatAt = t => anchorBeat + (t - anchorTime) / rspb, timeOf = b => anchorTime + (b - anchorBeat) * rspb;
		const lat = () => ac ? clampN((ac.baseLatency || 0) + (ac.outputLatency || 0), 0, 0.2) : 0;

		box.innerHTML = `<div class="roll__bar">
			<button type="button" class="chip roll__rec" aria-pressed="false" title="Record (overdub): a bar of count-in, then it plays and records from the downbeat">● Rec</button>
			<button type="button" class="chip roll__play" aria-pressed="false" title="Play / stop">▶</button>
			<button type="button" class="chip roll__lane" title="Show the synth notes or the pad hits">Synth</button>
			<select class="roll__sel roll__bars" aria-label="Length in bars">${BARS.map(b => `<option value="${b}">${b} bar${b > 1 ? 's' : ''}</option>`).join('')}</select>
			<select class="roll__sel roll__q" aria-label="Snap">${QS.map(([l], i) => `<option value="${i}">${l}</option>`).join('')}</select>
			<button type="button" class="chip roll__midi" aria-pressed="false" title="Play the synth (and pads on channel 10) from a MIDI keyboard or drum pad">MIDI</button>
			<button type="button" class="chip roll__clear" title="Clear every note in this lane">Clear</button>
		</div><canvas class="roll__cv" aria-label="Piano roll: tap to add a note, tap a note to delete it, drag to move, drag its end to resize, drag empty space to scroll"></canvas>`;
		const $ = s => box.querySelector(s);
		const recBtn = $('.roll__rec'), playBtn = $('.roll__play'), laneBtn = $('.roll__lane'), barsSel = $('.roll__bars'), qSel = $('.roll__q');
		barsSel.value = bars; qSel.value = qi;

		// ── Undo + memory: the whole note list is one undoable, saved value ──
		const snap = () => JSON.stringify(notes);
		const changed = before => touch('roll.notes', before);
		ctl['roll.notes'] = { get: snap, set: v => { notes = JSON.parse(v || '[]'); fresh.clear(); draw(); } };
		ctl['roll.bars'] = { get: () => bars, set: v => { bars = v; barsSel.value = v; clampScroll(); draw(); } };
		ctl['roll.q'] = { get: () => qi, set: v => { qi = v; qSel.value = v; draw(); } };
		barsSel.addEventListener('change', () => { const before = bars; bars = +barsSel.value; touch('roll.bars', before); clampScroll(); draw(); barsSel.blur(); });
		qSel.addEventListener('change', () => { const before = qi; qi = +qSel.value; touch('roll.q', before); draw(); qSel.blur(); });
		laneBtn.addEventListener('click', () => { lane = lane === 'synth' ? 'pads' : 'synth'; laneBtn.textContent = lane === 'synth' ? 'Synth' : 'Pads'; sy = lane === 'synth' ? (108 - 72) * RH : 0; clampScroll(); draw(); });
		$('.roll__clear').addEventListener('click', () => {
			const before = snap();
			notes = notes.filter(n => !inLane(n));
			changed(before); draw();
		});

		// ── Drawing (only what's on screen, so 1024 bars costs the same as 4) ──
		const cv = $('.roll__cv'), cx = cv.getContext('2d');
		const GUT = 36, RUL = 14;
		let BW = 26, RH = 11, sx = 0, sy = (108 - 72) * RH, W = 0, H = 0, dpr = 1;
		const rows = () => lane === 'synth' ? 85 : 16;              // synth lane: MIDI 24 (C1) to 108 (C8)
		const rowOf = n => lane === 'synth' ? 108 - n : n;
		const noteOfRow = r => lane === 'synth' ? 108 - r : r;
		const rh = () => lane === 'synth' ? RH : Math.max(RH, (H - RUL) / 16);
		const inLane = nt => (nt.k === 'synth') === (lane === 'synth');
		const BLACK = [1, 3, 6, 8, 10];
		const padDef = (k, n) => (KITS[k] || KITS[kit]).pads[n];
		function size() {
			const b = cv.getBoundingClientRect();
			if (!b.width) return;
			dpr = devicePixelRatio || 1; W = b.width; H = b.height;
			cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
			clampScroll(); draw();
		}
		function clampScroll() {
			sx = clampN(sx, 0, Math.max(0, len() * BW - (W - GUT)));
			sy = clampN(sy, 0, Math.max(0, rows() * rh() - (H - RUL)));
		}
		function draw() {
			if (box.hidden || !W) return;
			cx.setTransform(dpr, 0, 0, dpr, 0, 0);
			cx.fillStyle = '#0b0e22'; cx.fillRect(0, 0, W, H);
			const R = rh(), L = len();
			const b0 = sx / BW, b1 = Math.min(L, (sx + W - GUT) / BW);
			const r0 = Math.max(0, Math.floor(sy / R)), r1 = Math.min(rows(), Math.ceil((sy + H - RUL) / R));
			cx.save();
			cx.beginPath(); cx.rect(GUT, RUL, W - GUT, H - RUL); cx.clip();
			for (let r = r0; r < r1; r++) {
				const y = RUL + r * R - sy, n = noteOfRow(r);
				cx.fillStyle = lane === 'synth' ? (BLACK.includes(n % 12) ? '#0f1330' : '#171b3c') : (r % 2 ? '#141836' : '#181d40');
				cx.fillRect(GUT, y, W, R);
				if (lane === 'synth' && n % 12 === 0) { cx.fillStyle = 'rgba(255,255,255,0.1)'; cx.fillRect(GUT, y + R - 1, W, 1); }
			}
			const sub = q() || 0.25;
			for (let b = Math.floor(b0 / sub) * sub; b <= b1 + 1e-6; b += sub) {
				const beat = Math.abs(b - Math.round(b)) < 1e-6, bar = beat && Math.round(b) % 4 === 0;
				if (!beat && sub * BW < 6) continue;
				cx.fillStyle = bar ? 'rgba(255,255,255,0.3)' : beat ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
				cx.fillRect(Math.round(GUT + b * BW - sx), RUL, 1, H);
			}
			if (b1 >= L) { cx.fillStyle = 'rgba(0,0,0,0.5)'; cx.fillRect(GUT + L * BW - sx, RUL, W, H); } // past the end
			for (const nt of notes) {
				if (!inLane(nt) || nt.t + nt.d < b0 || nt.t > b1) continue;
				const r = rowOf(nt.n);
				if (r < r0 - 1 || r > r1) continue;
				const x = GUT + nt.t * BW - sx, y = RUL + r * R - sy;
				cx.globalAlpha = 0.45 + nt.v * 0.55;
				cx.fillStyle = nt.k === 'synth' ? '#ff7a3d' : COLORS[padDef(nt.k, nt.n)?.[3]] || COLORS.d;
				cx.beginPath(); cx.roundRect(x + 0.5, y + 1, Math.max(3, nt.d * BW - 1), R - 2, 3); cx.fill();
				cx.globalAlpha = 1;
			}
			if (playing) {
				const pb = ((beatAt(ac.currentTime - lat()) % L) + L) % L;
				cx.fillStyle = recording && ac.currentTime >= armedAt ? '#ff2a2a' : '#7dffb0';
				cx.fillRect(GUT + pb * BW - sx, RUL, 2, H);
			}
			cx.restore();
			cx.font = '600 9px Inter, system-ui, sans-serif';
			cx.fillStyle = '#10132b'; cx.fillRect(GUT, 0, W, RUL);
			for (let bar = Math.floor(b0 / 4); bar * 4 <= b1; bar++) {
				const x = GUT + bar * 4 * BW - sx;
				if (x < GUT - 1 || (BW * 4 < 22 && bar % 4)) continue;
				cx.fillStyle = '#9aa0c3'; cx.fillText(String(bar + 1), x + 3, 10);
			}
			cx.fillStyle = '#10132b'; cx.fillRect(0, 0, GUT, H);
			for (let r = r0; r < r1; r++) {
				const y = RUL + r * R - sy, n = noteOfRow(r);
				if (y + R < RUL) continue;
				if (lane === 'synth') {
					if (BLACK.includes(n % 12)) { cx.fillStyle = '#05060f'; cx.fillRect(GUT - 14, y, 14, R); }
					if (n % 12 === 0) { cx.fillStyle = '#9aa0c3'; cx.fillText('C' + (n / 12 - 1), 3, y + R / 2 + 3); }
				} else { cx.fillStyle = '#9aa0c3'; cx.fillText(padDef(kit, n)[0].slice(0, 7), 3, y + R / 2 + 3); }
			}
		}

		// ── Editing: tap = add/delete, drag a note = move (its right edge = resize), drag empty space = scroll ──
		let drag = null;
		function at(e) {
			const b = cv.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
			if (x < GUT || y < RUL) return { x, y };
			const beat = (x - GUT + sx) / BW, r = Math.floor((y - RUL + sy) / rh());
			let nt = null;
			for (let i = notes.length - 1; i >= 0; i--) { const n = notes[i]; if (inLane(n) && rowOf(n.n) === r && beat >= n.t && beat <= n.t + n.d) { nt = n; break; } }
			return { x, y, beat, r, nt, edge: nt && (nt.t + nt.d - beat) * BW < 8 && nt.d * BW > 12 };
		}
		const snapTo = v => q() ? Math.round(v / q()) * q() : v;
		function preview(nt) {
			audio();
			if (nt.k === 'synth') { const e = synthUi?.engine(); if (!e) return; const v = e.noteOn(nt.n, nt.v, ac.currentTime); e.releaseAt(v, ac.currentTime + Math.min(0.4, nt.d * rspb)); }
			else playPad(nt.k, nt.n, ac.currentTime, nt.v);
		}
		cv.addEventListener('pointerdown', e => {
			e.preventDefault();
			cv.setPointerCapture(e.pointerId);
			const h = at(e);
			drag = { ...h, cx0: e.clientX, cy0: e.clientY, sx0: sx, sy0: sy, moved: false, before: snap(), t0: h.nt?.t, n0: h.nt?.n, d0: h.nt?.d };
		});
		cv.addEventListener('pointermove', e => {
			if (!drag) return;
			const dx = e.clientX - drag.cx0, dy = e.clientY - drag.cy0;
			if (!drag.moved && Math.hypot(dx, dy) < 6) return;
			drag.moved = true;
			const nt = drag.nt;
			if (nt && drag.edge) nt.d = Math.max(q() || 1 / 16, snapTo(drag.d0 + dx / BW));
			else if (nt) {
				nt.t = clampN(snapTo(drag.t0 + dx / BW), 0, len() - Math.min(nt.d, len()));
				const n = noteOfRow(clampN(rowOf(drag.n0) + Math.round(dy / rh()), 0, rows() - 1));
				if (n !== nt.n) { nt.n = n; preview(nt); }
			} else { sx = drag.sx0 - dx; sy = drag.sy0 - dy; clampScroll(); }
			draw();
		});
		const up = () => {
			const d = drag;
			drag = null;
			if (!d) return;
			if (!d.moved && d.beat !== undefined && d.beat < len() && d.r < rows()) {
				if (d.nt) notes.splice(notes.indexOf(d.nt), 1);
				else {
					const nt = { t: +(q() ? Math.floor(d.beat / q()) * q() : d.beat).toFixed(4), d: q() || 0.25, n: noteOfRow(d.r), v: 0.8, k: lane === 'synth' ? 'synth' : kit };
					notes.push(nt); preview(nt);
				}
			}
			if (d.nt || !d.moved) { changed(d.before); draw(); }
		};
		cv.addEventListener('pointerup', up);
		cv.addEventListener('pointercancel', up);
		cv.addEventListener('wheel', e => {
			e.preventDefault();
			if (e.ctrlKey) { // zoom around the pointer
				const b = cv.getBoundingClientRect(), x = e.clientX - b.left - GUT, beat = (x + sx) / BW;
				BW = clampN(BW * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 3, 140);
				sx = beat * BW - x;
			} else { sx += e.deltaX + (e.shiftKey ? e.deltaY : 0); if (!e.shiftKey) sy += e.deltaY; }
			clampScroll(); draw();
		}, { passive: false });
		new ResizeObserver(size).observe(cv);

		// ── Transport: plays in a loop, locked to the metronome's bar lines ──
		async function play(countIn) {
			audio(); if (ac.state === 'suspended') await ac.resume();
			await metro.start();
			rspb = 60 / tempo;
			const t0 = metro.nextBeat(ac.currentTime + (countIn ? rspb * 3 : 0.05), true);
			anchorTime = t0; anchorBeat = 0; schedTo = 0; pass = 0; fresh.clear();
			playing = true;
			clearInterval(timer); timer = setInterval(tick, 25); tick();
			ui(); loop();
			return t0;
		}
		function stop() {
			if (recording) stopRec();
			playing = false;
			clearInterval(timer);
			ui(); draw();
		}
		function tick() {
			const to = beatAt(ac.currentTime + 0.12), L = len();
			while (schedTo < to) {
				const p = Math.floor(schedTo / L), base = p * L, end = Math.min(to, base + L);
				if (p !== pass) { pass = p; fresh.clear(); }
				for (const nt of notes) if (nt.t >= schedTo - base && nt.t < end - base && !fresh.has(nt)) schedule(nt, base + nt.t);
				schedTo = end;
			}
		}
		function schedule(nt, b) {
			const t = timeOf(b);
			if (t < ac.currentTime - 0.005) return;
			if (nt.k === 'synth') { const e = synthUi?.engine(); if (!e) return; const v = e.noteOn(nt.n, nt.v, t); e.releaseAt(v, timeOf(b + nt.d)); }
			else playPad(nt.k, nt.n, t, nt.v);
		}
		hooks.push(() => { if (playing) { const now = ac.currentTime; anchorBeat = beatAt(now); anchorTime = now; schedTo = Math.min(schedTo, beatAt(now)); } rspb = 60 / tempo; });
		function loop() {
			if (!playing) { raf = 0; return; }
			raf = requestAnimationFrame(loop);
			if (box.hidden) return;
			const L = len(), pb = ((beatAt(ac.currentTime - lat()) % L) + L) % L, x = pb * BW;
			if (!drag && (x < sx || x > sx + W - GUT - 20)) { sx = x - 10; clampScroll(); } // follow the playhead
			draw();
		}
		async function rec() {
			if (recording) { stopRec(); return; }
			recBefore = snap();
			recording = true;
			armedAt = playing ? ac.currentTime : await play(true);
			ui();
		}
		function stopRec() {
			recording = false;
			for (const tok of held.values()) end(tok);
			held.clear();
			changed(recBefore);
			ui();
		}
		function ui() {
			recBtn.setAttribute('aria-pressed', recording);
			playBtn.setAttribute('aria-pressed', playing);
			playBtn.textContent = playing ? '■' : '▶';
		}
		recBtn.addEventListener('click', rec);
		playBtn.addEventListener('click', () => playing ? stop() : play(false));

		// ── Live capture: the synth keys, pads and MIDI call these ──
		const held = new Map();
		let tokN = 0;
		function capture(k, n, v) {
			if (!recording || !playing) return null;
			const t = ac.currentTime - lat(); // you play to what you hear, which is late by the output latency
			if (t < armedAt - rspb * 0.5) return null; // still counting in
			const L = len();
			let b = ((beatAt(t) % L) + L) % L;
			if (q()) b = (Math.round(b / q()) * q()) % L;
			const nt = { t: +b.toFixed(4), d: q() || 0.25, n, v: +v.toFixed(2), k };
			notes.push(nt); fresh.add(nt);
			const tok = { nt, start: t, id: ++tokN };
			if (k === 'synth') held.set(tok.id, tok);
			return tok;
		}
		function end(tok) {
			if (!tok || !held.has(tok.id)) return;
			held.delete(tok.id);
			const beats = (ac.currentTime - lat() - tok.start) / rspb;
			tok.nt.d = +Math.max(q() || 1 / 16, q() ? Math.round(beats / q()) * q() : beats).toFixed(4);
		}

		// ── MIDI in: a keyboard plays the synth; channel 10 (drums) plays the pads ──
		const midiBtn = $('.roll__midi');
		midiBtn.addEventListener('click', async () => {
			if (!navigator.requestMIDIAccess) { alert('This browser has no Web MIDI. Chrome and Edge do.'); return; }
			try {
				const m = await navigator.requestMIDIAccess();
				const hook = () => {
					for (const inp of m.inputs.values()) inp.onmidimessage = onMidi;
					midiBtn.textContent = `MIDI · ${m.inputs.size}`;
					midiBtn.title = [...m.inputs.values()].map(i => i.name).join(', ') || 'No MIDI devices plugged in yet';
				};
				hook(); m.onstatechange = hook;
				midiBtn.setAttribute('aria-pressed', 'true');
			} catch { alert('MIDI access was blocked. Check the browser permission for this site.'); }
		});
		function onMidi({ data: [st, d1, d2] }) {
			if (!rig.open) return;
			const cmd = st & 0xf0, drums = (st & 0x0f) === 9;
			if (cmd === 0x90 && d2 > 0) drums ? hit(((d1 - 36) % 16 + 16) % 16) : synthUi?.noteOn(d1, d2 / 127);
			else if ((cmd === 0x80 || cmd === 0x90) && !drums) synthUi?.noteOff(d1);
		}

		return {
			capture, end,
			show() { size(); loop(); },
			stop,
		};
	})();

	// ── Wiggle League: every rig state you play (each undo step) is a contestant, and your playing scores it ──
	const league = (() => {
		const box = pad.querySelector('.league');
		if (!box) return null;
		let table = {}, streak = 0, recent = [], seen = [], saveT = 0;
		const hud = () => pad.querySelector('[data-o="league"]');
		const k = () => '#' + hist.pos;
		const who = () => `Rig #${hist.pos} · ${mode === 'synth' ? synthUi?.name() || 'Synth' : KITS[kit].name}`;
		const fmt = n => Math.round(n).toLocaleString();
		const row = () => { const r = table[k()] ||= { label: who(), score: 0, notes: 0, streak: 0, ppm: 0 }; r.label = who(); return r; };
		function add(pts, id) {
			const r = row(), now = performance.now();
			r.score += pts; if (id !== undefined) r.notes++;
			recent.push([now, pts]);
			while (recent.length && now - recent[0][0] > 60000) recent.shift();
			const span = Math.max(15000, now - recent[0][0]); // extrapolate to a minute once you've played 15 s
			const ppm = recent.reduce((s, x) => s + x[1], 0) * 60000 / span;
			r.ppm = Math.max(r.ppm, Math.round(ppm));
			const mult = 1 + Math.min(7, Math.floor(streak / 8));
			const h = hud();
			if (h) h.textContent = `🏆 ${fmt(r.score)}${mult > 1 ? ' ×' + mult : ''}`;
			if (!box.hidden) render();
			clearTimeout(saveT); saveT = setTimeout(() => store.put('league', table), 1500);
		}
		// One note: 10 points, up to +30 for landing on the 16th grid (judged against what you heard),
		// +5 for something you haven't played in your last 16 notes, and ×1-×8 for streaks of tight hits.
		function score(id) {
			if (!ac) return;
			let pts = 10;
			if (metro.running) {
				const spb = 60 / metro.bpm, s16 = spb / 4, t = ac.currentTime - (ac.baseLatency || 0) - (ac.outputLatency || 0);
				const off = ((t - (metro.nextBeat(t) - spb)) % s16 + s16) % s16, dev = Math.min(off, s16 - off);
				const acc = 1 - Math.min(1, dev / (s16 / 2));
				pts += Math.round(30 * acc * acc);
				streak = dev < 0.025 ? streak + 1 : 0;
			} else streak = 0;
			pts *= 1 + Math.min(7, Math.floor(streak / 8));
			if (!seen.includes(id)) pts += 5;
			seen.push(id); if (seen.length > 16) seen.shift();
			const r = row(); r.streak = Math.max(r.streak, streak);
			if (streak && streak % 8 === 0) window.wiggler?.hit('u', 1.4);
			add(pts, id);
		}
		function render() {
			const rows = Object.entries(table).sort((a, b) => b[1].score - a[1].score), me = k();
			const rank = rows.findIndex(([key]) => key === me) + 1;
			box.innerHTML = `<div class="league__head"><b>Wiggle League</b><span>You're ${rank ? '#' + rank : 'unranked'} as <i>${who()}</i> · streak ${streak}</span>
				<button type="button" class="chip league__reset" title="Wipe the league table">Reset</button></div>
				<p class="league__how">Every undo step is a contestant. Notes score 10, up to +30 for hitting the 16th grid with the click on, +5 for variety, ×2–×8 for streaks of tight hits, +100 per recorded loop.</p>
				<ol class="league__list">${rows.slice(0, 40).map(([key, r], i) => `<li class="${key === me ? 'is-me' : ''}"><span class="league__rank">${i + 1}</span><span class="league__name">${r.label}</span><span class="league__pts">${fmt(r.score)}</span><span class="league__meta">${fmt(r.ppm)}/min · ${r.notes} notes · best ×${1 + Math.min(7, Math.floor(r.streak / 8))}</span></li>`).join('') || '<li class="league__empty">Play something to get on the board.</li>'}</ol>`;
			box.querySelector('.league__reset').addEventListener('click', () => { if (confirm('Wipe the whole league table?')) { table = {}; store.put('league', table); render(); const h = hud(); if (h) h.textContent = '🏆 0'; } });
		}
		store.get('league').then(t => { if (t) { table = t; const r = table[k()]; const h = hud(); if (r && h) h.textContent = `🏆 ${fmt(r.score)}`; } });
		return { score, bonus: pts => add(pts), render };
	})();

	// ── Views: the robot + FX rack, the piano roll, or the league table share the top half of the rig ──
	const stage = pad.querySelector('.stage');
	let view = 'stage';
	function setView(v) {
		if (view === 'stage') stage.dataset.h = stage.offsetHeight;
		view = view === v ? 'stage' : v;
		const h = Math.max(160, (+stage.dataset.h || 300) - 8) + 'px'; // same footprint as the robot + rack, so nothing below moves
		stage.hidden = view !== 'stage';
		for (const [name, el] of [['roll', pad.querySelector('.roll')], ['league', pad.querySelector('.league')]]) {
			if (!el) continue;
			el.hidden = view !== name; el.style.height = h;
			pad.querySelector(`[data-o="${name}"]`)?.setAttribute('aria-pressed', view === name);
		}
		if (view === 'stage') window.wiggler?.start(); else window.wiggler?.stop();
		if (view === 'roll') roll?.show();
		if (view === 'league') league?.render();
	}
	pad.querySelector('[data-o="roll"]')?.addEventListener('click', () => setView('roll'));
	pad.querySelector('[data-o="league"]')?.addEventListener('click', () => setView('league'));

	// Bring back the last visit: knobs, tempo, patch, bank B, the undo history and recorded loops
	(async () => {
		const [state, h, bank, lp] = await Promise.all(['state', 'history', 'bankB', 'loops'].map(k => store.get(k)));
		restoring = true;
		synthUi?.restore(state, bank);
		for (const [p, v] of Object.entries(state?.values || {})) ctl[p]?.set(v);
		restoring = false;
		if (state?.dirty) synthUi?.setDirty();
		if (h?.list) { hist.list = h.list; hist.pos = Math.min(h.pos, h.list.length); }
		undoUi();
		if (lp) loops?.load(lp);
	})();

	// ── The popup: opening it warms up audio + renders the kits, so the very first hit is instant ──
	const bot = pad.querySelector('.bot');
	if (bot && window.wiggler) wiggler.mount(bot);
	document.querySelectorAll('.rig-open').forEach(b => b.addEventListener('click', () => {
		rig.showModal();
		const c = audio();
		if (c.state === 'suspended') c.resume();
		renderAll();
		if (view === 'stage') window.wiggler?.start();
		loops?.wake();
		setTimeout(showLatency, 400); // outputLatency is only known once audio is actually flowing
	}));
	rig.querySelector('.rig__close').addEventListener('click', () => rig.close());
	rig.addEventListener('click', e => { if (e.target === rig) rig.close(); }); // tap the backdrop to close
	rig.addEventListener('close', () => { beatStop(); window.wiggler?.stop(); roll?.stop(); metro.stop(); loops?.sleep(); synthUi?.panic(); commit(); saveAll(); });

	// Keyboard: 1-4 / Q-R / A-F / Z-V, but only while the popup is open.
	addEventListener('keydown', e => {
		if (!rig.open || mode !== 'pads' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
		const i = KEYS.indexOf(e.code);
		if (i < 0) return;
		e.preventDefault();
		hit(i);
	});
})();
