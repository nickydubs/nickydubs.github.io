// Nicky Dubs beat pad: 24 pads, twelve kits plus one you record yourself, synthesized right here in the browser (no samples to
// download, nothing copyrighted), with a DJ filter, echo, duck, glue and crush on the whole kit. Sounds are pre-rendered into
// buffers, so a hit is just "start this buffer now". The context, the master and the voice cap come from audio-core.js
// (shared with DJFX and the Robo-Selecta). Lives in a popup so the page can't scroll under your fingers, with the
// Air Wiggler (bot.js) reacting above the pads.
(() => {
	const pad = document.querySelector('.pad'), rig = document.querySelector('.rig');
	if (!pad || !rig) return;
	const grid = pad.querySelector('.pad__grid');
	const fileIn = pad.querySelector('.pad__file');
	// Every kit shares one layout: 12 drums (two rows), 6 chords, then 6 bass notes (bass pad j = the root of chord pad j)
	const KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY',
		'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN'];
	let mode = 'pads'; // 'pads' or 'synth': what the bottom half of the rig is showing
	const KEY_LABELS = KEYS.map(k => k.slice(-1));
	const PADS = KEYS.length, CHORD = 12, BASS = 18;
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
			chain(o, shaper(c, 1.8), envGain(c, 0, 0.003, 0.8, 1.5), out); o.start(0);
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
			chain(lp, shaper(c, 1.4), envGain(c, 0, 0.01, 0.7, 1.1), out);
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
			chain(lp, shaper(c, 1.6), envGain(c, 0, 0.005, 0.55, 0.85), out);
			for (const [t, d] of [['sawtooth', -7], ['square', 7]]) { const o = c.createOscillator(); o.type = t; o.frequency.value = hz(n); o.detune.value = d; o.connect(lp); o.start(0); }
		},
		slap: n => (c, out) => { // funk slap bass: a bright pluck that closes fast
			const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
			lp.frequency.setValueAtTime(3000, 0); lp.frequency.exponentialRampToValueAtTime(350, 0.18);
			chain(lp, envGain(c, 0, 0.002, 0.8, 0.45), out);
			for (const t of ['sawtooth', 'triangle']) { const o = c.createOscillator(); o.type = t; o.frequency.value = hz(n); o.connect(lp); o.start(0); }
		},
		bell: notes => (c, out) => { // FM bell an octave up, the trap/halftime sparkle
			const bus = c.createGain(); bus.gain.value = 0.75 / notes.length ** 0.6; chain(bus, out);
			for (const n of notes) {
				const f = hz(n + 12), car = c.createOscillator(), mod = c.createOscillator(), idx = c.createGain();
				car.frequency.value = f; mod.frequency.value = f * 3.5;
				idx.gain.setValueAtTime(f * 1.6, 0); idx.gain.exponentialRampToValueAtTime(f * 0.05, 0.7);
				chain(mod, idx, car.frequency); chain(car, envGain(c, 0, 0.002, 0.5, 1.4), bus);
				car.start(0); mod.start(0);
			}
		},
		skank: notes => (c, out) => { // reggae skank: the chord without its root, short, bright and boxy
			const bus = c.createGain(); bus.gain.value = 0.55 / notes.length ** 0.5;
			chain(bus, filt(c, 'highpass', 350), filt(c, 'lowpass', 3800), envGain(c, 0, 0.002, 1, 0.16), out);
			for (const n of notes.slice(1)) for (const t of ['sawtooth', 'triangle']) { const o = c.createOscillator(); o.type = t; o.frequency.value = hz(n); o.connect(bus); o.start(0); }
		},
		siren: (c, out) => { // dub siren: a square wailing up and down
			const o = c.createOscillator(), lfo = c.createOscillator(), depth = c.createGain(); o.type = 'square';
			o.frequency.setValueAtTime(520, 0); o.frequency.linearRampToValueAtTime(880, 1.1);
			lfo.frequency.value = 6; depth.gain.value = 140; chain(lfo, depth, o.frequency);
			chain(o, filt(c, 'lowpass', 2600), envGain(c, 0, 0.02, 0.28, 1.2), out); o.start(0); lfo.start(0);
		},
		vox: n => (c, out) => { // a sung "ah": a saw through two vowel formants
			const o = c.createOscillator(), bus = c.createGain(); o.type = 'sawtooth'; o.frequency.value = hz(n);
			o.frequency.setValueAtTime(hz(n) * 0.97, 0); o.frequency.linearRampToValueAtTime(hz(n), 0.05);
			chain(bus, envGain(c, 0, 0.02, 0.9, 0.38), out);
			for (const [f, q, a] of [[800, 9, 1], [1150, 10, 0.7], [2800, 12, 0.25]]) { const g = c.createGain(); g.gain.value = a; chain(o, filt(c, 'bandpass', f, q), g, bus); }
			o.start(0);
		},
		pluck: n => (c, out) => { // tech house rolling bass: a saw + square that snaps shut
			const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 5;
			lp.frequency.setValueAtTime(2200, 0); lp.frequency.exponentialRampToValueAtTime(180, 0.16);
			chain(lp, envGain(c, 0, 0.002, 0.7, 0.3), out);
			for (const t of ['sawtooth', 'square']) { const o = c.createOscillator(); o.type = t; o.frequency.value = hz(n); o.connect(lp); o.start(0); }
		},
		warp: n => (c, out) => { // garage bass: a square that drops into the note, warm and round
			const o = c.createOscillator(); o.type = 'square';
			o.frequency.setValueAtTime(hz(n + 2), 0); o.frequency.exponentialRampToValueAtTime(hz(n), 0.07);
			chain(o, filt(c, 'lowpass', 750, 2), envGain(c, 0, 0.004, 0.55, 0.6), out); o.start(0);
		},
		dub: n => (c, out) => { // dub bass: round and deep, a whisper of triangle on top
			const o = c.createOscillator(), h = c.createOscillator(), hg = c.createGain(); h.type = 'triangle'; hg.gain.value = 0.3;
			o.frequency.value = hz(n); h.frequency.value = hz(n);
			const env = envGain(c, 0, 0.012, 0.95, 0.9); chain(o, env, out); chain(h, hg, filt(c, 'lowpass', 500), env); o.start(0); h.start(0);
		},
		growl: n => (c, out) => { // neuro bass: FM saws through a band-pass that sweeps open and shut
			const car = c.createOscillator(), mod = c.createOscillator(), idx = c.createGain(), bp = filt(c, 'bandpass', 300, 4);
			car.type = 'sawtooth'; car.frequency.value = hz(n); mod.frequency.value = hz(n) * 1.5; idx.gain.value = hz(n) * 2.5;
			bp.frequency.setValueAtTime(250, 0); bp.frequency.exponentialRampToValueAtTime(2200, 0.12); bp.frequency.exponentialRampToValueAtTime(350, 0.42);
			chain(mod, idx, car.frequency); chain(car, bp, shaper(c, 2.2), filt(c, 'lowpass', 3200), envGain(c, 0, 0.004, 0.6, 0.5), out);
			car.start(0); mod.start(0);
		},
	};
	// The sub bass layer under every bass pad: a clean sine at the root (an octave down when the note sits high)
	const withSub = (build, n, len) => (c, out) => {
		build(c, out);
		const o = c.createOscillator(), g = c.createGain(), end = Math.max(0.1, len - 0.02);
		o.frequency.value = hz(n >= 40 ? n - 12 : n);
		g.gain.setValueAtTime(0.0001, 0); g.gain.linearRampToValueAtTime(0.5, 0.006);
		g.gain.setValueAtTime(0.5, end * 0.45); g.gain.exponentialRampToValueAtTime(0.0001, end);
		chain(o, g, out); o.start(0);
	};

	// ── The kits ──
	// Each pad: [name, sound, render length (s), colour, mute group (MPC-style choke)]. A kit is its 12 drums plus a key:
	// six diatonic 7th/9th chords are built in that key (mid register, upper voices kept close so they glide into each
	// other), and the six bass pads are those chords' roots, each with the sub layer underneath.
	const NN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
	const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10] };
	const wrap = (n, lo) => lo + ((n - lo) % 12 + 12) % 12; // the pitch class n, placed in [lo, lo + 12)
	function harmony(tonic, scale, degs, nine) {
		const sc = SCALES[scale], pc = k => tonic + sc[k % 7] + 12 * Math.floor(k / 7);
		return degs.map(d => {
			const iv = [0, 2, 4, 6, 8].map(s => pc(d + s) - pc(d)), r = pc(d) % 12;
			const q = iv[1] === 3 ? (iv[2] === 6 ? 'm7b5' : 'm7') : iv[3] === 11 ? 'maj7' : '7';
			const add9 = nine && iv[4] === 14 && q !== 'm7b5'; // never a flat 9
			const root = wrap(r, 45); // A2..G#3
			const upper = iv.slice(1, add9 ? 5 : 4).map(i => wrap(root + i, 55)).sort((a, b) => a - b);
			return { name: NN[r] + (add9 ? { m7: 'm9', maj7: 'maj9', 7: '9' }[q] : q), notes: [root, ...upper], bass: wrap(r, 28) };
		});
	}
	const D = (name, build, len, col = 'd', group) => [name, build, len, col, group];
	function kitOf(name, dusty, drums, [tonic, scale, degs, nine], chord, chordLen, bass, bassLen, bassName, pure = false) {
		const harm = harmony(tonic, scale, degs, nine);
		return { name, dusty, harm, pads: [...drums,
			...harm.map(h => [h.name, chord(h.notes), chordLen, 'k']),
			...harm.map(h => [`${bassName} ${NN[h.bass % 12]}`, pure ? bass(h.bass) : withSub(bass(h.bass), h.bass, bassLen), bassLen, 'b', 'bass'])] };
	}
	const hats = (dec = 0.05, open = 0.4, peak = 0.5) => [D('Hat', S.hat(dec, peak), 0.12, 'd', 'hat'), D('Open hat', S.hat(open, peak), open + 0.1, 'd', 'hat')];
	const KITS = {
		soul: kitOf('Soul MPC', true, [D('Kick', S.kick(160, 48, 0.42), 0.6), D('Snare', S.snare(190, 0.2), 0.35), D('Clap', S.clap, 0.4), ...hats(),
			D('Ride', S.ride, 1.2), D('Ghost', S.snare(240, 0.07, 2600), 0.15), D('Rim', S.rim, 0.1), D('Shaker', S.shaker, 0.2),
			D('Tom', S.tom(110), 0.6), D('Crash', S.crash, 1.8, 'h'), D('Horns', S.horns([65, 69, 72]), 0.5, 'h')],
			[0, 'major', [1, 4, 0, 5, 3, 2], true], S.keys, 2, S.upright, 0.85, 'Bass'),
		808: kitOf('808 Trap', false, [D('Kick', S.kick(120, 42, 0.55), 0.7), D('Snare', S.snare(220, 0.16, 2400), 0.3), D('Clap', S.clap, 0.4), ...hats(0.04, 0.32, 0.4),
			D('Hat roll', S.roll, 0.35, 'd', 'hat'), D('Ghost', S.snare(260, 0.05, 3000), 0.12), D('Rim', S.rim, 0.1), D('Shaker', S.shaker, 0.2),
			D('Cowbell', S.cowbell, 0.4), D('Crash', S.crash, 1.8, 'h'), D('Laser', S.laser, 0.4, 'h')],
			[0, 'minor', [0, 5, 3, 6, 4, 2], true], S.bell, 1.6, S.bass808, 1.6, '808', true),
		jungle: kitOf('Jungle', true, [D('Kick', S.kick(150, 50, 0.32), 0.5), D('Snare', S.snare(210, 0.22, 1500), 0.4), D('Clap', S.clap, 0.4), ...hats(0.045),
			D('Ride', S.ride, 1.2), D('Ghost', S.snare(240, 0.07, 2600), 0.15), D('Rim', S.rim, 0.1), D('Shaker', S.shaker, 0.2),
			D('Tom', S.tom(95), 0.6), D('Crash', S.crash, 1.8, 'h'), D('Siren', S.siren, 1.3, 'h')],
			[9, 'minor', [0, 5, 3, 6, 4, 2], true], S.pad, 2.7, S.reese, 1.2, 'Reese'),
		liquid: kitOf('Liquid DnB', false, [D('Kick', S.kick(140, 46, 0.3), 0.45), D('Snare', S.snare(200, 0.18, 2000), 0.35), D('Clap', S.clap, 0.4), ...hats(0.04, 0.3, 0.4),
			D('Ride', S.ride, 1.2), D('Ghost', S.snare(230, 0.06, 2600), 0.15), D('Rim', S.rim, 0.1), D('Shaker', S.shaker, 0.2),
			D('Conga', S.conga(300), 0.3), D('Crash', S.crash, 1.8, 'h'), D('Vox', S.vox(69), 0.45, 'h')],
			[5, 'major', [0, 5, 3, 4, 2, 1], true], S.keys, 2, S.sub, 0.9, 'Sub', true),
		dubstep: kitOf('Dubstep', false, [D('Kick', S.kick(130, 40, 0.5), 0.7), D('Snare', S.big, 0.5), D('Clap', S.clap, 0.4), ...hats(0.05, 0.35),
			D('Ride', S.ride, 1.2), D('Ghost', S.snare(240, 0.06, 2600), 0.15), D('Rim', S.rim, 0.1), D('Shaker', S.shaker, 0.2),
			D('Tom', S.tom(80), 0.6), D('Crash', S.crash, 1.8, 'h'), D('Laser', S.laser, 0.4, 'h')],
			[5, 'minor', [0, 5, 2, 6, 3, 4], false], S.stab, 0.35, n => S.wobble(n + 12), 0.9, 'Wob'),
		house: kitOf('House', false, [D('Kick', S.kick(140, 50, 0.5), 0.6), D('Snare', S.snare(230, 0.14, 2600), 0.3), D('Clap', S.clap, 0.4), ...hats(0.04, 0.28),
			D('Ride', S.ride, 1.2), D('Ghost', S.snare(250, 0.05, 3000), 0.12), D('Rim', S.rim, 0.1), D('Shaker', S.shaker, 0.2),
			D('Conga', S.conga(330), 0.3), D('Crash', S.crash, 1.8, 'h'), D('Cowbell', S.cowbell, 0.4, 'h')],
			[9, 'minor', [0, 3, 4, 5, 6, 2], false], S.organ, 0.7, n => S.slap(n + 12), 0.5, 'Bass'),
		disco: kitOf('Roller Disco', true, [D('Kick', S.kick(130, 48, 0.4), 0.55), D('Snare', S.snare(220, 0.15, 2600), 0.3), D('Clap', S.clap, 0.4), ...hats(0.04, 0.35),
			D('Ride', S.ride, 1.2), D('Ghost', S.snare(250, 0.05, 3000), 0.12), D('Rim', S.rim, 0.1), D('Tamb', S.tamb, 0.25),
			D('Conga', S.conga(260), 0.3), D('Crash', S.crash, 1.8, 'h'), D('Cowbell', S.cowbell, 0.4, 'h')],
			[4, 'minor', [0, 3, 6, 5, 2, 4], true], S.strings, 2.7, n => S.slap(n + 12), 0.5, 'Slap'),
		ukg: kitOf('UK Garage', false, [D('Kick', S.kick(135, 46, 0.4), 0.55), D('Snare', S.snare(240, 0.12, 2800), 0.25), D('Clap', S.clap, 0.4), ...hats(0.035, 0.25, 0.42),
			D('Ride', S.ride, 1.2), D('Ghost', S.snare(260, 0.05, 3200), 0.12), D('Rim', S.rim, 0.1), D('Shaker', S.shaker, 0.2),
			D('Conga', S.conga(360), 0.3), D('Crash', S.crash, 1.8, 'h'), D('Vox', S.vox(67), 0.45, 'h')],
			[7, 'minor', [0, 5, 3, 6, 2, 4], true], S.organ, 0.7, S.warp, 0.7, 'Bass'),
		tech: kitOf('Tech House', false, [D('Kick', S.kick(150, 45, 0.55), 0.65), D('Snare', S.snare(210, 0.12, 2400), 0.25), D('Clap', S.clap, 0.4), ...hats(0.03, 0.22, 0.45),
			D('Ride', S.ride, 1.2), D('Ghost', S.snare(260, 0.05, 3000), 0.12), D('Rim', S.rim, 0.1), D('Shaker', S.shaker, 0.2),
			D('Perc', S.conga(520), 0.25), D('Crash', S.crash, 1.8, 'h'), D('Zap', S.laser, 0.4, 'h')],
			[2, 'minor', [0, 5, 3, 6, 4, 2], false], S.stab, 0.35, S.pluck, 0.4, 'Bass'),
		dub: kitOf('Dub Reggae', true, [D('Kick', S.kick(110, 44, 0.5), 0.6), D('Snare', S.snare(260, 0.1, 1800), 0.25), D('Clap', S.clap, 0.4), ...hats(0.05, 0.3),
			D('Ride', S.ride, 1.2), D('Ghost', S.snare(280, 0.05, 2600), 0.12), D('Rim', S.rim, 0.1), D('Shaker', S.shaker, 0.2),
			D('Tom', S.tom(120), 0.6), D('Crash', S.crash, 1.8, 'h'), D('Siren', S.siren, 1.3, 'h')],
			[11, 'minor', [0, 3, 4, 5, 6, 2], false], S.skank, 0.25, S.dub, 1, 'Dub', true),
		half: kitOf('Halftime', true, [D('Kick', S.kick(125, 42, 0.6), 0.75), D('Snare', S.snare(180, 0.26, 1600), 0.45), D('Clap', S.clap, 0.4), ...hats(0.045, 0.3),
			D('Ride', S.ride, 1.2), D('Ghost', S.snare(240, 0.06, 2600), 0.15), D('Rim', S.rim, 0.1), D('Tamb', S.tamb, 0.25),
			D('Conga', S.conga(240), 0.3), D('Crash', S.crash, 1.8, 'h'), D('Vox', S.vox(65), 0.45, 'h')],
			[10, 'minor', [0, 5, 3, 6, 2, 4], true], S.keys, 2, S.bass808, 1.6, '808', true),
		neuro: kitOf('Neuro DnB', false, [D('Kick', S.kick(170, 50, 0.28), 0.4), D('Snare', S.big, 0.5), D('Clap', S.clap, 0.4), ...hats(0.035, 0.25, 0.45),
			D('Ride', S.ride, 1.2), D('Ghost', S.snare(260, 0.05, 3000), 0.12), D('Rim', S.rim, 0.1), D('Shaker', S.shaker, 0.2),
			D('Tom', S.tom(140), 0.5), D('Crash', S.crash, 1.8, 'h'), D('Laser', S.laser, 0.4, 'h')],
			[6, 'phrygian', [0, 1, 5, 3, 6, 4], false], S.stab, 0.35, n => S.growl(n + 12), 0.55, 'Growl'),
	};

	async function renderPad(def, dusty) {
		const [, build, len] = def;
		const c = new OfflineAudioContext(1, Math.ceil(SR * len), SR);
		let out = c.destination;
		if (dusty) { // a little tape warmth + rolled-off top for the MPC feel (kept gentle: warmth, not grit)
			const g = c.createGain(); g.gain.value = 0.9;
			chain(g, shaper(c, 1.15), filt(c, 'lowpass', 9500), out);
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
	const KIT_ORDER = ['soul', '808', 'jungle', 'liquid', 'neuro', 'dubstep', 'half', 'ukg', 'house', 'tech', 'disco', 'dub']; // '808' would sort first on its own
	const buffers = {}, custom = Object.fromEntries(Object.keys(KITS).map(k => [k, []])), renders = {};
	let rendering = null;
	function renderKit(id) { // one kit's pads, rendered once (and measured once, for the level trims)
		return renders[id] ||= Promise.all(KITS[id].pads.map(p => renderPad(p, KITS[id].dusty))).then(b => { b.forEach(levelTrim); buffers[id] = b; });
	}
	// Even out the pads: each sound's loudest 150 ms is measured once (deep lows count for less, as they do to the ear),
	// and the pad is nudged halfway toward one common level, 6 dB at most either way. A hit just reads the number.
	const trims = new WeakMap(), TARGET_DB = -17; // the median over all twelve kits, so the kits stay as loud as they were overall
	function levelTrim(buf) {
		let t = trims.get(buf);
		if (t !== undefined) return t;
		const d = buf.getChannelData(0), w = Math.max(1, Math.round(buf.sampleRate * 0.15)), a = Math.exp(-2 * Math.PI * 120 / buf.sampleRate);
		const sq = new Float32Array(d.length);
		let hp = 0, prev = 0, sum = 0, best = 0, pk = 0;
		for (let i = 0; i < d.length; i++) {
			if (d[i] > pk) pk = d[i]; else if (-d[i] > pk) pk = -d[i];
			hp = a * (hp + d[i] - prev); prev = d[i]; // one-pole high-pass at 120 Hz
			sq[i] = hp * hp; sum += sq[i];
			if (i >= w) sum -= sq[i - w];
			if (sum > best) best = sum;
		}
		const db = 10 * Math.log10(best / Math.min(w, d.length) + 1e-12);
		t = Math.min(10 ** (Math.max(-6, Math.min(6, (TARGET_DB - db) / 2)) / 20), 1 / Math.max(pk, 0.05)); // never pushed past full scale: a quiet voice chop would hit the limiter and sound crushed
		trims.set(buf, t);
		return t;
	}
	function renderAll() { // the kit on screen first, then the rest one at a time with a breather, so playing never stutters
		return rendering ||= (async () => {
			await renderKit(kit);
			for (const id of KIT_ORDER) { if (!renders[id]) { await renderKit(id); await new Promise(r => setTimeout(r, 250)); } }
		})();
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
	let flavBake = () => {}; // set by the Flavour row: a hand on the FX (or undo) makes the flavoured settings the real ones
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
		flavBake(); commit();
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
		return Promise.all([store.put('state', { values, patch: synthUi?.patch(), dirty: synthUi?.isDirty() }),
			store.put('history', { list: hist.list, pos: hist.pos })]);
	}
	addEventListener('pagehide', () => { commit(); saveAll(); });

	// ── Live audio graph ──
	// pads ─┬→ kick ──────────────────┐
	//       └→ duck (sidechain on the kick) ┴→ bus → mix → DJ filter (HP → LP) → trim → master → speakers
	//       each hit also feeds its own send level → echo / room / crush → returns ─┘    loops ─┘
	// The master is the shared one from audio-core.js: glue, master volume, a gentle limiter, a clip light and a guard
	// against bad samples, all in one tiny worklet. An effect whose knob is at 0 is unplugged from the sends, so idle
	// effects cost nothing.
	let ac, bus, seqBus, duckBus, duckSeq, synthBus, clickBus, sendBus, mix, hpF, lpF, trimG, mst = null, crushNode = null, vc = null;
	let recTap, loopIn, recNode = null, workletReady = null; // loop bank: what gets recorded, where loops play
	let tempo = 120;
	const hooks = []; // run when the tempo changes
	const WORKLET = `
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
	// Records between two audio-clock times, sample-accurate. The audio goes out in small batches as it comes in,
	// so the audio thread never has to glue a long loop together in one go (that was a dropout on every loop stop).
	// One recorder is made per recording and it retires itself when it is done, so nothing records while idle.
	class Rec extends AudioWorkletProcessor {
		constructor() {
			super(); this.on = Infinity; this.off = Infinity; this.L = []; this.R = []; this.n = 0; this.total = 0; this.fin = false;
			this.port.onmessage = ({ data: m }) => {
				if (m.start !== undefined) { this.on = m.start; this.off = Infinity; this.L = []; this.R = []; this.n = 0; this.total = 0; }
				if (m.stop !== undefined) this.off = m.stop;
				if (m.cancel) { this.fin = true; this.L = []; this.R = []; }
			};
		}
		flush(done) {
			this.port.postMessage({ L: this.L, R: this.R, done }, [...this.L, ...this.R].map(a => a.buffer));
			this.L = []; this.R = []; this.n = 0;
		}
		process(I) {
			if (this.fin) return false;
			const inp = I[0], n = inp[0] ? inp[0].length : 128, t0 = currentTime, t1 = t0 + n / sampleRate;
			if (t1 <= this.on) return true;
			const a = Math.max(0, Math.round((this.on - t0) * sampleRate)), b = Math.min(n, Math.round((this.off - t0) * sampleRate));
			if (b > a) {
				const l = inp[0], r = inp[1] || inp[0];
				this.L.push(l ? l.slice(a, b) : new Float32Array(b - a)); this.R.push(r ? r.slice(a, b) : new Float32Array(b - a));
				this.n += b - a; this.total += b - a;
			}
			if (t1 >= this.off || this.total > sampleRate * 90) { this.flush(true); this.fin = true; return false; }
			if (this.n >= 16384) this.flush(false);
			return true;
		}
	}
	registerProcessor('nd-rec', Rec);
	registerProcessor('nd-crush', Crush);`;

	// ── Effects: one section for the whole kit. Filter is a DJ filter (left of centre = low-pass, right = high-pass);
	// Echo and Crush are sends; Duck is the kick pushing everything else down; Glue is the master glue, with a short
	// room folded into the top of the knob ──
	const ECHO_DIVS = [['1/8', 0.5], ['1/8D', 0.75], ['1/4', 1]]; // echo time, in beats, locked to the tempo
	const FXP = { filter: 0, echo: 0, duck: 0, glue: 0.25, crush: 0, div: 1 };
	const ROOM_AT = 0.6, ROOM_MAX = 3.5; // the glue knob's top 40% brings in the room; at full it sits about 4 dB under the dry hit
	const glueOf = v => Math.min(1, v / ROOM_AT), roomOf = v => NDAudio.prefs.lite ? 0 : Math.max(0, (v - ROOM_AT) / (1 - ROOM_AT));
	const crushOf = () => NDAudio.prefs.lite ? 0 : FXP.crush;
	const lpHz = a => 20000 * (90 / 20000) ** a, hpHz = a => 20 * (6000 / 20) ** a; // knob distance from centre → cutoff
	const pct = v => Math.round(v * 100) + '%', khz = v => v < 1000 ? Math.round(v) + ' Hz' : (v / 1000).toFixed(1) + 'k';
	// Each effect is built as a fresh little graph between its send and return, so "Cut FX" can throw the
	// whole thing away (tails and all) and build a clean one.
	const FX = {}, nodes = {};
	const set = (param, v, tau = 0.02) => param.setTargetAtTime(v, ac.currentTime, tau);
	const BUILD = {
		room() { // a small room, under a second, rolled off top and bottom
			const conv = ac.createConvolver(), hp = filt(ac, 'highpass', 300), lp = filt(ac, 'lowpass', 7000);
			chain(conv, hp, lp);
			return { input: conv, output: lp, conv };
		},
		dly() { // tape echo: a little darker and dirtier every repeat
			const dl = ac.createDelay(4), sat = shaper(ac, 1.1), tone = filt(ac, 'lowpass', 3200), fb = ac.createGain();
			const lfo = ac.createOscillator(), depth = ac.createGain();
			lfo.frequency.value = 0.55; depth.gain.value = 0.0005; chain(lfo, depth, dl.delayTime); lfo.start();
			chain(dl, sat, tone, fb, dl);
			return { input: dl, output: tone, dl, fb, lfo };
		},
		crush() { // grit after the SP-1200
			const lo = filt(ac, 'highpass', 100), drive = ac.createGain(), sat = shaper(ac, 2.5), hi = filt(ac, 'lowpass', 12000), trim = ac.createGain();
			chain(lo, drive, sat);
			if (crushNode) { crushNode.disconnect(); chain(sat, crushNode, hi); } else chain(sat, hi);
			chain(hi, trim);
			return { input: lo, output: trim, drive, trim };
		},
	};
	function irFor(len = 0.8, dens = 0.85, spread = 0.7) { // decaying noise; spread = stereo width
		const n = Math.ceil(ac.sampleRate * len), ir = ac.createBuffer(2, n, ac.sampleRate);
		const L = ir.getChannelData(0), R = ir.getChannelData(1), p = 0.004 + dens * dens * 0.996, amp = 1 / Math.sqrt(p);
		let e = 0;
		for (let i = 0; i < n; i++) {
			const env = Math.exp(-6.9 * i / n), a = Math.random() < p ? (Math.random() * 2 - 1) * amp : 0, b = Math.random() < p ? (Math.random() * 2 - 1) * amp : 0;
			L[i] = a * env; R[i] = (spread * b + (1 - spread) * a) * env;
			e += L[i] * L[i];
		}
		const k = 1 / Math.sqrt(e || 1);
		for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; }
		return ir;
	}
	function plug(id, on) { // an effect at 0 is unplugged from the sends
		const n = nodes[id];
		if (n.on === on) return;
		n.on = on;
		if (on) sendBus.connect(n.send); else try { sendBus.disconnect(n.send); } catch {}
	}
	function apply(id) {
		if (!ac) return;
		if (id === 'filter') {
			const v = FXP.filter, a = Math.abs(v), q = 0.7 + 3.3 * a * a; // the resonance comes up as you turn
			set(lpF.frequency, v < 0 ? lpHz(a) : Math.min(22000, ac.sampleRate / 2), 0.03); set(lpF.Q, v < 0 ? q : 0.5, 0.03);
			set(hpF.frequency, v > 0 ? hpHz(a) : 10, 0.03); set(hpF.Q, v > 0 ? q : 0.5, 0.03);
			return;
		}
		if (id === 'glue' || id === 'room') {
			mst.setGlue(glueOf(FXP.glue));
			const r = roomOf(FXP.glue);
			plug('room', r > 0); set(nodes.room.ret.gain, r * ROOM_MAX);
			if (r > 0 && !FX.room.conv.buffer) FX.room.conv.buffer = irFor();
			return;
		}
		const f = FX[id];
		if (id === 'dly') {
			const e = FXP.echo;
			plug('dly', e > 0); set(f.dl.delayTime, ECHO_DIVS[FXP.div][1] * 60 / tempo, 0.05);
			set(f.fb.gain, 0.25 + e * 0.5); set(nodes.dly.ret.gain, e * 0.9);
		} else if (id === 'crush') {
			const k = crushOf();
			plug('crush', k > 0); set(f.drive.gain, 30 ** (k * 0.6)); set(f.trim.gain, 1 / (1 + k * 0.9));
			set(nodes.crush.ret.gain, k > 0 ? 0.35 + k * 0.5 : 0);
			if (crushNode) { set(crushNode.parameters.get('bits'), 16 - 12 * k, 0.005); set(crushNode.parameters.get('rate'), Math.max(1500, ac.sampleRate * (1 - k * 0.9) ** 1.7), 0.005); }
		}
	}
	function build(id) {
		if (FX[id]) { nodes[id].send.disconnect(); FX[id].output.disconnect(); FX[id].lfo?.stop(); }
		FX[id] = BUILD[id]();
		nodes[id].send.connect(FX[id].input);
		FX[id].output.connect(nodes[id].ret);
		apply(id);
	}
	// Sidechain: each kick pushes everything else down by the Duck amount and lets it swell back over about an 8th
	let duckEnd = 0;
	function duck(t) {
		const depth = 1 - FXP.duck * 0.75, rel = 60 / tempo * 0.14;
		for (const p of [duckBus.gain, duckSeq.gain]) {
			if (t >= duckEnd) p.cancelScheduledValues(t); // never wipe a kick that is already booked later
			p.setValueAtTime(depth, t); p.setTargetAtTime(1, t + 0.01, rel);
		}
		duckEnd = Math.max(duckEnd, t);
	}

	function audio() {
		if (ac) return ac;
		if (NDAudio.prefs.lite && NDAudio.prefs.latency === 'tight') NDAudio.setPref('latency', 'safe');
		ac = NDAudio.context('play'); // Safe (about 12 ms) or Tight (the smallest buffer the device allows)
		SR = ac.sampleRate;
		mst = NDAudio.master(ac, { gain: MVOL, glue: glueOf(FXP.glue) });
		if (clipEl) NDAudio.clipLight(mst, clipEl);
		NDAudio.keepAlive(ac, () => rig.open);
		vc = NDAudio.voices(ac, NDAudio.prefs.lite ? 12 : 24);
		trimG = ac.createGain(); trimG.gain.value = 0.7; // headroom: the whole kit sits a few dB under the old mix
		chain(trimG, mst.input);
		mix = ac.createGain(); hpF = filt(ac, 'highpass', 10, 0.5); lpF = filt(ac, 'lowpass', Math.min(22000, ac.sampleRate / 2), 0.5);
		chain(mix, hpF, lpF, trimG);
		bus = ac.createGain(); clickBus = ac.createGain(); sendBus = ac.createGain(); synthBus = ac.createGain();
		seqBus = ac.createGain(); // patterns and the piano roll: heard, but kept out of loop recordings (they are on the grid already)
		duckBus = ac.createGain(); duckSeq = ac.createGain(); duckBus.connect(bus); duckSeq.connect(seqBus);
		bus.connect(mix); seqBus.connect(mix); clickBus.connect(mst.input);
		synthBus.connect(bus); synthBus.connect(sendBus);
		recTap = ac.createGain(); bus.connect(recTap); // "Pads" source: pads + their FX, never the loops or click
		loopIn = ac.createGain(); loopIn.connect(mix);
		for (const id of ['room', 'dly', 'crush']) {
			nodes[id] = { send: ac.createGain(), ret: ac.createGain(), on: false };
			nodes[id].ret.connect(mix); nodes[id].ret.connect(recTap);
			build(id);
		}
		apply('filter'); apply('glue');
		workletReady = (ac.audioWorklet ? ac.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))) : Promise.reject()).then(() => {
			crushNode = new AudioWorkletNode(ac, 'nd-crush', { outputChannelCount: [2] });
			build('crush');
		});
		workletReady.catch(() => {}); // no worklets (very old browsers): everything still plays, just without the crusher or loops
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
	pad.querySelector('.pad__cut').addEventListener('click', () => { if (ac) for (const id of ['room', 'dly', 'crush']) build(id); });
	hooks.push(() => { if (ac) apply('dly'); });

	// ── Master: volume, clip light, Safe/Tight latency and Lite mode, at the top of the pad ──
	let MVOL = 0.85;
	const tools = pad.querySelector('.pad__tools');
	const masterEl = document.createElement('span');
	masterEl.className = 'pad__master';
	masterEl.innerHTML = `<input class="pad__vol" type="range" min="0" max="1" step="0.01" aria-label="Master volume" title="Master volume">`
		+ `<i class="pad__clip" title="Clip light: red when the master is pushed too hard"></i>`
		+ `<button class="chip pad__latmode" type="button"></button><button class="chip pad__lite" type="button" aria-pressed="false">Lite</button>`;
	tools?.prepend(masterEl);
	const volEl = masterEl.querySelector('.pad__vol'), clipEl = masterEl.querySelector('.pad__clip');
	const latBtn = masterEl.querySelector('.pad__latmode'), liteBtn = masterEl.querySelector('.pad__lite');
	volEl.value = MVOL;
	volEl.addEventListener('input', () => { MVOL = +volEl.value; mst?.setGain(MVOL); saveSoon(); });
	ctl['master.vol'] = { get: () => MVOL, set: v => { MVOL = v; volEl.value = v; mst?.setGain(v); } };
	function modeUi() {
		const tight = NDAudio.prefs.latency === 'tight', lite = NDAudio.prefs.lite;
		latBtn.textContent = tight ? 'Tight' : 'Safe';
		latBtn.disabled = lite;
		latBtn.title = lite ? 'Lite mode keeps the safe buffer' : tight ? 'Tight: the smallest buffer, for playing live on a quiet computer. Tap for Safe.' : 'Safe: a slightly bigger buffer (about 12 ms) that does not crackle. Tap for Tight.';
		liteBtn.setAttribute('aria-pressed', String(lite));
		liteBtn.title = 'Lite: safe buffer, no room, no crush, fewer overlapping sounds and calmer lights, for phones and busy computers';
	}
	// A new buffer size needs a new audio engine: save everything, reload, and open the pad again
	async function relaunch() {
		commit();
		await saveAll();
		try { sessionStorage.setItem('bp-reopen', '1'); } catch {}
		location.reload();
	}
	latBtn.addEventListener('click', () => { NDAudio.setPref('latency', NDAudio.prefs.latency === 'tight' ? 'safe' : 'tight'); modeUi(); if (ac) relaunch(); });
	liteBtn.addEventListener('click', () => {
		const on = !NDAudio.prefs.lite, wasTight = NDAudio.prefs.latency === 'tight';
		NDAudio.setPref('lite', on);
		if (on && wasTight) NDAudio.setPref('latency', 'safe');
		modeUi();
		if (on && wasTight && ac) { relaunch(); return; }
		if (vc) vc.max = on ? 12 : 24;
		apply('glue'); apply('crush');
	});
	modeUi();

	// ── The effects row: Filter, Echo (with its time chip), Duck, Glue (+ room) and Crush ──
	const rackEl = pad.querySelector('.rack');
	if (rackEl) {
		rackEl.innerHTML = '<div class="rack__knobs fxrow"></div>';
		const row = rackEl.firstChild;
		const KN = [['filter', 'Filter', -1, v => Math.abs(v) < 0.02 ? 'Off' : v < 0 ? 'LP ' + khz(lpHz(-v)) : 'HP ' + khz(hpHz(v))],
			['echo', 'Echo', 0, pct], ['duck', 'Duck', 0, pct],
			['glue', 'Glue', 0, v => v <= ROOM_AT ? pct(glueOf(v)) : 'Room ' + pct((v - ROOM_AT) / (1 - ROOM_AT))], ['crush', 'Crush', 0, pct]];
		const TIPS = { filter: 'Turn left for low-pass, right for high-pass. Double-click to reset.', echo: 'Tape echo on the pads that send to it (Send mode sets each pad)',
			duck: 'The kick pushes everything else down, then it swells back', glue: 'Glues the whole kit together; the top of the knob adds a short room', crush: 'Bit crush and grit' };
		for (const [key, lab, min, fmt] of KN) {
			const target = key === 'echo' ? 'dly' : key;
			const el = document.createElement('div');
			el.className = 'kn'; el.title = TIPS[key];
			el.innerHTML = `<span class="knob" aria-label="${lab}"></span><b class="kn__v"></b><small>${lab}</small>`;
			row.append(el);
			const out = el.querySelector('.kn__v'), show = () => { out.textContent = fmt(FXP[key]); };
			const kn = knob(el.querySelector('.knob'), {
				min, max: 1, step: 0.01, value: FXP[key],
				onInput: v => { flavBake(); const before = FXP[key]; FXP[key] = key === 'filter' && Math.abs(v) < 0.02 ? 0 : v; show(); apply(target); touch('fx.' + key, before); },
			});
			ctl['fx.' + key] = { get: () => FXP[key], set: v => { FXP[key] = v; kn.set(v, false); show(); apply(target); } };
			show();
			if (key === 'echo') {
				const b = document.createElement('button');
				b.type = 'button'; b.className = 'rack__opt fxrow__time'; b.title = 'Echo time, locked to the tempo';
				const lbl = () => { b.textContent = ECHO_DIVS[FXP.div][0]; };
				b.addEventListener('click', () => { flavBake(); const before = FXP.div; FXP.div = (FXP.div + 1) % ECHO_DIVS.length; lbl(); apply('dly'); touch('fx.div', before); });
				ctl['fx.div'] = { get: () => FXP.div, set: v => { FXP.div = v; lbl(); apply('dly'); } };
				lbl(); el.append(b);
			}
		}
	}

	// ── Flavours: four macro knobs that each move several FX at once, plus 🎲 Surprise ──
	// They sit on top of your own FX settings (the base): the knobs show the blend, and bringing every flavour back to
	// 0 puts your settings back exactly. Touch an FX knob (or undo) while a flavour is up and the blend becomes your
	// new settings. Surprise is filtered random: one or two flavours, never more than the ear can take.
	const FLAVS = [ // amounts added per unit of flavour; div = the echo time it prefers
		['sweet', 'Sweet', { filter: -0.25, glue: 0.5, echo: 0.12 }, 'Soft and warm: a gentle low-pass, a little room and echo'],
		['sour', 'Sour', { filter: 0.3, echo: 0.3, crush: 0.15, div: 0 }, 'Thin and tangy: high-pass, a short echo, a touch of crush'],
		['smoky', 'Smoky', { filter: -0.45, echo: 0.45, duck: 0.5, div: 2 }, 'Dark and slow: a deep low-pass, a long echo, the kick pumping the rest'],
		['fizz', 'Fizz', { filter: 0.18, crush: 0.45, echo: 0.2, div: 0 }, 'Bright and sparkly: crush and a fast echo'],
	];
	const FXKEYS = ['filter', 'echo', 'duck', 'glue', 'crush', 'div'];
	const flav = { sweet: 0, sour: 0, smoky: 0, fizz: 0 }, flavKn = {};
	let flavBase = null;
	function flavApply() {
		const on = Object.values(flav).some(v => v > 0);
		if (!on) { if (flavBase) { const b = flavBase; flavBase = null; for (const k of FXKEYS) ctl['fx.' + k]?.set(b[k]); } return; }
		flavBase ||= Object.fromEntries(FXKEYS.map(k => [k, FXP[k]]));
		const out = { ...flavBase };
		let pull = 0;
		for (const [id, , adds] of FLAVS) for (const [k, d] of Object.entries(adds)) {
			if (k !== 'div') out[k] += d * flav[id];
			else if (flav[id] * adds.echo > pull) { pull = flav[id] * adds.echo; out.div = d; }
		}
		out.filter = Math.max(-1, Math.min(1, out.filter));
		for (const k of ['echo', 'duck', 'glue', 'crush']) out[k] = Math.max(0, Math.min(1, out[k]));
		for (const k of FXKEYS) if (FXP[k] !== out[k]) ctl['fx.' + k]?.set(k === 'div' ? out[k] : +out[k].toFixed(3));
	}
	flavBake = () => {
		if (!flavBase) return;
		flavBase = null;
		for (const id in flav) { flav[id] = 0; flavKn[id]?.set(0, false); flavKn[id]?.show(); }
	};
	for (const k of FXKEYS) { // what gets saved and undone is your own setting, never the flavoured one
		const c = ctl['fx.' + k];
		if (c) { const g = c.get; c.get = () => flavBase ? flavBase[k] : g(); }
	}
	const flavRow = document.createElement('div');
	flavRow.className = 'flav'; flavRow.setAttribute('role', 'group'); flavRow.setAttribute('aria-label', 'Flavours');
	for (const [id, lab, , tip] of FLAVS) {
		const el = document.createElement('div');
		el.className = 'kn flav__kn'; el.title = tip + '. Double-click for 0.';
		el.innerHTML = `<span class="knob" aria-label="${lab}"></span><small>${lab}</small>`;
		flavRow.append(el);
		const kn = knob(el.querySelector('.knob'), { min: 0, max: 1, step: 0.01, value: 0, onInput: v => { flav[id] = v; kn.show(); flavApply(); } });
		kn.show = () => el.classList.toggle('is-on', flav[id] > 0);
		flavKn[id] = kn;
	}
	const surprise = document.createElement('button');
	surprise.type = 'button'; surprise.className = 'chip flav__dice'; surprise.textContent = '✨ Surprise';
	surprise.title = 'Surprise: a random blend of one or two flavours';
	surprise.addEventListener('click', () => {
		const ids = FLAVS.map(f => f[0]).sort(() => Math.random() - 0.5), two = Math.random() < 0.6;
		for (const id in flav) flav[id] = 0;
		flav[ids[0]] = 0.35 + Math.random() * 0.45;
		if (two) flav[ids[1]] = 0.2 + Math.random() * 0.3;
		if (flav.sour + flav.fizz > 0.9) { const k = 0.9 / (flav.sour + flav.fizz); flav.sour *= k; flav.fizz *= k; } // both at once get harsh
		for (const id in flav) { flavKn[id].set(flav[id], false); flavKn[id].show(); }
		flavApply();
	});
	flavRow.append(surprise);

	// ── Pads ──
	let kit = 'soul';
	const groups = {}; // mute group → playing voice
	// Pad modes: Play (tap to play), Rec Pads (tap a pad to record your mic into it), Vol and Send (drag a pad up or down)
	let padMode = 'play';
	const padMix = {}; // kit → { v: each pad's volume, s: each pad's send to the echo, room and crush } (1 = as rendered)
	const mixOf = k => padMix[k] ||= { v: Array(PADS).fill(1), s: Array(PADS).fill(1) };
	const VOL_MAX = 1.5;
	const els = KEY_LABELS.map((k, i) => {
		const b = document.createElement('button');
		b.type = 'button'; b.className = 'pad__btn';
		b.innerHTML = `<i class="pad__glow"></i><span class="pad__key">${k}</span><span class="pad__name"></span><span class="pad__val"></span>`;
		grid.append(b);
		b.addEventListener('pointerdown', e => {
			if (e.button !== 0) return;
			e.preventDefault();
			if (padMode === 'play') hit(i);
			else if (padMode === 'rec') padRecTap(i);
			else dragStart(i, b, e);
		});
		b.addEventListener('click', e => { if (e.detail === 0) hit(i); }); // Enter/Space when tabbed to
		b.addEventListener('contextmenu', e => { e.preventDefault(); loadInto = i; audio(); fileIn.click(); });
		return b;
	});
	const vals = els.map(b => b.querySelector('.pad__val'));
	function showVals() {
		if (padMode !== 'vol' && padMode !== 'send') return;
		const m = mixOf(kit), arr = padMode === 'vol' ? m.v : m.s;
		vals.forEach((el, i) => { el.textContent = pct(arr[i]); });
	}
	// Vol / Send: drag up or down (Shift = fine); a tap without a drag plays the pad
	function dragStart(i, b, e) {
		b.setPointerCapture(e.pointerId);
		const m = mixOf(kit), arr = padMode === 'vol' ? m.v : m.s, top = padMode === 'vol' ? VOL_MAX : 1;
		const y0 = e.clientY, v0 = arr[i], before = ctl['pads.mix'].get();
		let moved = false;
		const move = ev => {
			if (!moved && Math.abs(ev.clientY - y0) < 4) return;
			moved = true;
			arr[i] = +Math.min(top, Math.max(0, v0 + (y0 - ev.clientY) / (ev.shiftKey ? 600 : 150))).toFixed(2);
			vals[i].textContent = pct(arr[i]);
		};
		const up = () => {
			b.removeEventListener('pointermove', move); b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up);
			if (moved) touch('pads.mix', before); else hit(i);
		};
		b.addEventListener('pointermove', move); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
	}
	ctl['pads.mix'] = { get: () => JSON.stringify(padMix), set: v => { for (const k in padMix) delete padMix[k]; Object.assign(padMix, JSON.parse(v || '{}')); showVals(); } };
	function label() {
		KITS[kit].pads.forEach((p, i) => {
			const own = custom[kit][i];
			els[i].querySelector('.pad__name').textContent = own ? own.name : p[0];
			els[i].dataset.c = own ? 'u' : p[3];
		});
		showVals();
		if (kitSel) { kitSel.value = kit; kitSel.classList.toggle('is-on', mode === 'pads'); }
		pad.querySelector('[data-mode="synth"]')?.classList.toggle('is-on', mode === 'synth');
	}
	function setMode(m) {
		mode = m;
		grid.hidden = m !== 'pads';
		if (modeBar) modeBar.hidden = m !== 'pads';
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
	let modeBar = null;
	label();
	// Pad lights: only the overlay's opacity animates (the compositor does it, the page never repaints), and a new
	// flash replaces the last one on that pad instead of piling up.
	const glows = els.map(b => b.querySelector('.pad__glow')), glowing = [], pressing = [];
	function flash(i, ms = 200) {
		glowing[i]?.cancel();
		glowing[i] = glows[i].animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: ms, easing: 'ease-out' });
	}
	// Synesthesia (synesthesia.js, when it is there): every hit becomes colour, from its pitch or, for drums, how bright it is
	const BRIGHT = [0.1, 0.5, 0.6, 0.9, 0.85, 0.8, 0.55, 0.7, 0.95, 0.4, 0.9, 0.75];
	const midiHz = n => 440 * 2 ** ((n - 69) / 12);
	function synNote(k, i, strength) {
		if (!window.NDSyn) return;
		const own = custom[k]?.[i], h = KITS[k]?.harm;
		if (own || i < CHORD || !h) NDSyn.note(null, own ? 0.5 : BRIGHT[i] ?? 0.5, strength);
		else NDSyn.note(midiHz(i < BASS ? h[i - CHORD].notes[0] : h[i - BASS].bass), i < BASS ? 0.6 : 0.2, strength);
	}

	async function hit(i) {
		const c = audio();
		if (c.state === 'suspended') c.resume();
		const own = custom[kit][i];
		if (!own && !buffers[kit]) await renderKit(kit);
		playPad(kit, i, c.currentTime);            // sound first; every visual waits until it's scheduled
		flash(i, 260);
		synNote(kit, i, 1);
		if (!NDAudio.prefs.lite) {
			pressing[i]?.cancel();
			pressing[i] = els[i].animate([{ transform: 'scale(0.93)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)' });
		}
		window.wiggler?.hit(own ? 'u' : KITS[kit].pads[i][3], i === 0 || /kick/i.test(KITS[kit].pads[i][0]) ? 1.2 : 0.8);
		roll?.capture(kit, i, 1);
		league?.score('p' + i);
	}
	// The sound itself, now or at a scheduled time (the piano roll books hits slightly ahead). Every pad is mono:
	// a new hit of the same pad cuts the last one, and the whole kit is capped (24 sounds, 12 in Lite) so a pile-up
	// never overloads the audio.
	function playPad(k, i, at, vel = 1, out = bus) {
		const own = custom[k]?.[i], def = KITS[k]?.pads[i];
		const buf = own ? own.buffer : buffers[k]?.[i];
		if (!buf || !def) return;
		const group = own ? null : def[4], t = Math.max(ac.currentTime, at), m = mixOf(k);
		if (group && groups[group]) { // choke: closed hat cuts open hat, a new 808 note cuts the last
			const v = groups[group];
			v.g.gain.setTargetAtTime(0, t, 0.008);
			v.src.stop(t + 0.05);
		}
		const src = ac.createBufferSource(), g = ac.createGain();
		src.buffer = buf; g.gain.value = vel * levelTrim(buf) * m.v[i];
		chain(src, g, i === 0 ? out : out === seqBus ? duckSeq : duckBus); // the kick is the sidechain, never ducked itself
		if (m.s[i] === 1) g.connect(sendBus);
		else if (m.s[i] > 0) { const sg = ac.createGain(); sg.gain.value = m.s[i]; chain(g, sg, sendBus); }
		src.start(t);
		vc.play(src, g, i, t);
		if (i === 0 && FXP.duck > 0) duck(t);
		if (group) { groups[group] = { src, g }; src.onended = () => { if (groups[group]?.src === src) delete groups[group]; }; }
	}

	// ── Patterns: MIDI patterns for the kits, each with a Part A and a Part B of 32 bars ──
	// A part is a few short lanes (one character per 16th: x = hit, o = soft, . = rest; 16 chars = 1 bar, longer lanes
	// span several bars), a chord progression (one chord pad index per bar), a chord rhythm and a bass rhythm
	// (x/o = the bar's chord root, n = lead into the next bar's root). compile() grows that into 32 bars the way a
	// drummer would play it: crash on bars 1 and 17, a small variation every 4 bars, fills ending every 8, and a
	// bigger fill back into bar 1. Drum slots: K kick, S snare, C clap, H hat, O open hat, R ride/perc, G ghost,
	// M rim, T shaker, P perc/tom, X crash, F fx.
	const SLOT = { K: 0, S: 1, C: 2, H: 3, O: 4, R: 5, G: 6, M: 7, T: 8, P: 9, X: 10, F: 11 };
	const Z = n => '.'.repeat(n);
	const PATTERNS = [
		{ name: 'Boom bap soul', kit: 'soul', bpm: 90, swing: 0.25,
			A: { d: { K: 'x......x..x.....', S: '....x.......x...', H: 'x.x.x.x.x.x.x.x.' }, prog: [0, 1, 2, 2], ch: 'x...............', bs: 'x......x..x.....' },
			B: { d: { K: 'x......x.xx...x.', S: '....x..o....x...', H: 'x.xxx.x.x.xxx.x.', M: '.......o......o.' }, prog: [3, 1, 2, 5], ch: 'x.....x.........', bs: 'x......x..x...n.' } },
		{ name: 'Trap 808', kit: '808', bpm: 140, swing: 0,
			A: { d: { K: 'x.........x.....x......x..x.....', S: '........x.......', C: '........x.......', H: 'x.x.x.x.x.x.x.x.' }, prog: [0, 1, 2, 3], ch: 'x...............', bs: 'x.........x.....x......x..x.....' },
			B: { d: { K: 'x..x......x.....x......x..x..x..', S: '........x.......', C: '........x.......', H: 'x.x.x.xxx.x.xxxx', R: Z(48) + '......x.........', F: Z(112) + '........x.......' }, prog: [0, 3, 1, 4], ch: 'x.......x.......', bs: 'x..x......x.....x......x..x..n..' } },
		{ name: 'Amen roller', kit: 'jungle', bpm: 168, swing: 0,
			A: { d: { K: 'x.x.......xx......xx......x.....', S: '....x..o.o..x..o.o..x..o.o....x.', H: 'x.x.x.x.x.x.x.x.', R: '..x...x...x...x.' }, prog: [0, 0, 1, 1], ch: 'x...............', bs: 'x.........x...............x.....' },
			B: { d: { K: 'x.x.......xx......xx......x.....', S: '....x..o.o.ox..o.o..x..oxo..x.ox', H: 'x.x.x.x.x.x.x.x.', R: 'x.x.x.x.x.x.x.x.', F: 'x' + Z(127) }, prog: [0, 2, 3, 4], ch: 'x.......x.......', bs: 'x.....x...x...x.x.....x...x..n..' } },
		{ name: 'Liquid roller', kit: 'liquid', bpm: 174, swing: 0,
			A: { d: { K: 'x.........x.....', S: '....x.......x...', G: '.......o......o.', H: '..x...x...x...x.', T: 'o.o.o.o.o.o.o.o.' }, prog: [0, 1, 2, 3], ch: 'x...............', bs: 'x.........x.....' },
			B: { d: { K: 'x.........x.....x.........x..x..', S: '....x.......x...', G: '.......o......o.', H: '..x...x...x...x.', R: 'x.x.x.x.x.x.x.x.', F: Z(30) + 'x.' }, prog: [0, 1, 4, 5], ch: 'x.......x.......', bs: 'x.....x...x.....x.....x...x...n.' } },
		{ name: 'Neuro roller', kit: 'neuro', bpm: 174, swing: 0,
			A: { d: { K: 'x.........x.....', S: '....x.......x...', H: '..x...x...x...x.', G: '.......o...o....' }, prog: [0, 0, 1, 1], ch: '.......x......x.', bs: 'x..x..x...x..x..x..x..x...x.....' },
			B: { d: { K: 'x.........x..x..x.x.......x.....', S: '....x.......x...', H: '..x...x...x...x.', T: 'o.o.o.o.o.o.o.o.', F: Z(14) + 'x.' + Z(16) }, prog: [0, 1, 2, 3], ch: '.......x......x.', bs: 'x.xx.xx.x.xx.x.x' } },
		{ name: 'Halftime wobble', kit: 'dubstep', bpm: 140, swing: 0,
			A: { d: { K: 'x.........x.....x......x..x.....', S: '........x.......', H: 'x.o.x.o.x.o.x.o.', O: Z(30) + 'x.' }, prog: [0, 0, 1, 2], ch: 'x...............' + '......x.........', bs: 'x.x.....x...x.x.x.x.....x...x...' },
			B: { d: { K: 'x.........x.....x......x..x.....', S: '........x.......', C: '........x.......', H: 'x.o.x.o.x.o.x.o.', F: Z(31) + 'x' }, prog: [0, 1, 2, 3], ch: 'x.......x.......', bs: 'x.x.x.x.x.x.x.x.xxx.x.x.x.xxx.n.' } },
		{ name: 'Halftime soul', kit: 'half', bpm: 80, swing: 0.15,
			A: { d: { K: 'x.....x...x.....x.....x.x.......', S: '........x.......', H: 'x.x.x.x.x.x.x.x.', T: '....x.......x...' }, prog: [0, 1, 2, 3], ch: 'x.......x.......', bs: 'x.....x...x.....x.....x.x.......' },
			B: { d: { K: 'x.....x...x..x..x.....x.x.....x.', S: '........x.......', H: 'x.x.xxx.x.x.x.xx', F: Z(22) + 'x.' + Z(8) }, prog: [0, 3, 1, 4], ch: 'x.....x.........', bs: 'x.....x...x..x..x.....x.x....n..' } },
		{ name: '2-step garage', kit: 'ukg', bpm: 132, swing: 0.22,
			A: { d: { K: 'x.........x.....x......x..x.....', S: '....x.......x...', H: '..x...x...x...x.', T: 'o.o.o.o.o.o.o.o.', G: '.......o.o.....o' }, prog: [0, 1, 2, 3], ch: '...x..x.........' + '...x..x....x....', bs: 'x.........x.....x......x..x..x..' },
			B: { d: { K: 'x.........x.....x......x..x.....', S: '....x.......x...', H: '..x...x...x...x.', R: '..x...x...x...x.', G: '.......o.o.....o', F: '..x.' + Z(28) }, prog: [0, 1, 4, 3], ch: '...x..x...x.....', bs: 'x..x......x..x..x......x..x..n..' } },
		{ name: 'Deep house', kit: 'house', bpm: 124, swing: 0.1,
			A: { d: { K: 'x...x...x...x...', C: '....x.......x...', O: '..x...x...x...x.', T: '.o.o.o.o.o.o.o.o' }, prog: [0, 1, 2, 3], ch: '...x..x....x....', bs: '..x...x...x...x.' },
			B: { d: { K: 'x...x...x...x...', C: '....x.......x...', O: '..x...x...x...x.', T: '.o.o.o.o.o.o.o.o', P: '...x..x....x..x.', M: '.......x......x.' }, prog: [0, 3, 4, 1], ch: '...x..x....x..x.', bs: '..xx..x...xx..x.' } },
		{ name: 'Tech house roller', kit: 'tech', bpm: 126, swing: 0.05,
			A: { d: { K: 'x...x...x...x...', C: '....x.......x...', O: '..x...x...x...x.', T: 'o.ox.oxoo.ox.oxo' }, prog: [0, 0, 0, 0], ch: Z(14) + 'x.' + Z(16), bs: '..xx..xx..xx..xx' },
			B: { d: { K: 'x...x...x...x...', C: '....x.......x...', O: '..x...x...x...x.', T: 'o.ox.oxoo.ox.oxo', P: '...x..x....x..x.', F: Z(62) + 'x.' }, prog: [0, 0, 1, 1], ch: '...x......x.....', bs: '.xxx.xxx.xxx.xxx' } },
		{ name: 'Roller disco', kit: 'disco', bpm: 118, swing: 0,
			A: { d: { K: 'x...x...x...x...', S: '....x.......x...', O: '..x...x...x...x.', T: 'o.o.o.o.o.o.o.o.', P: '......o..o....o.' }, prog: [0, 1, 2, 3], ch: 'x...............', bs: 'x.x.....x.x...x.' },
			B: { d: { K: 'x...x...x...x...', S: '....x.......x...', C: '....x.......x...', O: '..x...x...x...x.', T: 'o.o.o.o.o.o.o.o.', P: '......o..o....o.', F: '..x...x...x...x.' }, prog: [0, 3, 4, 1], ch: 'x.......x.......', bs: 'x.x.x.x.x.x.x.n.' } },
		{ name: 'Dub one-drop', kit: 'dub', bpm: 75, swing: 0.15,
			A: { d: { K: '........x.......', M: '........x.......', H: 'x.x.x.x.x.x.x.x.' }, prog: [0, 0, 1, 1], ch: '....x.......x...', bs: 'x.....x.x.......x.....x...x.x...' },
			B: { d: { K: 'x...x...x...x...', M: '........x.......', H: 'x.x.x.x.x.x.x.x.', F: 'x' + Z(63) }, prog: [0, 1, 2, 1], ch: '..x...x...x...x.', bs: 'x.....x.x...x...x.....x...x.x.n.' } },
	];
	function compile(pt) { // one part → 32 bars, each a list of [16th step, pad, velocity]
		const bars = [];
		for (let b = 0; b < 32; b++) {
			const ev = [], add = (s, p, v) => ev.push([s, p, v]);
			const fill = b % 8 === 7, big = b === 31, vary = b % 4 === 3 && !fill;
			for (const [ln, lane] of Object.entries(pt.d)) for (let s = 0; s < 16; s++) {
				const ch = lane[(b * 16 + s) % lane.length];
				if (ch !== 'x' && ch !== 'o') continue;
				if (fill && s >= (big ? 8 : 12) && 'SGHOC'.includes(ln)) continue; // the fill takes over the end of the bar
				if ((b === 15 || big) && ln === 'K' && s >= 12) continue;           // a breath before the next phrase
				add(s, SLOT[ln] ?? +ln.slice(1), ch === 'x' ? 1 : 0.45);           // '#7' = pad 7 (a chop lane)
			}
			if (b === 0 || b === 16) add(0, SLOT.X, 0.9);
			if (vary) { add(14, SLOT.O, 0.6); add(15, SLOT.G, 0.4); }
			if (big) for (let s = 8; s < 16; s++) add(s, s % 4 === 2 ? SLOT.P : SLOT.S, 0.4 + (s - 8) * 0.08); // the roll back into bar 1
			else if (fill) for (const [s, v] of b === 15 ? [[12, 0.8], [13, 0.4], [14, 0.9], [15, 0.5]] : [[12, 0.5], [13, 0.6], [14, 0.8], [15, 1]]) add(s, SLOT.S, v);
			const chord = pt.prog[b % pt.prog.length], next = pt.prog[(b + 1) % pt.prog.length];
			for (let s = 0; s < 16; s++) {
				const c = pt.ch[(b * 16 + s) % pt.ch.length], k = pt.bs[(b * 16 + s) % pt.bs.length];
				if (c === 'x' || c === 'o') add(s, CHORD + chord, c === 'x' ? 0.8 : 0.5);
				if (k === 'x' || k === 'o') add(s, BASS + chord, k === 'x' ? 0.95 : 0.6);
				else if (k === 'n') add(s, BASS + next, 0.8);
			}
			bars.push(ev.sort((a, b) => a[0] - b[0]));
		}
		return bars;
	}
	for (const p of PATTERNS) p.bars = { A: compile(p.A), B: compile(p.B) };

	// Playback: books the next ~120 ms ahead on the audio clock. A pattern or part change waits for the next bar line.
	const pat = { on: null, part: 'A', want: null, bar: 0, step: 0, at: 0, timer: 0 };
	function patTick() {
		while (pat.on && pat.at < ac.currentTime + 0.12) {
			if (pat.step === 0 && pat.want) {
				if (pat.want.p !== pat.on) { pat.on = pat.want.p; usePattern(pat.on); pat.bar = 0; }
				if (pat.want.part !== pat.part) { pat.part = pat.want.part; pat.bar = 0; }
				pat.want = null;
			}
			const p = pat.on, s16 = 60 / (metro?.bpm || p.bpm) / 4, at = pat.at + (pat.step % 2 ? p.swing * s16 : 0);
			const lit = [];
			for (const [s, i, v] of p.bars[pat.part][pat.bar]) if (s === pat.step) { playPad(p.kit, i, at, v, seqBus); lit.push(i); }
			const beat = pat.step % 4 === 0, acc = pat.step === 0, bar = pat.step === 0 ? pat.bar : -1;
			if (lit.length || beat) setTimeout(() => { // one timer per 16th, not one per hit
				if (p.kit === kit && mode === 'pads') for (const i of lit) flash(i, 160);
				for (const i of lit) synNote(p.kit, i, 0.6);
				if (beat) window.wiggler?.beat(acc);
				if (bar >= 0) patUi(bar);
			}, Math.max(0, (at - ac.currentTime) * 1000));
			pat.at += s16;
			if (++pat.step === 16) { pat.step = 0; pat.bar = (pat.bar + 1) % 32; }
		}
	}
	function usePattern(p) {
		ctl['metro.bpm']?.set(p.bpm);
		if (mode === 'pads' && kit !== p.kit) { kit = p.kit; label(); }
	}
	async function patPlay(p, part) {
		const c = audio();
		if (c.state === 'suspended') c.resume();
		await renderKit(p.kit);
		if (pat.on) { pat.want = { p, part }; patUi(); return; } // already rolling: change over on the next bar
		Object.assign(pat, { on: p, part, want: null, bar: 0, step: 0, at: c.currentTime + 0.08 });
		usePattern(p);
		pat.timer = setInterval(patTick, 25); patTick(); patUi(0);
	}
	function beatStop() { clearInterval(pat.timer); pat.timer = 0; pat.on = pat.want = null; patUi(); }

	const beatBar = document.createElement('div');
	beatBar.className = 'beats'; beatBar.setAttribute('role', 'group'); beatBar.setAttribute('aria-label', 'Patterns for the kits');
	beatBar.innerHTML = `<select class="track beats__pick" aria-label="Pick a pattern">${PATTERNS.map((p, i) => `<option value="${i}">${KITS[p.kit].name} · ${p.name} · ${p.bpm}</option>`).join('')}</select>`
		+ `<span class="beats__parts"><button class="chip beats__part" type="button" data-part="A" aria-pressed="true" title="Part A (32 bars)">A</button><button class="chip beats__part" type="button" data-part="B" aria-pressed="false" title="Part B (32 bars): switches on the next bar">B</button></span>`
		+ `<button class="track beats__go" type="button" aria-pressed="false">▶ Play</button>`
		+ `<button class="chip beats__midi" type="button" title="Download this pattern (Part A then B, 64 bars) as a MIDI file">⇩ MIDI</button>`;
	grid.before(beatBar);
	beatBar.after(flavRow);
	const beatPick = beatBar.querySelector('.beats__pick'), beatGo = beatBar.querySelector('.beats__go'), partBtns = [...beatBar.querySelectorAll('.beats__part')];
	let partSel = 'A';
	function patUi(bar) {
		const part = pat.want?.part || (pat.on ? pat.part : partSel);
		partBtns.forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.part === part)); b.classList.toggle('is-wait', !!pat.want && b.dataset.part === pat.want.part && pat.want.part !== pat.part); });
		const txt = pat.on ? `■ ${pat.part} ${(bar ?? pat.bar) + 1}/32` : '▶ Play';
		if (beatGo.textContent !== txt) beatGo.textContent = txt;
		beatGo.setAttribute('aria-pressed', String(!!pat.on)); beatGo.classList.toggle('is-on', !!pat.on);
	}
	beatGo.addEventListener('click', () => pat.on ? beatStop() : patPlay(PATTERNS[beatPick.value], partSel));
	beatPick.addEventListener('change', () => {
		const p = PATTERNS[beatPick.value];
		if (pat.on) patPlay(p, partSel);
		else if (mode === 'pads' && kit !== p.kit) { kit = p.kit; renderKit(kit); label(); }
	});
	partBtns.forEach(b => b.addEventListener('click', () => {
		partSel = b.dataset.part;
		if (pat.on) pat.want = { p: pat.want?.p || pat.on, part: partSel };
		patUi();
	}));

	// ── 🎲 Generate: a fresh Part A and B for the kit on screen, from rules a drummer would follow ──
	// Filtered randomness: each kit's genre gives the backbone (where the kick and snare go), the hats get a density and
	// accents, ghosts and one percussion lane are sprinkled where they cannot clash with the snare, the bass mostly
	// locks to the kick, and the chords walk one of a few progressions that always resolve. compile() then adds the
	// crashes, the variations and the fills. A chop kit (your recordings) plays its chops instead: low and sharp ones
	// as drums, words and hooks as phrases that are never cut off by their own next hit. Every take is a seed, so the
	// last ones come back with ◀ ▶, and Keep puts one in the pattern list for good.
	function rng(seed) { // mulberry32
		let a = seed >>> 0;
		const r = () => { a = a + 0x6d2b79f5 >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
		r.pick = arr => arr[Math.floor(r() * arr.length)];
		r.chance = p => r() < p;
		r.range = ([a, b]) => a + r() * (b - a);
		return r;
	}
	const FEEL = { // bpm, swing, kick and snare backbones, hat lanes, which lanes may sprinkle, chord rhythms, bass mode
		boom: { bpm: [86, 96], swing: [0.18, 0.28], snare: 'S', K: ['x......x..x.....', 'x.........x..x..', 'x......x.xx.....', 'x..x......x.....'], S: ['....x.......x...'],
			H: ['x.x.x.x.x.x.x.x.', 'x.xxx.x.x.xxx.x.'], perc: ['M', 'T', 'R'], ghost: 0.12, ch: ['x...............', 'x.....x.........', 'x.......x.......'], bass: 'kick' },
		trap: { bpm: [136, 146], swing: [0, 0], snare: 'S', clap: true, K: ['x.........x.....x......x..x.....', 'x..x......x.....x.....x...x..x..', 'x.......x.x.....x......x........'],
			S: ['........x.......'], H: ['x.x.x.x.x.x.x.x.', 'x.x.x.xxx.x.xxxx', 'xxx.x.x.x.xxx.x.'], perc: ['R', 'M', 'T'], ghost: 0, ch: ['x...............', 'x.......x.......'], bass: 'kick' },
		dnb: { bpm: [170, 175], swing: [0, 0], snare: 'S', K: ['x.........x.....', 'x.........x.....x.........x..x..', 'x.x.......xx......xx......x.....'], S: ['....x.......x...'],
			H: ['..x...x...x...x.', 'x.x.x.x.x.x.x.x.'], perc: ['T', 'R'], ghost: 0.14, ch: ['x...............', 'x.......x.......'], bass: 'kick' },
		wob: { bpm: [140, 140], swing: [0, 0], snare: 'S', K: ['x.........x.....x......x..x.....', 'x...............x.........x.....'], S: ['........x.......'],
			H: ['x.o.x.o.x.o.x.o.', 'x.x.x.x.x.x.x.x.'], perc: ['O', 'R'], ghost: 0.06, ch: ['x...............' + '......x.........', 'x...............'], bass: 'kick' },
		half: { bpm: [76, 84], swing: [0.12, 0.18], snare: 'S', K: ['x.....x...x.....x.....x.x.......', 'x.....x...x..x..x.....x.x.....x.'], S: ['........x.......'],
			H: ['x.x.x.x.x.x.x.x.', 'x.x.xxx.x.x.x.xx'], perc: ['T', 'M'], ghost: 0.1, ch: ['x.......x.......', 'x.....x.........'], bass: 'kick' },
		step2: { bpm: [130, 134], swing: [0.18, 0.24], snare: 'S', K: ['x.........x.....x......x..x.....', 'x.........x.....x.........x.....'], S: ['....x.......x...'],
			H: ['..x...x...x...x.'], perc: ['T', 'R'], ghost: 0.16, ch: ['...x..x.........' + '...x..x....x....', '...x..x...x.....'], bass: 'kick' },
		four: { bpm: [122, 127], swing: [0.04, 0.1], snare: 'C', K: ['x...x...x...x...'], S: ['....x.......x...'], H: ['..x...x...x...x.'], hatLane: 'O',
			perc: ['P', 'M'], ghost: 0, ch: ['...x..x....x....', 'x...............', '...x......x.....'], bass: 'off' },
		disco: { bpm: [116, 122], swing: [0, 0.04], snare: 'S', K: ['x...x...x...x...'], S: ['....x.......x...'], H: ['..x...x...x...x.'], hatLane: 'O',
			perc: ['P'], ghost: 0, ch: ['x...............', 'x.......x.......'], bass: 'octave' },
		dub: { bpm: [72, 78], swing: [0.12, 0.18], snare: 'M', K: ['........x.......'], S: ['........x.......'], H: ['x.x.x.x.x.x.x.x.'],
			perc: ['T'], ghost: 0, ch: ['....x.......x...', '..x...x...x...x.'], bass: 'dub' },
	};
	const KIT_FEEL = { soul: 'boom', 808: 'trap', jungle: 'dnb', liquid: 'dnb', neuro: 'dnb', dubstep: 'wob', half: 'half', ukg: 'step2', house: 'four', tech: 'four', disco: 'disco', dub: 'dub' };
	const PROGS = [[0, 1, 2, 3], [0, 3, 1, 4], [0, 0, 1, 1], [0, 2, 3, 4], [0, 5, 3, 4], [0, 4, 1, 3], [0, 1, 4, 3], [0, 0, 3, 3]];
	const GEN_NAMES = [['Pocket', 'Velvet', 'Rubber', 'Midnight', 'Dusty', 'Golden', 'Sunday', 'Heavy', 'Paper', 'Honey', 'Static', 'Moss', 'Neon', 'Rattle'],
		['Shuffle', 'Engine', 'Lantern', 'Signal', 'Ladder', 'Bounce', 'Riddim', 'Parade', 'Wiggle', 'Roller', 'Puddle', 'Tunnel', 'Kettle', 'Comet']];
	// One lane string: c at each step where p(step) says so
	const laneOf = (len, p, c = 'x') => Array.from({ length: len }, (_, s) => (p(s) ? (typeof c === 'function' ? c(s) : c) : '.')).join('');
	function hatsWithAccents(r, lane) { // downbeats loud, the rest a mix of soft and loud, so the hats breathe
		return [...lane].map((c, s) => c === '.' ? '.' : s % 4 === 0 ? 'x' : r.chance(0.6) ? 'o' : 'x').join('');
	}
	function mutateKick(r, k, snare) { // sometimes one extra kick, on a free step that is not the snare's
		const free = [...k].map((c, s) => c === '.' && snare[s % snare.length] === '.' && snare[(s + 1) % snare.length] === '.' && s % 16 > 2 ? s : -1).filter(s => s >= 0);
		if (!free.length || !r.chance(0.45)) return k;
		const s = r.pick(free), a = [...k]; a[s] = 'x';
		return a.join('');
	}
	function bassFor(r, F, kick) { // the bass follows the kick (or its genre's own move), and sometimes leads into the next bar
		if (F.bass === 'off') return r.pick(['..x...x...x...x.', '..xx..xx..xx..xx', '..x..xx...x..xx.']);
		if (F.bass === 'octave') return r.pick(['x.x.....x.x...x.', 'x.x.x.x.x.x.x.x.', 'x...x.x.x...x.x.']);
		if (F.bass === 'dub') return r.pick(['x.....x.x.......x.....x...x.x...', 'x...x...x.x.....x.....x.x.......', 'x.....x.x...x...x.....x...x.x.n.']);
		return laneOf(Math.max(16, kick.length), s => kick[s % kick.length] === 'x' ? r.chance(0.88) : (s % 16 === 14 && r.chance(0.25)) || (s % 2 === 0 && r.chance(0.04)),
			s => kick[s % kick.length] === 'x' ? 'x' : s % 16 === 14 ? 'n' : 'o');
	}
	function drumPart(r, F, B) { // B = Part B: busier, a different kick and progression, an fx hit at the end of the phrase
		const d = {}, snare = r.pick(F.S);
		let K = mutateKick(r, r.pick(F.K), snare);
		if (B) K = mutateKick(r, K, snare);
		if (F.bass === 'dub' && B && r.chance(0.5)) K = 'x...x...x...x...'; // steppers for the B
		d.K = K; d[F.snare] = snare;
		if (F.clap && r.chance(0.6)) d.C = snare;
		const hats = B && F.H.length > 1 ? F.H[1 + Math.floor(r() * (F.H.length - 1))] : F.H[0];
		d[F.hatLane || 'H'] = hatsWithAccents(r, hats);
		if (F.hatLane) d.T = r.pick(['.o.o.o.o.o.o.o.o', 'o.o.o.o.o.o.o.o.', 'o.ox.oxoo.ox.oxo']);
		if (F.ghost) d.G = laneOf(16, s => s % 2 === 1 && snare[s] === '.' && snare[(s + 1) % 16] !== 'x' && r.chance(F.ghost * (B ? 1.5 : 1)), 'o');
		const perc = r.pick(F.perc);
		if (!d[perc]) d[perc] = laneOf(32, s => s % 4 !== 0 && snare[s % snare.length] === '.' && r.chance(B ? 0.16 : 0.1), 'o');
		if (B && r.chance(0.5)) d.F = Z(30) + 'x.';
		return d;
	}
	// Chop kits: what each chop is good for, from its name and length (Boom/Snap/Tss come from the slicer, Word and Hook from speech)
	function chopRoles(k) {
		const pads = KITS[k].pads, bufs = buffers[k] || [], own = i => custom[k]?.[i];
		const roles = { low: [], snap: [], tick: [], word: [], hook: [] };
		for (let i = 0; i < CHORD; i++) {
			if (!own(i) && pads[i][3] !== 'u') continue; // a pad the kit underneath filled in
			const name = own(i)?.name || pads[i][0], len = (own(i)?.buffer || bufs[i])?.duration || 0;
			if (/^Hook/.test(name) || len > 1.2) roles.hook.push([i, len]);
			else if (/^Word/.test(name) || len > 0.35) roles.word.push([i, len]);
			else if (/^Boom/.test(name)) roles.low.push([i, len]);
			else if (/^Tss/.test(name)) roles.tick.push([i, len]);
			else roles.snap.push([i, len]);
		}
		return roles;
	}
	// Words and hooks: a chop only starts once the last one has rung out, so nothing is ever cut off mid-word
	function phraseLanes(r, roles, bpm, B) {
		const lanes = {}, s16 = 60 / bpm / 4, len = 64; // 4 bars, repeating
		const put = (i, s) => { const k = '#' + i; lanes[k] ||= Z(len).split(''); lanes[k][s] = 'x'; };
		let free = 0;
		for (let s = 0; s < len; s++) {
			if (s < free) continue;
			const hooks = roles.hook.filter(([, l]) => l / s16 < len - 2); // a hook longer than the 4 bars would cut itself off
			if (s === 0 && hooks.length) { const [i, l] = r.pick(hooks); put(i, s); free = s + Math.ceil(l / s16) + 2; continue; }
			const call = s % 32 < 16; // call and answer: words on the first bar of each two, a sparser reply on the second
			if (roles.word.length && s % 2 === 0 && r.chance(call ? (B ? 0.22 : 0.16) : 0.08)) { const [i, l] = r.pick(roles.word); put(i, s); free = s + Math.max(2, Math.ceil(l / s16)); }
		}
		for (const k in lanes) lanes[k] = lanes[k].join('');
		return lanes;
	}
	function chopPart(r, F, roles, bpm, B, isChop) {
		const d = {}, base = drumPart(r, F, B), by = a => [...a].sort((x, y) => x[1] - y[1]).map(x => x[0]);
		const low = by(roles.low), snap = by(roles.snap), tick = by(roles.tick);
		const kick = low[0] ?? snap[0], snare = snap.find(i => i !== kick) ?? low[1] ?? tick[1], hat = tick[0];
		const lane = (i, letter, l) => { if (i != null) d['#' + i] = l; else if (!isChop(SLOT[letter])) d[letter] = l; }; // no chop for it: the kit underneath, unless that pad is a chop too
		lane(kick, 'K', base.K); lane(snare, F.snare, base[F.snare]); lane(hat, 'H', base[F.hatLane || 'H']);
		const used = new Set([kick, snare, hat]), spare = [...low, ...snap, ...tick].filter(i => !used.has(i));
		for (const i of spare.sort(() => r() - 0.5).slice(0, B ? 3 : 2)) // the other hits answer in the gaps
			d['#' + i] = laneOf(32, s => s % 4 !== 0 && base[F.snare][s % base[F.snare].length] === '.' && r.chance(B ? 0.14 : 0.09), () => r.chance(0.5) ? 'x' : 'o');
		Object.assign(d, phraseLanes(r, roles, bpm, B));
		return { d, kick: base.K };
	}
	function generate(seed, k = kit) {
		const r = rng(seed), F = FEEL[KIT_FEEL[k === MIC ? micFill : k] || 'boom'];
		const bpm = Math.round(r.range(F.bpm)), swing = +r.range(F.swing).toFixed(2), chop = k === MIC || !!custom[k]?.some(Boolean);
		const roles = chop ? chopRoles(k) : null, isChop = i => !!custom[k]?.[i] || KITS[k].pads[i]?.[3] === 'u';
		const part = B => {
			const c = chop ? chopPart(r, F, roles, bpm, B, isChop) : null, d = c ? c.d : drumPart(r, F, B);
			return { d, prog: r.pick(PROGS), ch: r.pick(F.ch), bs: bassFor(r, F, c ? c.kick : d.K) };
		};
		const A = part(false), B = part(true);
		if (chop) A.ch = Z(16); // the chops lead Part A; the chords come in for B
		const p = { name: `${r.pick(GEN_NAMES[0])} ${r.pick(GEN_NAMES[1])}`, kit: k, bpm, swing, A, B, seed, gen: true };
		p.bars = { A: compile(A), B: compile(B) };
		if (chop) { // the crashes and fills compile() adds must not land on a word or the hook and cut it off
			const keep = new Set([...roles.word, ...roles.hook].map(x => x[0]));
			for (const [part, pt] of [['A', A], ['B', B]]) p.bars[part] = p.bars[part].map((ev, b) => ev.filter(([st, i]) => {
				const ln = pt.d['#' + i];
				return !keep.has(i) || (ln && 'xo'.includes(ln[(b * 16 + st) % ln.length]));
			}));
		}
		return p;
	}
	const gen = { list: [], at: -1, kept: [] }; // recent takes (seeds) and the ones kept
	const genBar = document.createElement('span');
	genBar.className = 'beats__gen';
	genBar.innerHTML = `<button class="track beats__dice" type="button" title="Generate a fresh Part A and B for this kit and play it">🎲</button>`
		+ `<button class="chip beats__gprev" type="button" aria-label="Previous take" title="The take before" hidden>◀</button>`
		+ `<button class="chip beats__gnext" type="button" aria-label="Next take" title="The take after" hidden>▶</button>`
		+ `<button class="chip beats__keep" type="button" title="Keep this take in the pattern list" hidden>Keep</button>`;
	beatGo.after(genBar);
	const genOpt = document.createElement('option');
	const [diceBtn, gPrev, gNext, keepBtn] = genBar.children;
	function genUi() {
		const cur = gen.list[gen.at];
		gPrev.hidden = gNext.hidden = keepBtn.hidden = !cur;
		if (!cur) return;
		gPrev.disabled = gen.at <= 0; gNext.disabled = gen.at >= gen.list.length - 1;
		keepBtn.disabled = gen.kept.some(g => g.seed === cur.seed);
		keepBtn.textContent = keepBtn.disabled ? '✓ Kept' : 'Keep';
	}
	async function genShow(i) {
		gen.at = i;
		const { seed, kit: k } = gen.list[i];
		if (k === MIC) await restoreMic();
		if (!KITS[k]) return;
		await renderKit(k);
		const p = generate(seed, k), at = PATTERNS.findIndex(x => x.gen && !x.kept);
		if (at >= 0) PATTERNS[at] = p; else PATTERNS.push(p);
		genOpt.value = PATTERNS.indexOf(p); genOpt.textContent = `🎲 ${KITS[k].name} · ${p.name} · ${p.bpm}`;
		if (!genOpt.parentNode) beatPick.prepend(genOpt);
		beatPick.value = genOpt.value;
		genUi();
		patPlay(p, partSel);
	}
	diceBtn.addEventListener('click', () => {
		gen.list = gen.list.slice(0, gen.at + 1);
		gen.list.push({ seed: (Math.random() * 2 ** 32) >>> 0, kit });
		if (gen.list.length > 12) gen.list.shift();
		genShow(gen.list.length - 1);
	});
	gPrev.addEventListener('click', () => gen.at > 0 && genShow(gen.at - 1));
	gNext.addEventListener('click', () => gen.at < gen.list.length - 1 && genShow(gen.at + 1));
	function keepTake(g) {
		const p = generate(g.seed, g.kit);
		p.kept = true; PATTERNS.push(p);
		beatPick.insertAdjacentHTML('beforeend', `<option value="${PATTERNS.length - 1}">⭐ ${KITS[g.kit].name} · ${p.name} · ${p.bpm}</option>`);
		return p;
	}
	keepBtn.addEventListener('click', () => {
		const g = gen.list[gen.at];
		if (!g || gen.kept.some(x => x.seed === g.seed)) return;
		gen.kept.push({ seed: g.seed, kit: g.kit });
		keepTake(g); store.put('genKept', gen.kept); genUi();
	});
	async function restoreKept() { // kept takes come back as patterns (chop kit takes once the mic kit is back)
		if (gen.restored) return;
		gen.restored = true;
		const list = await store.get('genKept');
		if (!Array.isArray(list)) return;
		for (const g of list) {
			if (g.kit === MIC) await restoreMic();
			if (!KITS[g.kit]) continue;
			if (g.kit === MIC || custom[g.kit]?.some(Boolean)) await renderKit(g.kit);
			gen.kept.push(g); keepTake(g);
		}
	}

	// ⇩ MIDI: a standard type-1 file at 96 ticks per beat: tempo, then drums on channel 10 (General MIDI notes), chords, bass
	const GM = [36, 38, 39, 42, 46, 51, 40, 37, 70, 63, 49, 56];
	function midiFile(p) {
		const PPQ = 96, T16 = PPQ / 4, harm = KITS[p.kit].harm, uspb = Math.round(60e6 / p.bpm);
		const vlq = n => { const b = [n & 127]; while ((n >>= 7)) b.unshift((n & 127) | 128); return b; };
		const meta = (type, bytes) => [0xff, type, bytes.length, ...bytes];
		const text = s => [...s].map(c => c.charCodeAt(0) & 127);
		const track = (name, evs) => { // evs: [tick, bytes]; at the same tick: meta first, then note-offs, then note-ons
			const rank = b => b[0] === 0xff ? 0 : (b[0] & 0xf0) === 0x80 ? 1 : 2;
			evs = [[0, meta(3, text(name))], ...evs].sort((a, b) => a[0] - b[0] || rank(a[1]) - rank(b[1]));
			const out = []; let last = 0;
			for (const [t, bytes] of evs) { out.push(...vlq(t - last), ...bytes); last = t; }
			out.push(0, 0xff, 0x2f, 0);
			return [0x4d, 0x54, 0x72, 0x6b, out.length >>> 24, (out.length >> 16) & 255, (out.length >> 8) & 255, out.length & 255, ...out];
		};
		const drums = [], chords = [], bass = [];
		const note = (arr, ch, n, t, len, v) => arr.push([t, [0x90 | ch, n, Math.max(1, Math.round(v * 120))]], [t + Math.max(1, len), [0x80 | ch, n, 0]]);
		['A', 'B'].forEach((part, pi) => p.bars[part].forEach((ev, b) => {
			const t0 = (pi * 32 + b) * 16 * T16;
			for (const [s, i, v] of ev) {
				const t = t0 + s * T16 + (s % 2 ? Math.round(p.swing * T16) : 0);
				if (i < CHORD) note(drums, 9, GM[i], t, T16, v);
				else if (i < BASS) {
					const nx = ev.find(e => e[0] > s && e[1] >= CHORD && e[1] < BASS);
					for (const n of harm[i - CHORD].notes) note(chords, 0, n, t, ((nx ? nx[0] : 16) - s) * T16 - 2, v);
				} else {
					const nx = ev.find(e => e[0] > s && e[1] >= BASS);
					note(bass, 1, harm[i - BASS].bass + 12, t, Math.min(8, (nx ? nx[0] : 16) - s) * T16 - 2, v);
				}
			}
		}));
		const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 4, 0, PPQ];
		const tempo = [[0, meta(0x51, [uspb >> 16, (uspb >> 8) & 255, uspb & 255])], [0, meta(0x58, [4, 2, 24, 8])]];
		return new Uint8Array([...head, ...track(`${p.name} ${p.bpm} BPM`, tempo), ...track('Drums', drums), ...track('Chords', chords), ...track('Bass', bass)]);
	}
	beatBar.querySelector('.beats__midi').addEventListener('click', () => {
		const p = PATTERNS[beatPick.value], a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([midiFile(p)], { type: 'audio/midi' }));
		a.download = `Nicky Dubs - ${p.name} (${p.bpm} BPM, A+B).mid`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	});

	// ── Mic kit: record anything (beatbox, claps, pots and pans) and every hit lands on its own pad ──
	// Hits and words are found by chopTake() (transients for the starts, gaps for the ends) and land on the 12 drum
	// pads: hits low to high (kick-like sounds first), then standout words, then the whole phrase as a Hook. The chords, the bass and any drum pads it can't fill keep the kit
	// you had on, so all 24 are always playable.
	// The kit is saved in this browser and shows up as the last kit in the list.
	const MIC = 'mic', MIC_MAX = 12; // seconds
	let micRec = null, micFill = 'soul', micRestored = false;
	const recBtn = document.createElement('button');
	recBtn.type = 'button'; recBtn.className = 'track beats__rec'; recBtn.textContent = '● Rec kit';
	recBtn.title = 'Record hits from your mic (beatbox, claps, anything); each one gets its own pad';
	beatBar.append(recBtn);
	recBtn.addEventListener('click', () => micRec ? micRec.stop() : micStart());
	// Raw samples straight off the mic: nothing to encode or decode, works the same on every phone.
	// → { secs(), stop() → AudioBuffer, or null when it was too short }, or null when the mic is blocked
	async function micOpen(max) {
		const c = audio();
		if (c.state === 'suspended') c.resume();
		let stream;
		try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
		catch { alert('Could not open your microphone. Check the browser permission for this site.'); return null; }
		const src = c.createMediaStreamSource(stream), tap = c.createScriptProcessor(4096, 1, 1), mute = c.createGain();
		const parts = [], t0 = performance.now();
		let got = 0;
		mute.gain.value = 0; // the tap has to reach the speakers to keep running; silent so you never hear yourself
		tap.onaudioprocess = e => { if (got < c.sampleRate * max) { const d = e.inputBuffer.getChannelData(0); parts.push(new Float32Array(d)); got += d.length; } };
		chain(src, tap, mute, c.destination);
		return {
			secs: () => (performance.now() - t0) / 1000,
			stop() {
				src.disconnect(); tap.disconnect(); stream.getTracks().forEach(t => t.stop());
				if (got < c.sampleRate * 0.1) return null;
				const rec = c.createBuffer(1, got, c.sampleRate);
				let at = 0; for (const d of parts) { rec.copyToChannel(d, 0, at); at += d.length; }
				return rec;
			},
		};
	}
	async function micStart() {
		const m = await micOpen(MIC_MAX);
		if (!m) return;
		const tick = setInterval(() => {
			const sec = m.secs();
			recBtn.textContent = `■ Stop ${sec.toFixed(1)}s`;
			if (sec >= MIC_MAX) micRec.stop();
		}, 100);
		micRec = { stop: async () => {
			if (!micRec) return;
			clearInterval(tick); micRec = null;
			const rec = m.stop();
			recBtn.classList.remove('is-rec'); recBtn.textContent = 'Cutting…';
			let msg = '● Rec kit';
			try {
				if (!rec) throw new Error('too short');
				const n = await micKit(rec);
				if (n) msg = `✓ ${n} hit${n > 1 ? 's' : ''} on pads`;
			} catch (e) { console.warn(e); alert('Could not use that recording. Try again, a little longer.'); }
			recBtn.textContent = msg;
			setTimeout(() => { if (!micRec) recBtn.textContent = '● Rec kit'; }, 2500);
		} };
		recBtn.classList.add('is-rec'); recBtn.textContent = '■ Stop 0.0s';
	}

	// ── Pad modes, under the patterns: Play, Rec Pads, Vol, Send ──
	const MODES = [['play', 'Play', 'Tap a pad to play it'], ['rec', 'Rec Pads', 'Tap a pad to record your mic into it, tap again to stop (8 seconds at most). A take with several sounds can then be chopped across the pads.'],
		['vol', 'Vol', 'Drag a pad up or down to set its volume'], ['send', 'Send', 'Drag a pad up or down to set how much of it goes to the echo, the room and the crush']];
	modeBar = document.createElement('div');
	modeBar.className = 'padmodes'; modeBar.setAttribute('role', 'group'); modeBar.setAttribute('aria-label', 'What a pad tap does');
	modeBar.innerHTML = MODES.map(([id, lab, tip]) => `<button type="button" class="chip padmodes__b" data-pm="${id}" aria-pressed="${id === padMode}" title="${tip}">${lab}</button>`).join('')
		+ `<button type="button" class="chip padmodes__chop" hidden title="Spread the last take across the pads: each hit or word on its own pad, the whole phrase as a Hook">✂ Chop</button>`;
	grid.before(modeBar);
	const chopBtn = modeBar.querySelector('.padmodes__chop');
	let lastTake = null; // { rec, i, kit }: the last Rec Pads take, while it can still be chopped
	function setPadMode(id) {
		if (padRec) padRecTap(padRec.i); // leaving Rec Pads finishes a take that is still running
		padMode = id;
		modeBar.querySelectorAll('[data-pm]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pm === id)));
		grid.dataset.pm = id;
		showVals();
	}
	modeBar.addEventListener('click', e => { const b = e.target.closest('[data-pm]'); if (b) setPadMode(b.dataset.pm); });
	chopBtn.addEventListener('click', () => { // the chops go onto the drum pads, from the one you recorded into: hits, then words, then the hook
		const t = lastTake; chopBtn.hidden = true; lastTake = null;
		if (!t) return;
		const chops = chopTake(t.rec).sort((a, b) => (a.name === 'Hook') - (b.name === 'Hook'));
		const start = t.i < CHORD ? t.i : 0;
		chops.slice(0, CHORD - start).forEach((c, k) => {
			const b = ac.createBuffer(1, c.data.length, t.rec.sampleRate); b.copyToChannel(c.data, 0);
			custom[t.kit][start + k] = { buffer: b, name: c.name }; levelTrim(b);
			setTimeout(() => flash(start + k, 300), k * 60);
		});
		label();
	});
	grid.dataset.pm = padMode;
	// Rec Pads: the mic goes straight into one pad (this kit, this visit), trimmed and brought up to a playable level
	const PAD_REC_MAX = 8;
	let padRec = null;
	async function padRecTap(i) {
		if (padRec) { const r = padRec; padRec = null; r.end(); return; }
		padRec = { i, end: () => {} }; // claimed at once, so a second tap while the mic opens cannot start another take
		const m = await micOpen(PAD_REC_MAX);
		if (!m) { padRec = null; return; }
		els[i].classList.add('is-rec');
		const auto = setInterval(() => { if (m.secs() >= PAD_REC_MAX && padRec?.i === i) padRecTap(i); }, 100);
		const end = () => {
			clearInterval(auto); els[i].classList.remove('is-rec');
			const rec = m.stop();
			if (!rec) return;
			const buffer = tighten(rec); // from just before the first transient, silence trimmed, peak at 0.9
			custom[kit][i] = { buffer, name: 'Rec ' + KEY_LABELS[i] };
			levelTrim(buffer); label(); hit(i);
			const many = rec.duration > 0.8 && piecesOf(monoOf(rec), rec.sampleRate).pieces.length > 1;
			lastTake = many ? { rec, i, kit } : null; chopBtn.hidden = !many;
		};
		if (padRec) padRec.end = end; else end(); // the take was stopped while the mic was still opening
	}
	// ── Chopping a recording: transients for where a chop starts, silences for where it may end ──
	// Every 5 ms we measure the loudness and the "edge" (energy of the sample-to-sample difference, which jumps on clicks,
	// consonants and stick hits before the body of a sound arrives). An onset is a sharp rise in either, at least 80 ms
	// after the last; its start is walked back to where the rise began and set 3 ms earlier, so the attack is kept.
	// Chops only ever end in a gap: sound is grouped into runs that stay above the floor (dips under 70 ms are inside a
	// word), and a run is only split at an onset when the sound before it fell well away (a hit's tail, not a syllable).
	// So a word is never cut in half, a phrase can run whole as a Hook, and beatbox hits still come apart.
	function analyseTake(x, sr) {
		const hop = Math.round(sr * 0.005), F = Math.floor(x.length / hop), db = new Float32Array(F), eb = new Float32Array(F);
		let top = -120;
		for (let f = 0; f < F; f++) {
			let e = 0, h = 0;
			for (let i = f * hop, j = Math.min(x.length, i + 2 * hop); i < j; i++) { e += x[i] * x[i]; const d = x[i] - (i ? x[i - 1] : 0); h += d * d; }
			db[f] = 10 * Math.log10(e / (2 * hop) + 1e-12); eb[f] = 10 * Math.log10(h / (2 * hop) + 1e-12); top = Math.max(top, db[f]);
		}
		const sorted = Float32Array.from(db).sort(), floor = sorted[Math.floor(F * 0.1)] || -120;
		const thr = Math.max(top - 38, floor + 9);
		const rise = f => { let a = 0, b = 0; for (let k = 1; k <= 6; k++) { a += db[f - k]; b += eb[f - k]; } return Math.max(db[f] - a / 6, eb[f] - b / 6); };
		const onsets = [];
		for (let f = 6, last = -99; f < F - 1; f++) {
			if (db[f] < top - 32 || db[f] < thr || f - last < 16) continue;
			const r = rise(f);
			if (r < 9 || r < rise(f + 1)) continue; // the steepest frame of the rise
			let st = f; while (st > f - 6 && st > 0 && db[st - 1] < db[st] - 0.5) st--;
			onsets.push(st); last = f;
		}
		const runs = []; // stretches above the floor, with short dips merged in
		for (let f = 0, a = -1, quiet = 0; f <= F; f++) {
			const on = f < F && db[f] >= thr;
			if (on) { if (a < 0) a = f; quiet = 0; }
			else if (a >= 0 && (++quiet > 14 || f === F)) { runs.push([a, f - quiet + 1]); a = -1; quiet = 0; }
		}
		return { hop, F, db, top, thr, onsets, runs };
	}
	// → pieces [{ a, b } in samples, start just before the transient, end in the gap], in time order
	function piecesOf(x, sr) {
		const A = analyseTake(x, sr), { hop, db, onsets, runs } = A, pre = Math.round(sr * 0.003), out = [];
		const refine = s => { // a frame only says "in these 10 ms": find the first sample that is really part of the attack
			const end = Math.min(x.length, s + Math.round(sr * 0.025));
			let pk = 0; for (let i = s; i < end; i++) pk = Math.max(pk, Math.abs(x[i]));
			let fl = 0; for (let i = Math.max(0, s - hop * 2); i < s; i++) fl = Math.max(fl, Math.abs(x[i]));
			const th = Math.max(pk * 0.1, fl * 2);
			for (let i = s, j = Math.min(x.length, s + hop * 3); i < j; i++) if (Math.abs(x[i]) > th) return Math.max(0, i - pre);
			return Math.max(0, s - pre);
		};
		for (const [ra, rb] of runs) {
			let peak = -120; for (let f = ra; f < rb; f++) peak = Math.max(peak, db[f]);
			if (rb - ra < 6 && peak < A.top - 20) continue; // a blip
			const cuts = [ra];
			for (const o of onsets) {
				if (o <= ra + 8 || o >= rb - 4) continue;
				let dip = 0; for (let f = Math.max(ra, o - 6); f < o; f++) dip = Math.min(dip, db[f] - peak);
				if (dip < -15) cuts.push(o); // the sound before had died away: a new hit, not the next syllable
			}
			const first = onsets.find(o => o >= ra - 4 && o <= ra + 8);
			if (first !== undefined) cuts[0] = Math.min(cuts[0], first);
			cuts.push(rb);
			for (let k = 0; k < cuts.length - 1; k++) {
				const a = refine(cuts[k] * hop), b = Math.min(x.length, k === cuts.length - 2 ? cuts[k + 1] * hop + hop * 4 : refine(cuts[k + 1] * hop));
				if (b - a > sr * 0.03) out.push({ a, b });
			}
		}
		return { pieces: out, A };
	}
	function chopData(x, a, b, sr) { // copy, 1 ms fade in, 5 ms fade out, peak at 0.9
		const d = x.slice(a, b), fi = Math.round(sr * 0.001), fo = Math.min(Math.round(sr * 0.005), d.length >> 2);
		let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v));
		if (pk < 1e-4) return null;
		for (let i = 0; i < fi; i++) d[i] *= i / fi;
		for (let i = 0; i < fo; i++) d[d.length - 1 - i] *= i / fo;
		for (let i = 0; i < d.length; i++) d[i] *= 0.9 / pk;
		return d;
	}
	function monoOf(buf) {
		const n = buf.length, x = new Float32Array(n);
		for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < n; i++) x[i] += d[i] / buf.numberOfChannels; }
		return x;
	}
	function colourOf(d, sr) { // zero crossings and the share of energy under ~150 Hz, over the first 80 ms
		let zc = 0, lo = 0, lp = 0, all = 0; const L = Math.min(d.length, Math.round(sr * 0.08)), a = 1 - Math.exp(-2 * Math.PI * 150 / sr);
		for (let i = 1; i < L; i++) { if ((d[i] >= 0) !== (d[i - 1] >= 0)) zc++; lp += a * (d[i] - lp); lo += lp * lp; all += d[i] * d[i]; }
		return { zcr: zc / (L / sr), low: lo / (all || 1) };
	}
	// A whole take → up to 12 { data, name }: hits low to high first, then standout words, then the hook (the longest phrase, whole)
	function chopTake(buf) {
		const sr = buf.sampleRate, x = monoOf(buf), { pieces, A } = piecesOf(x, sr);
		const hits = [], words = [], lens = pieces.map(p => (p.b - p.a) / sr).sort((a, b) => a - b);
		const wordLen = lens.length && lens[lens.length >> 1] > 0.3 ? 0.15 : 0.35; // a take that is mostly talk: short words are words, not hits
		for (const p of pieces) {
			const len = (p.b - p.a) / sr, d = chopData(x, p.a, p.b, sr);
			if (!d) continue;
			let pk = -120; for (let f = Math.floor(p.a / A.hop); f < Math.min(A.F, p.b / A.hop); f++) pk = Math.max(pk, A.db[f]);
			const item = { data: d, len, loud: pk, ...colourOf(d, sr), at: p.a };
			(len < wordLen ? hits : words).push(item);
		}
		let hook = null; // the longest run of words with gaps under 300 ms between them
		if (words.length >= 2) {
			let best = null;
			for (let i = 0; i < pieces.length; i++) {
				let j = i; while (j + 1 < pieces.length && (pieces[j + 1].a - pieces[j].b) / sr < 0.3) j++;
				const len = (pieces[j].b - pieces[i].a) / sr;
				if (j > i && (!best || len > best.len) && len <= MIC_MAX) best = { a: pieces[i].a, b: pieces[j].b, len };
				i = j;
			}
			if (best) { const d = chopData(x, best.a, best.b, sr); if (d) hook = { data: d, name: 'Hook' }; }
		}
		if (!hook) { const long = words.filter(w => w.len > 1.2).sort((a, b) => b.len - a.len)[0]; if (long) hook = { data: long.data, name: 'Hook' }; } // one long phrase on its own
		const wordsCut = words.filter(w => w.len <= 1.2).sort((a, b) => b.loud - a.loud).slice(0, CHORD - (hook ? 1 : 0) - Math.min(hits.length, 6)).sort((a, b) => a.at - b.at);
		const room = CHORD - wordsCut.length - (hook ? 1 : 0);
		const best = hits.sort((a, b) => b.loud - a.loud).slice(0, room).sort((a, b) => a.zcr - b.zcr);
		const count = {}, name = w => { count[w] = (count[w] || 0) + 1; return `${w} ${count[w]}`; };
		return [...best.map(h => ({ data: h.data, name: name(h.low > 0.3 ? 'Boom' : h.len < 0.1 ? 'Tss' : 'Snap') })),
			...wordsCut.map(w => ({ data: w.data, name: name('Word') })), ...(hook ? [hook] : [])];
	}
	// One pad's take, tightened: from just before its first transient to the end of its last sound, 5 ms fade out
	function tighten(buf) {
		const sr = buf.sampleRate, x = monoOf(buf), { pieces } = piecesOf(x, sr);
		if (!pieces.length) return trim(buf);
		const d = chopData(x, pieces[0].a, pieces.at(-1).b, sr);
		if (!d) return trim(buf);
		const out = ac.createBuffer(1, d.length, sr); out.copyToChannel(d, 0);
		return out;
	}
	async function buildMicKit(hits, sr, fill) {
		if (!KITS[fill] || fill === MIC) fill = 'soul';
		await renderKit(fill);
		const pads = [], bufs = [];
		for (let i = 0; i < PADS; i++) {
			if (i < hits.length) {
				const b = ac.createBuffer(1, hits[i].data.length, sr); b.copyToChannel(hits[i].data, 0);
				pads.push([hits[i].name, null, 0, 'u']); bufs.push(b);
			} else { pads.push(KITS[fill].pads[i]); bufs.push(buffers[fill][i]); } // the rest of the kit you had on
		}
		KITS[MIC] = { name: '🎙 My mic kit', dusty: false, harm: KITS[fill].harm, pads };
		bufs.forEach(levelTrim); buffers[MIC] = bufs; renders[MIC] = Promise.resolve(); custom[MIC] ||= []; micFill = fill;
		if (!KIT_ORDER.includes(MIC)) { KIT_ORDER.push(MIC); kitSel?.insertAdjacentHTML('beforeend', `<option value="${MIC}">${KITS[MIC].name}</option>`); }
	}
	async function micKit(rec) {
		const hits = chopTake(rec);
		if (!hits.length) { alert('No hits found. Try claps, beatbox or taps, a little closer to the mic.'); return 0; }
		await buildMicKit(hits, rec.sampleRate, kit === MIC ? micFill : kit);
		store.put('micKit', { sr: rec.sampleRate, fill: micFill, hits });
		kit = MIC; setMode('pads');
		hits.forEach((h, i) => setTimeout(() => flash(i, 300), i * 60));
		return hits.length;
	}
	async function restoreMic() { // the last mic kit, saved in this browser
		if (micRestored) return; micRestored = true;
		const v = await store.get('micKit');
		if (v?.hits?.length) await buildMicKit(v.hits.slice(0, CHORD), v.sr, v.fill); // older saves held up to 16
	}

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
			levelTrim(buffer);
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
		const LKEYS = ['Digit7', 'Digit8', 'Digit9', 'Digit0', 'KeyU', 'KeyI', 'KeyO', 'KeyP'], LLAB = ['7', '8', '9', '0', 'U', 'I', 'O', 'P'];
		const REPS = [['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125]];
		const opt = { loop: true, count: true, rev: false, mic: false, rep: 1 };
		const S = LLAB.map(() => ({ state: 'empty', buf: null, rbuf: null, anchor: 0, src: null, g: null, playAt: 0, off: 0 }));
		let recSlot = -1, pending = null, delMode = false, micSrc = null, scratch = null, repeats = [];
		const spb = () => 60 / tempo;

		box.innerHTML = `<div class="loops__slots"></div><div class="loops__bar more-only">
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
		// The recorder only exists while a loop is recording: made at the tap, unplugged and dropped once it is done
		function retire(node) {
			try { recTap.disconnect(node); } catch {}
			try { micSrc?.disconnect(node); } catch {}
			node.disconnect();
			if (recNode === node) recNode = null;
		}
		function cancelRec() { if (recNode) { recNode.port.postMessage({ cancel: true }); retire(recNode); } }
		// You play to what you hear, and you hear the click late by the output latency, so whatever you play lands that
		// late on the audio clock. The recording window shifts by the same amount (the mic adds a little of its own),
		// so the loop sits on the grid instead of dragging behind it.
		const recLag = () => (ac.baseLatency || 0) + (ac.outputLatency || 0) + (opt.mic ? 0.01 : 0);
		async function record(i) {
			audio(); if (ac.state === 'suspended') await ac.resume();
			try { await workletReady; } catch { alert('Recording needs a newer browser (AudioWorklet).'); return; }
			if (opt.mic && !(await ensureMic())) return;
			if (recNode) cancelRec();
			const node = recNode = new AudioWorkletNode(ac, 'nd-rec', { outputChannelCount: [1] });
			const sink = ac.createGain(); sink.gain.value = 0; // keeps the recorder running without making sound
			chain(node, sink, ac.destination);
			let got = { L: [], R: [] }; // the recorder sends the audio in batches; join them once it says done
			node.port.onmessage = ({ data: m }) => {
				got.L.push(...m.L); got.R.push(...m.R);
				if (!m.done) return;
				retire(node); sink.disconnect();
				const join = parts => { const out = new Float32Array(parts.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of parts) { out.set(a, o); o += a.length; } return out; };
				const L = join(got.L), R = join(got.R); got = { L: [], R: [] };
				onRecorded({ L, R });
			};
			route();
			let at;
			if (opt.count) {
				await metro.start();
				at = metro.nextBeat(ac.currentTime + spb() * 3, true); // at least 3 clicks, then the next bar line
			} else at = ac.currentTime + 0.01;
			Object.assign(S[i], { state: 'armed', startAt: at });
			recSlot = i; kick();
			node.port.postMessage({ start: at + recLag() });
			setTimeout(() => { if (recSlot === i) window.wiggler?.hit('h', 1); }, Math.max(0, (at - ac.currentTime) * 1000));
		}
		function stopRec(i) {
			const s = S[i], t = ac.currentTime;
			if (t < s.startAt) { cancelRec(); s.state = 'empty'; recSlot = -1; return; } // still counting in
			let end = t;
			if (opt.count && metro.running) end = s.startAt + Math.max(1, Math.round((t - s.startAt) / spb())) * spb();
			pending = { i, len: Math.round((end - s.startAt) * ac.sampleRate), end };
			s.state = 'finishing';
			recNode?.port.postMessage({ stop: Math.max(end + recLag(), t) });
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
			kick();
			(window.requestIdleCallback || setTimeout)(persist, { timeout: 4000 }); // saving copies the audio: do it when the page is idle
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
			if (recSlot === i) { cancelRec(); recSlot = -1; pending = null; }
			stopVoice(s);
			const had = !!s.buf;
			Object.assign(s, { state: 'empty', buf: null, rbuf: null });
			if (had) persist();
			slotEls[i].animate([{ filter: 'brightness(2.5)' }, { filter: 'none' }], { duration: 250 });
		}
		function tap(i) {
			audio();
			setTimeout(kick); // after this tap has changed the slot
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
		// Each slot only touches the page when something it shows has changed, the progress ring moves about 20 times
		// a second, and the loop stops itself when no slot is busy (kick() restarts it), so idle loops cost nothing.
		let raf = 0, lastP = 0;
		const shown = slotEls.map(() => ({ s: '', txt: '' }));
		const kick = () => { if (!raf && rig.open) raf = requestAnimationFrame(ui); };
		function ui(now) {
			raf = 0;
			if (!ac || !rig.open) return;
			const t = ac.currentTime, ring = now - lastP > (NDAudio.prefs.lite ? 100 : 50); // the ring: about 20 updates a second, 10 in Lite
			if (ring) lastP = now;
			let busy = false;
			S.forEach((s, i) => {
				const el = slotEls[i], seen = shown[i];
				if (s.state === 'armed' && t >= s.startAt) s.state = 'recording';
				let txt = '';
				if (s.state === 'armed') txt = String(Math.ceil((s.startAt - t) / spb()));
				else if (s.state === 'recording') txt = opt.count && metro.running ? String(Math.floor((t - s.startAt) / spb()) + 1) : (t - s.startAt).toFixed(1);
				else if (s.state === 'finishing') txt = '…';
				else if (s.state === 'playing' && ring) {
					const d = s.buf.duration, ph = ((s.off + Math.max(0, t - s.playAt)) % d) / d;
					el.style.setProperty('--p', (opt.rev ? 1 - ph : ph).toFixed(3));
				}
				if (seen.s !== s.state) { el.dataset.s = seen.s = s.state; }
				if (seen.txt !== txt) { el.firstChild.nextSibling.textContent = seen.txt = txt; }
				if (s.state !== 'empty' && s.state !== 'stopped') busy = true;
			});
			if (busy) raf = requestAnimationFrame(ui);
		}
		addEventListener('keydown', e => {
			if (!rig.open || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
			if (mode === 'synth' && e.code.startsWith('Key')) return; // U-P belong to the piano in synth mode
			const i = LKEYS.indexOf(e.code);
			if (i < 0) return;
			e.preventDefault(); tap(i);
		});
		return {
			wake() { materialize(); kick(); },
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
			if (!eng) { audio(); eng = PS.createEngine(ac, synthBus); eng.load(SP); }
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
		const rows = () => lane === 'synth' ? 85 : PADS;             // synth lane: MIDI 24 (C1) to 108 (C8)
		const rowOf = n => lane === 'synth' ? 108 - n : n;
		const noteOfRow = r => lane === 'synth' ? 108 - r : r;
		const rh = () => lane === 'synth' ? RH : Math.max(RH, (H - RUL) / PADS);
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
			else playPad(nt.k, nt.n, t, nt.v, seqBus);
		}
		hooks.push(() => { if (playing) { const now = ac.currentTime; anchorBeat = beatAt(now); anchorTime = now; schedTo = Math.min(schedTo, beatAt(now)); } rspb = 60 / tempo; });
		let lastFrame = 0;
		function loop(now = 0) {
			if (!playing) { raf = 0; return; }
			cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); // one chain only, however often it is kicked
			if (box.hidden || document.hidden || now - lastFrame < (NDAudio.prefs.lite ? 66 : 33)) return; // 30 frames a second is plenty, 15 in Lite
			lastFrame = now;
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
			if (cmd === 0x90 && d2 > 0) drums ? hit(((d1 - 36) % PADS + PADS) % PADS) : synthUi?.noteOn(d1, d2 / 127);
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
	let synMounted = false;
	const bot = pad.querySelector('.bot');
	if (bot && window.wiggler) wiggler.mount(bot);
	document.querySelectorAll('.rig-open').forEach(b => b.addEventListener('click', () => {
		rig.showModal();
		const c = audio();
		if (c.state === 'suspended') c.resume();
		renderAll(); restoreMic().then(restoreKept);
		if (window.NDSyn && !synMounted) { // the colours read the kit after the DJ filter
			synMounted = true;
			const an = c.createAnalyser(); an.fftSize = 256; lpF.connect(an);
			NDSyn.mount(pad, { analyser: an });
			NDSyn.toggleButton(pad.querySelector('.pad__tools'));
		}
		if (view === 'stage') window.wiggler?.start();
		loops?.wake();
		setTimeout(showLatency, 400); // outputLatency is only known once audio is actually flowing
	}));
	try { if (sessionStorage.getItem('bp-reopen')) { sessionStorage.removeItem('bp-reopen'); document.querySelector('.rig-open')?.click(); } } catch {} // back from a Safe/Tight switch
	rig.querySelector('.rig__close').addEventListener('click', () => rig.close());
	rig.querySelector('.pad__fx')?.addEventListener('click', e => { // More: everything not needed to play folds away, so the pads get the room
		const on = rig.classList.toggle('show-more'); e.currentTarget.setAttribute('aria-pressed', String(on));
	});
	rig.addEventListener('click', e => { if (e.target === rig) rig.close(); }); // tap the backdrop to close
	rig.addEventListener('close', () => { beatStop(); window.wiggler?.stop(); roll?.stop(); metro.stop(); loops?.sleep(); synthUi?.panic(); commit(); saveAll(); });

	window.BEATPAD = { generate, chopTake, piecesOf, midiFile, compile, PATTERNS, KITS, FXP, flav, ctl, buffers, custom, pat, gen, get kit() { return kit; }, set kit(k) { kit = k; label(); } }; // for tests and the curious

	// Keyboard: 1-4 / Q-R / A-F / Z-V, but only while the popup is open.
	addEventListener('keydown', e => {
		if (!rig.open || mode !== 'pads' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
		const i = KEYS.indexOf(e.code);
		if (i < 0) return;
		e.preventDefault();
		hit(i);
	});
})();
