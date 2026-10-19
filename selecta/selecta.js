// Robo-Selecta: an endless DJ set that writes its own tracks as it plays them.
// Every track is generated from a genre profile (tech house, UK garage, dubstep, halftime reggae, liquid, jungle),
// arranged in 32-bar chunks (intro, breakdown + build, drop + switch-up, outro) so one energy cycle lasts about
// 90-120 s, then mixed into the next track like a DJ would: harmonic key moves on the Camelot wheel (same key,
// one step round, or relative major/minor), a 32-bar blend with a bass swap halfway when the tempos are close, or
// an echo-out and a clean cut on the 1 when they are not. Inside each track, phrases are call and response
// between two opposite ideas (low vs high, straight vs triplet, sweet vs sour...), shown on screen as it plays.
// Plain Web Audio: drums are rendered once per genre, everything else is synthesized note by note.
(() => {
	'use strict';
	const $ = s => document.querySelector(s);
	const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
	const hz = n => 440 * 2 ** ((n - 69) / 12);
	const NN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
	function rng(seed) { // mulberry32: every track is reproducible from its seed
		let a = seed >>> 0;
		const r = () => { a = a + 0x6d2b79f5 >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
		r.pick = arr => arr[Math.floor(r() * arr.length)];
		r.chance = p => r() < p;
		return r;
	}

	// ── Controls (saved in this browser) ──
	const FADERS = [
		['energy', 'Energy', 0.6, 'How hard the set pushes: busier drums, longer drops, more switch-ups'],
		['tension', 'Tension', 0.5, 'How sour the switch-up gets: tritones, flat nines, faster wobbles'],
		['bliss', 'Bliss', 0.6, 'Richer chords (9ths), more pads and reverb in the breakdowns'],
		['triplet', 'Triplets', 0.35, 'How often phrases answer in triplet feel against the straight beat'],
		['wander', 'Wander', 0.5, 'Stay in one genre (left) or travel between them (right)'],
		['cycle', 'Cycle', 0.5, 'Length of one breakdown-build-drop cycle: 90 s (left) to 120 s (right)'],
	];
	const GENRES = {
		tech: { name: 'Tech House', bpm: [124, 128], energy: 0.7, minor: 0.75, swing: 0.06, stretch: 1,
			bass: 'pluck', chord: 'stab', lead: ['vox', 'pluckL'], pad: 'pad', prog: 'one',
			d: { K: ['x...x...x...x...'], C: ['....x.......x...'], O: ['..x...x...x...x.'], H: ['oxoooxoooxoooxoo', '.o.o.o.o.o.o.o.o'],
				T: ['o.oxo.oxo.oxo.ox', '.oxo.oxo.oxo.oxo'], P: ['...x..x....x..x.', '..x..x....x..x..', '.x....x..x...x..'], R: ['..x...x...x...x.'] },
			bassT: ['..rr..rr..rr..rr', '.rrr.rrr.rrr.rrr', '..r.r.r...r.r.r.', 'r..r..r...r..r..'], chordT: ['...x......x.....', Z(14) + 'x.', '..x.....x.....x.'] },
		ukg: { name: 'UK Garage', bpm: [130, 134], energy: 0.55, minor: 0.8, swing: 0.22, stretch: 1,
			bass: 'warp', chord: 'organ', lead: ['vox', 'bell'], pad: 'pad', prog: 'move',
			d: { K: ['x.........x.....x......x..x.....', 'x.........x.....x.........x.....'], S: ['....x.......x...'], H: ['..x...x...x...x.'],
				G: ['.......o.o.....o', '...o...o.o......'], T: ['o.o.o.o.o.o.o.o.'], R: ['..x...x...x...x.'] },
			bassT: ['R.........r.....R......r..r.....', 'R..r......R..r..R......r..r..r..'], chordT: ['...x..x....x....', '...x..x.........' + '...x..x....x....'] },
		dubstep: { name: 'Dubstep', bpm: [140, 140], energy: 0.9, minor: 0.95, swing: 0, stretch: 1,
			bass: 'wobble', chord: 'stab', lead: ['bell', 'vox'], pad: 'pad', prog: 'dark',
			d: { K: ['x.........x.....x......x..x.....', 'x...............x.........x.....'], S: ['........x.......'], H: ['x.x.x.x.x.x.x.x.', 'x.o.x.o.x.o.x.o.'],
				O: [Z(30) + 'x.'], C: ['........x.......'], R: ['x...x...x...x...'] },
			bassT: ['R.......R...R...', 'R.....R.R...R.r.', 'R...R...R.R.R...'], chordT: ['x' + Z(31), '......x.........'] },
		half: { name: 'Halftime Reggae', bpm: [168, 172], energy: 0.45, minor: 0.85, swing: 0.16, stretch: 2, // written at half speed, played on the 170 grid
			bass: 'b808', chord: 'skank', lead: ['bell', 'vox'], pad: 'rhodes', prog: 'move',
			d: { K: ['x......x..x.....', 'x.....x...x..x..'], S: ['....x.......x...'], H: ['x.x.x.x.x.x.x.x.', 'x.xxx.x.x.xxx.x.'], M: ['.......o......o.'], T: ['....x.......x...'] },
			bassT: ['R.....r.R.......', 'R...r...R..r....', 'R.....R...r.r...'], chordT: ['..x...x...x...x.'] },
		liquid: { name: 'Liquid DnB', bpm: [172, 176], energy: 0.5, minor: 0.7, swing: 0, stretch: 1,
			bass: 'sub', chord: 'rhodes', lead: ['vox', 'bell'], pad: 'pad', prog: 'lush',
			d: { K: ['x.........x.....', 'x.........x.....x.........x..x..'], S: ['....x.......x...'], G: ['.......o......o.', '..o....o..o...o.'],
				H: ['..x...x...x...x.'], T: ['o.o.o.o.o.o.o.o.'], R: ['x.x.x.x.x.x.x.x.'] },
			bassT: ['R.........R.....', 'R.....r...R.....', 'R.........R...r.'], chordT: ['x' + Z(31), 'x.......' + Z(8)] },
		jungle: { name: 'Jungle', bpm: [166, 170], energy: 0.85, minor: 0.9, swing: 0, stretch: 1,
			bass: 'reese', chord: 'pad', lead: ['stabL', 'vox'], pad: 'pad', prog: 'dark',
			d: { K: ['x.x.......xx......xx......x.....', 'x.........xx....x.x.......x.....'], S: ['....x..o.o..x..o.o..x..o.o....x.', '....x..o.o.ox..o.o..x..oxo..x.ox'],
				H: ['x.x.x.x.x.x.x.x.'], R: ['..x...x...x...x.', 'x.x.x.x.x.x.x.x.'] },
			bassT: ['R.........r.....R...............', 'R.....r...R.....R.........r.....'], chordT: ['x' + Z(31)] },
	};
	function Z(n) { return '.'.repeat(n); }
	const ORDER = ['tech', 'ukg', 'dubstep', 'half', 'liquid', 'jungle'];
	const PROGS = { // scale degrees, natural minor (0 i, 2 III, 3 iv, 4 v, 5 VI, 6 VII) or major
		minor: { one: [[0], [0, 0, 3, 3], [0, 0, 0, 6]], move: [[0, 5, 2, 6], [0, 3, 5, 4], [5, 6, 0, 0], [0, 6, 5, 6]], dark: [[0, 0, 5, 6], [0, 3, 0, 4], [0, 5, 3, 4]], lush: [[0, 5, 2, 6], [5, 6, 2, 0], [3, 4, 2, 5], [0, 2, 5, 6]] },
		major: { one: [[0], [0, 0, 3, 3]], move: [[0, 4, 5, 3], [5, 3, 0, 4], [1, 4, 0, 5]], dark: [[5, 3, 0, 4], [1, 4, 0, 0]], lush: [[0, 5, 3, 4], [3, 4, 2, 5], [1, 4, 0, 5]] },
	};
	const SCALE = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] };
	const DIPOLES = [
		['low', 'high', 'Low vs high'], ['straight', 'triplet', 'Straight vs triplet'], ['sparse', 'busy', 'Sparse vs busy'],
		['sweet', 'sour', 'Harmony vs dissonance'], ['short', 'long', 'Short vs long'], ['dry', 'wet', 'Dry vs wet'],
		['minor', 'major', 'Minor weight vs major lift'], ['then', 'now', 'Nostalgia vs now'], ['lead', 'bass', 'Lead vs bass'],
	];
	const WORDS = [['Neon', 'Basement', 'Velvet', 'Rubber', 'Cosmic', 'Wobbly', 'Midnight', 'Dusty', 'Liquid', 'Golden', 'Feral', 'Sunday', 'Heavy', 'Paper', 'Glass', 'Prairie', 'River', 'Static', 'Moss', 'Laser', 'Honey', 'Thunder', 'Pocket', 'Rattle'],
		['Kettle', 'Weather', 'Pilgrim', 'Engine', 'Lantern', 'Orchard', 'Signal', 'Shuffle', 'Garden', 'Ladder', 'Machine', 'Comet', 'Bounce', 'Riddim', 'Swamp', 'Parade', 'Mirage', 'Wiggle', 'Forest', 'Roller', 'Satellite', 'Puddle', 'Tunnel', 'Harbour']];

	const S = { energy: 0.6, tension: 0.5, bliss: 0.6, triplet: 0.35, wander: 0.5, cycle: 0.5, vol: 0.8, genres: Object.fromEntries(ORDER.map(g => [g, true])) };
	try { Object.assign(S, JSON.parse(localStorage.getItem('selecta') || '{}')); } catch {}
	const save = () => { try { localStorage.setItem('selecta', JSON.stringify(S)); } catch {} };

	// ── Camelot wheel: 8A = A minor, 8B = C major; neighbours are one number apart, A/B swap is relative major/minor ──
	const camTonic = (n, L) => L === 'A' ? (9 + 7 * (n - 8) + 120) % 12 : (7 * (n - 8) + 120) % 12;
	const camName = (n, L) => NN[camTonic(n, L)] + (L === 'A' ? 'm' : '');
	function nextKey(prev, wantMinor, r) {
		if (!prev) return { n: 1 + Math.floor(r() * 12), L: wantMinor ? 'A' : 'B' };
		const wrap = n => (n + 11) % 12 + 1, L = wantMinor ? 'A' : 'B';
		if (prev.L !== L) return { n: prev.n, L }; // relative major/minor: the only compatible move that changes the mode
		return r.pick([{ n: prev.n, L }, { n: wrap(prev.n + 1), L }, { n: wrap(prev.n + 1), L }, { n: wrap(prev.n - 1), L }]);
	}

	// ── Audio graph ──
	// deck: drums ─────────────────────────┐
	//       bass / music → duck (sidechain) ┴→ low shelf (bass swap) → high-pass (builds) → fader → master bus
	//       every deck also sends to one shared reverb and one tempo-synced echo
	// master bus → glue compressor → limiter → volume → speakers (+ analyser for the screen)
	let ac = null, out, glue, comp, verb, verbIn, echo, echoIn, echoFb, analyser, noiseBuf;
	const decks = [];
	function audio() {
		if (ac) return ac;
		ac = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
		out = ac.createGain(); out.gain.value = S.vol;
		glue = ac.createDynamicsCompressor(); Object.assign(glue, {}); glue.threshold.value = -16; glue.ratio.value = 2.5; glue.attack.value = 0.02; glue.release.value = 0.25; glue.knee.value = 8;
		comp = ac.createDynamicsCompressor(); comp.threshold.value = -2; comp.ratio.value = 20; comp.attack.value = 0.001; comp.release.value = 0.08; comp.knee.value = 0;
		analyser = ac.createAnalyser(); analyser.fftSize = 512;
		const bus = ac.createGain(); bus.gain.value = 0.6;
		bus.connect(glue); glue.connect(comp); comp.connect(out); out.connect(ac.destination); out.connect(analyser);
		verbIn = ac.createGain(); verb = ac.createConvolver(); verb.buffer = impulse(3.2); const vHp = filt('highpass', 300), vRet = ac.createGain(); vRet.gain.value = 0.55;
		verbIn.connect(vHp); vHp.connect(verb); verb.connect(vRet); vRet.connect(bus);
		echoIn = ac.createGain(); echo = ac.createDelay(4); echoFb = ac.createGain(); echoFb.gain.value = 0.42; const eLp = filt('lowpass', 3200), eHp = filt('highpass', 250), eRet = ac.createGain(); eRet.gain.value = 0.5;
		echoIn.connect(eHp); eHp.connect(echo); echo.connect(eLp); eLp.connect(echoFb); echoFb.connect(echo); eLp.connect(eRet); eRet.connect(bus); eLp.connect(verbIn);
		noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate); const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
		for (let i = 0; i < 2; i++) {
			const d = { throw: ac.createGain(), fader: ac.createGain(), low: ac.createBiquadFilter(), hp: ac.createBiquadFilter(), drums: ac.createGain(), duck: ac.createGain(), bass: ac.createGain(), music: ac.createGain(), verb: ac.createGain(), echo: ac.createGain(), track: null };
			d.low.type = 'lowshelf'; d.low.frequency.value = 220; d.hp.type = 'highpass'; d.hp.frequency.value = 18; d.hp.Q.value = 0.9; d.fader.gain.value = 0;
			d.drums.connect(d.low); d.bass.connect(d.duck); d.music.connect(d.duck); d.duck.connect(d.low); d.low.connect(d.hp); d.hp.connect(d.fader); d.fader.connect(bus);
			d.throw.gain.value = 0; d.hp.connect(d.throw); d.throw.connect(echoIn); d.verb.connect(verbIn); d.echo.connect(echoIn); d.drums.gain.value = 1.25; d.bass.gain.value = 0.3; d.music.gain.value = 1.7; // balanced by measurement: drums and bass level in the drop, music just under
			decks.push(d);
		}
		return ac;
	}
	function filt(type, f, q = 0.7) { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
	function impulse(sec) {
		const n = Math.floor(ac.sampleRate * sec), b = ac.createBuffer(2, n, ac.sampleRate);
		for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3.2; }
		return b;
	}
	const shapes = {};
	function shaper(k) {
		if (!shapes[k]) { const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); } shapes[k] = c; }
		const w = ac.createWaveShaper(); w.curve = shapes[k]; return w;
	}
	function env(t, a, peak, hold, rel) { // attack, hold, then an exponential-ish release; returns the gain node
		const g = ac.createGain(), p = g.gain;
		p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(peak, t + a); p.setValueAtTime(peak, t + a + hold); p.setTargetAtTime(0.0001, t + a + hold, rel / 4);
		return g;
	}
	function osc(type, f, t, end, detune = 0) { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = detune; o.start(t); o.stop(end); return o; }
	const link = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };

	// ── Drums: rendered once per genre into buffers (cheap to play, identical every hit) ──
	const KITS = {};
	async function drumKit(genre) {
		if (KITS[genre]) return KITS[genre];
		const tone = { tech: [150, 46, 0.5], ukg: [135, 46, 0.4], dubstep: [130, 40, 0.55], half: [115, 42, 0.6], liquid: [140, 46, 0.32], jungle: [150, 50, 0.32] }[genre];
		const sr = ac.sampleRate;
		const render = async (len, fn) => { const c = new OfflineAudioContext(1, Math.ceil(sr * len), sr); fn(c, c.destination); const b = await c.startRendering(); const d = b.getChannelData(0); let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v)); if (pk > 0.95) for (let i = 0; i < d.length; i++) d[i] *= 0.95 / pk; return b; };
		const E = (c, a, peak, dec) => { const g = c.createGain(); g.gain.setValueAtTime(0.0001, 0); g.gain.linearRampToValueAtTime(peak, a); g.gain.exponentialRampToValueAtTime(0.0001, a + dec); return g; };
		const F = (c, type, f, q = 0.7) => { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
		const N = (c, len) => { const b = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const s = c.createBufferSource(); s.buffer = b; s.start(0); return s; };
		const O = (c, type, f) => { const o = c.createOscillator(); o.type = type; o.frequency.value = f; o.start(0); return o; };
		const L = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); };
		const hat = dec => (c, o) => { const bp = F(c, 'bandpass', 10000, 0.8), g = E(c, 0.001, 0.45, dec); L(bp, F(c, 'highpass', 7000), g, o); for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) O(c, 'square', f * 1.6).connect(bp); };
		const snare = (f, dec, br) => (c, o) => { const t = O(c, 'triangle', f * 1.4); t.frequency.exponentialRampToValueAtTime(f, 0.03); L(t, E(c, 0.001, 0.55, 0.12), o); L(N(c, dec + 0.05), F(c, 'highpass', br), E(c, 0.001, 0.8, dec), o); };
		const k = KITS[genre] = {};
		const list = {
			K: [0.7, (c, o) => { const s = O(c, 'sine', tone[0]); s.frequency.exponentialRampToValueAtTime(tone[1], 0.12); L(s, E(c, 0.002, 1, tone[2]), o); L(N(c, 0.02), F(c, 'highpass', 2500), E(c, 0.001, 0.3, 0.012), o); }],
			S: [0.45, genre === 'dubstep' || genre === 'jungle' ? (c, o) => { snare(190, 0.3, 1300)(c, o); L(N(c, 0.4), F(c, 'bandpass', 1300, 1.2), E(c, 0.001, 0.6, 0.25), o); } : snare(genre === 'half' ? 250 : 210, 0.2, 1800)],
			C: [0.4, (c, o) => { const g = c.createGain(); let t = 0; g.gain.setValueAtTime(0.0001, 0); for (let i = 0; i < 3; i++, t += 0.011) { g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.1, t + 0.009); } g.gain.setValueAtTime(0.8, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22); L(N(c, 0.4), F(c, 'bandpass', 1300, 1.2), g, o); }],
			G: [0.15, snare(250, 0.06, 2600)],
			H: [0.1, hat(0.045)], O: [0.45, hat(0.32)],
			R: [1.1, (c, o) => { const bp = F(c, 'bandpass', 6500, 0.6); L(bp, F(c, 'highpass', 4000), E(c, 0.001, 0.3, 0.9), o); for (const f of [313, 377, 481, 588, 727]) O(c, 'square', f * 2.9).connect(bp); }],
			M: [0.1, (c, o) => { L(O(c, 'triangle', 1750), E(c, 0.001, 0.6, 0.035), o); L(N(c, 0.05), F(c, 'bandpass', 3000, 2), E(c, 0.001, 0.4, 0.02), o); }],
			T: [0.2, (c, o) => L(N(c, 0.2), F(c, 'highpass', 5500), E(c, 0.02, 0.35, 0.08), o)],
			P: [0.3, (c, o) => { const s = O(c, 'sine', 420); s.frequency.exponentialRampToValueAtTime(330, 0.03); L(s, E(c, 0.001, 0.6, 0.18), o); }],
			X: [1.9, (c, o) => L(N(c, 1.9), F(c, 'highpass', 4500), E(c, 0.002, 0.55, 1.6), o)],
		};
		await Promise.all(Object.entries(list).map(async ([key, [len, fn]]) => { k[key] = await render(len, fn); }));
		return k;
	}

	// ── Instruments: one call schedules one note (or chord) on a deck's bus at time t for `dur` seconds ──
	const INST = {
		sub(d, t, n, dur, v) { const end = t + dur + 0.1, g = env(t, 0.005, 0.9 * v, dur, 0.06); link(osc('sine', hz(n), t, end), g, d.bass); const h = ac.createGain(); h.gain.value = 0.18; link(osc('triangle', hz(n + 12), t, end), h, g); },
		reese(d, t, n, dur, v) {
			const end = t + dur + 0.15, lp = filt('lowpass', 420, 1.2), g = env(t, 0.01, 0.55 * v, dur, 0.1);
			lp.frequency.setValueAtTime(320, t); lp.frequency.linearRampToValueAtTime(700, t + dur * 0.6); lp.frequency.linearRampToValueAtTime(380, t + dur);
			for (const c of [-19, 19]) osc('sawtooth', hz(n + 12), t, end, c).connect(lp);
			link(lp, shaper(2), g, d.bass); INST.sub(d, t, n, dur, v * 0.8);
		},
		wobble(d, t, n, dur, v, rate = 4, sour = 0) { // resonant filter swept by a tempo-locked LFO; rate in Hz, can change per beat
			const end = t + dur + 0.08, lp = filt('lowpass', 300, 11), g = env(t, 0.004, 0.42 * v, dur, 0.05), lfo = osc(sour > 0.5 ? 'square' : 'sine', rate, t, end), depth = ac.createGain();
			depth.gain.value = 900 + sour * 1400; lp.frequency.value = 520 + sour * 300; link(lfo, depth, lp.frequency);
			osc('sawtooth', hz(n + 12), t, end, -8).connect(lp); osc('square', hz(n + 12), t, end, 8).connect(lp);
			link(lp, shaper(3), g, d.bass); INST.sub(d, t, n, dur, v * 0.75);
			return lfo;
		},
		b808(d, t, n, dur, v) { const end = t + dur + 0.2, o = osc('sine', hz(n) * 2, t, end), g = env(t, 0.003, 0.85 * v, dur, 0.15); o.frequency.setValueAtTime(hz(n) * 2, t); o.frequency.exponentialRampToValueAtTime(hz(n), t + 0.05); link(o, shaper(1.8), g, d.bass); },
		pluck(d, t, n, dur, v) { const end = t + dur + 0.05, lp = filt('lowpass', 2000, 5), g = env(t, 0.002, 0.5 * v, Math.min(dur, 0.12), 0.06); lp.frequency.setValueAtTime(2200, t); lp.frequency.exponentialRampToValueAtTime(160, t + 0.16); osc('sawtooth', hz(n + 12), t, end).connect(lp); osc('square', hz(n + 12), t, end).connect(lp); link(lp, g, d.bass); INST.sub(d, t, n, Math.min(dur, 0.14), v * 0.7); },
		warp(d, t, n, dur, v) { const end = t + dur + 0.08, o = osc('square', hz(n + 14), t, end), g = env(t, 0.004, 0.42 * v, dur, 0.06); o.frequency.exponentialRampToValueAtTime(hz(n + 12), t + 0.07); link(o, filt('lowpass', 700, 2), g, d.bass); INST.sub(d, t, n, dur, v * 0.75); },
		pad(d, t, notes, dur, v, bright = 1600) { const end = t + dur + 1.2, lp = filt('lowpass', bright), g = env(t, 0.35, 0.16 * v / Math.sqrt(notes.length), dur, 0.9); for (const n of notes) for (const c of [-9, 9]) osc('sawtooth', hz(n), t, end, c).connect(lp); link(lp, g, d.music); g.connect(d.verb); },
		rhodes(d, t, notes, dur, v) {
			const end = t + dur + 0.8, bus = env(t, 0.004, 0.32 * v / notes.length ** 0.6, dur, 0.5);
			for (const n of notes) { const f = hz(n), car = osc('sine', f, t, end), mod = osc('sine', f, t, end), idx = ac.createGain(); idx.gain.setValueAtTime(f * 2, t); idx.gain.exponentialRampToValueAtTime(f * 0.12, t + 0.3); link(mod, idx, car.frequency); car.connect(bus); }
			link(bus, filt('lowpass', 3500), d.music); bus.connect(d.verb);
		},
		organ(d, t, notes, dur, v) { const end = t + dur + 0.2, bus = env(t, 0.003, 0.24 * v / notes.length ** 0.6, Math.min(dur, 0.25), 0.12); for (const n of notes) for (const [m, a] of [[1, 0.6], [2, 0.35], [4, 0.12]]) { const g = ac.createGain(); g.gain.value = a; link(osc('sine', hz(n) * m, t, end), g, bus); } bus.connect(d.music); bus.connect(d.echo); },
		stab(d, t, notes, dur, v) { const end = t + 0.5, lp = filt('lowpass', 4500, 4), g = env(t, 0.002, 0.2 * v / Math.sqrt(notes.length), 0.06, 0.12); lp.frequency.setValueAtTime(4500, t); lp.frequency.exponentialRampToValueAtTime(500, t + 0.25); for (const n of notes) for (const c of [-7, 7]) osc('sawtooth', hz(n), t, end, c).connect(lp); link(lp, g, d.music); g.connect(d.echo); },
		skank(d, t, notes, dur, v) { const end = t + 0.25, g = env(t, 0.002, 0.22 * v / Math.sqrt(notes.length), 0.05, 0.05), hp = filt('highpass', 380), lp = filt('lowpass', 3600); for (const n of notes.slice(1)) { osc('sawtooth', hz(n + 12), t, end).connect(hp); osc('triangle', hz(n + 12), t, end).connect(hp); } link(hp, lp, g, d.music); g.connect(d.echo); },
		vox(d, t, n, dur, v, wet = 0.3) { // a sung "ah": a saw through vowel formants, with a little scoop into the note
			const end = t + dur + 0.25, o = osc('sawtooth', hz(n) * 0.97, t, end), g = env(t, 0.03, 0.4 * v, dur, 0.15), vib = osc('sine', 5.2, t, end), vd = ac.createGain();
			o.frequency.linearRampToValueAtTime(hz(n), t + 0.06); vd.gain.value = hz(n) * 0.008; link(vib, vd, o.frequency);
			for (const [f, q, a] of [[800, 9, 1], [1150, 10, 0.6], [2800, 12, 0.25]]) { const gg = ac.createGain(); gg.gain.value = a; link(o, filt('bandpass', f, q), gg, g); }
			g.connect(d.music); const w = ac.createGain(); w.gain.value = wet; link(g, w, d.verb); g.connect(d.echo);
		},
		pluckL(d, t, n, dur, v, wet = 0.3) { const end = t + Math.max(dur, 0.2) + 0.2, lp = filt('lowpass', 3000, 3), g = env(t, 0.002, 0.22 * v, 0.04, 0.2); lp.frequency.setValueAtTime(5000, t); lp.frequency.exponentialRampToValueAtTime(700, t + 0.25); osc('square', hz(n), t, end).connect(lp); osc('sawtooth', hz(n), t, end, 7).connect(lp); link(lp, g, d.music); g.connect(d.echo); const w = ac.createGain(); w.gain.value = wet; link(g, w, d.verb); },
		bell(d, t, n, dur, v, wet = 0.4) { const end = t + 2, f = hz(n), car = osc('sine', f, t, end), mod = osc('sine', f * 3.5, t, end), idx = ac.createGain(), g = env(t, 0.002, 0.2 * v, 0.02, 1.2); idx.gain.setValueAtTime(f * 1.5, t); idx.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.8); link(mod, idx, car.frequency); link(car, g, d.music); const w = ac.createGain(); w.gain.value = wet; link(g, w, d.verb); g.connect(d.echo); },
		stabL(d, t, n, dur, v, wet) { INST.stab(d, t, [n, n + 7, n + 12], dur, v * 1.3); },
		riser(d, t, dur, v = 1) { const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true; const bp = filt('bandpass', 300, 3), g = ac.createGain(); bp.frequency.setValueAtTime(250, t); bp.frequency.exponentialRampToValueAtTime(9000, t + dur); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22 * v, t + dur); g.gain.setValueAtTime(0.0001, t + dur + 0.01); link(s, bp, g, d.music); g.connect(d.verb); s.start(t); s.stop(t + dur + 0.05); },
		impact(d, t, v = 1) { const o = osc('sine', 90, t, t + 1.4), g = env(t, 0.002, 0.7 * v, 0.1, 0.7); o.frequency.exponentialRampToValueAtTime(28, t + 1.2); link(o, g, d.drums); },
	};

	// ── Music theory helpers ──
	function chordNotes(key, deg, rich, prev) { // 7th chord (9th when rich), upper voices placed near the last chord so they glide
		const sc = SCALE[key.mode], pc = k => key.tonic + sc[((k % 7) + 7) % 7] + 12 * Math.floor(k / 7);
		const root = pc(deg) % 12, tones = [2, 4, 6].concat(rich ? [8] : []).map(s => (pc(deg + s) - pc(deg) + root) % 12);
		const centre = prev ? prev.reduce((a, b) => a + b, 0) / prev.length : 64;
		const upper = tones.map(p => { let n = p + 12 * Math.round((centre - p) / 12); return n; }).sort((a, b) => a - b);
		return [root + 48 > 58 ? root + 36 : root + 48, ...upper];
	}
	const bassNote = (key, deg) => { const sc = SCALE[key.mode], p = (key.tonic + sc[((deg % 7) + 7) % 7]) % 12; return 28 + ((p - 4 + 12) % 12); }; // E1..Eb2
	const scaleNote = (key, k) => { const sc = SCALE[key.mode]; return key.tonic + sc[((k % 7) + 7) % 7] + 12 * Math.floor(k / 7); };

	// ── A track: genre, key, tempo, palette, motifs and an arrangement in 16-bar blocks ──
	let trackNo = 0;
	function makeTrack(genre, key, prevTrack) {
		const G = GENRES[genre], seed = (Date.now() ^ (trackNo * 2654435761)) >>> 0, r = rng(seed);
		const bpm = G.bpm[0] + Math.round(r() * (G.bpm[1] - G.bpm[0]));
		const mode = key.L === 'A' ? 'minor' : 'major', K = { tonic: camTonic(key.n, key.L), mode };
		const progs = PROGS[mode][G.prog] || PROGS[mode].move, prog = r.pick(progs), chordBars = prog.length === 1 ? 4 : (genre === 'liquid' || genre === 'jungle' || r.chance(0.3)) ? 2 : 1;
		const energy = clamp(S.energy * 0.7 + G.energy * 0.3 + (r() - 0.5) * 0.2, 0, 1);
		// arrangement: intro 32 | breakdown 16 + build 16 | drop + switch-up (32 or 64) | ... | outro 32
		const barSec = 240 / bpm, target = 90 + S.cycle * 30; // arrangement bars are bars of the clock (halftime reads them as half bars)
		const dw = Math.abs((32 + 64) * barSec - target) < Math.abs((32 + 32) * barSec - target) ? 64 : 32;
		const cycles = 1 + (energy > 0.55 && r.chance(0.5) ? 1 : 0);
		const secs = [['intro', 32]];
		for (let c = 0; c < cycles; c++) secs.push(['break', 16], ['build', 16], ['drop', dw / 2], ['switch', dw / 2]);
		secs.push(['outro', 32]);
		let at = 0; const sections = secs.map(([type, bars], i) => { const s = { type, bars, at, dip: r.pick(DIPOLES) }; at += bars; return s; });
		const lane = l => G.d[l] ? r.pick(G.d[l]) : null;
		const drums = Object.fromEntries(Object.keys(G.d).map(l => [l, lane(l)]));
		const t = {
			no: ++trackNo, seed, genre, G, key, K, bpm, prog, chordBars, energy, sections, bars: at, drums,
			name: r.pick(WORDS[0]) + ' ' + r.pick(WORDS[1]), r,
			bassT: r.pick(G.bassT), chordT: r.pick(G.chordT), lead: G.lead,
			call: motif(r, K, energy, false), start: -1, deck: null, blendIn: false, blendOut: true, mixAt: at - 32,
		};
		t.resp = {}; // responses are made per dipole on demand
		return t;
	}
	function motif(r, K, energy, triplet) { // a 2-bar phrase: [beat position, length in beats, scale step]
		const out = [], grid = triplet ? 1 / 3 : 0.5, n = 8 / grid;
		let step = r.pick([0, 2, 4, 7]);
		for (let i = 0; i < n; i++) {
			const strong = (i * grid) % 1 === 0, p = (strong ? 0.55 : 0.28) * (0.6 + energy * 0.7);
			if (i * grid >= 7 || !r.chance(p)) continue;
			step = clamp(step + r.pick([-2, -1, -1, 1, 1, 2, 3, -3, 0]), -2, 9);
			out.push([i * grid, grid * r.pick([1, 1, 2, 3]), step]);
		}
		if (!out.length) out.push([0, 1, 0]);
		return out;
	}
	function answer(t, dip, r) { // the response is the call turned into its opposite
		const c = t.call, [a, b] = dip;
		if (b === 'triplet') return motif(r, t.K, t.energy, true);
		if (b === 'busy') return c.flatMap(([p, l, s]) => [[p, l / 2, s], [p + l / 2, l / 2, s + 1]]);
		if (b === 'long') return c.filter((_, i) => i % 2 === 0).map(([p, l, s]) => [p, Math.min(2, l * 3), s]);
		if (b === 'high') return c.map(([p, l, s]) => [p, l, 11 - s]);
		return c.map(([p, l, s]) => [p, l, s]);
	}

	// ── The step sequencer: the whole set runs on one clock; each track plays its own bar/section from it ──
	const clock = { playing: false, step: 0, time: 0, bpm: 170, glide: null };
	function sectionAt(t, bar) { for (const s of t.sections) if (bar < s.at + s.bars) return s; return null; }
	function playStep(t, g, time, dur) {
		const d = t.deck, G = t.G, st = G.stretch;
		let local = g - t.start;
		if (local < 0 || !t.kit) return;
		const bar = Math.floor(local / 16), s16 = local % 16;
		if (bar >= t.bars) return;
		if (st > 1 && local % st) return; // halftime: the pattern moves at half speed on the 170 grid
		const L = Math.floor(local / st), lbar = Math.floor(L / 16), ls = L % 16, stepDur = dur * st, beatDur = stepDur * 4;
		const sec = sectionAt(t, bar), inSec = bar - sec.at, sw = ls % 2 ? G.swing * stepDur : 0, at = time + sw;
		const E = t.energy, ten = S.tension, phraseEnd = (inSec % 8 === 7) && ls >= 12;
		const hit = (lane, v = 1) => { const b = t.kit[lane]; if (!b) return; const s = ac.createBufferSource(), gg = ac.createGain(); s.buffer = b; gg.gain.value = v; link(s, gg, d.drums); s.start(at); if (lane === 'K') duck(d, at, beatDur); };
		const lane = (l, v = 1) => { const p = t.drums[l]; if (!p) return; const c = p[(lbar * 16 + ls) % p.length]; if (c === 'x') hit(l, v); else if (c === 'o') hit(l, 0.45 * v); };
		const type = sec.type, chordIdx = Math.floor(lbar / t.chordBars) % t.prog.length, deg = t.prog[chordIdx];
		const nextDeg = t.prog[(Math.floor((lbar + 1) / t.chordBars)) % t.prog.length];
		if (ls === 0 && (inSec === 0 || lbar % t.chordBars === 0)) t.chord = chordNotes(t.K, deg, S.bliss > 0.45, t.chord);
		const chord = t.chord || chordNotes(t.K, deg, false);

		// drums
		const full = type === 'drop' || type === 'switch';
		if (type === 'intro' || type === 'outro') {
			const k = type === 'intro' ? inSec : t.sections.at(-1).bars - 1 - inSec; // the outro mirrors the intro
			lane('K'); lane('H', 0.8); if (k >= 8) { lane('S'); lane('C'); lane('O'); lane('T'); lane('G'); } if (k >= 16) { lane('P', 0.8); lane('M'); }
		} else if (type === 'break') {
			if (inSec >= 8) { lane('T', 0.6); lane('H', 0.4); }
		} else if (type === 'build') { // snare roll that doubles up: quarters, 8ths, 16ths, then a breath before the drop
			const div = inSec < 8 ? 4 : inSec < 12 ? 2 : 1, last = inSec === sec.bars - 1;
			if (!(last && ls >= 12) && ls % div === 0) hit('S', 0.35 + 0.6 * inSec / sec.bars);
			if (inSec < 12 && ls % 4 === 0) hit('K', 0.8);
			if (inSec === 0 && ls === 0) INST.riser(d, at, beatDur * 4 * sec.bars, 0.7 + E * 0.5);
		} else if (full) {
			if (inSec === 0 && ls === 0) { hit('X', 0.9); if (type === 'drop') INST.impact(d, at); }
			if (!phraseEnd) { lane('K'); lane('S'); lane('C'); lane('H'); lane('O'); lane('G'); lane('T'); lane('M'); if (E > 0.45) lane('P'); if (type === 'switch' || E > 0.75) lane('R', 0.8); }
			else { lane('K'); if (ls % (E > 0.6 ? 1 : 2) === 0) hit('S', 0.4 + (ls - 12) * 0.15); } // fill into the next phrase
		}
		if (type !== 'build' && type !== 'break' && inSec % 16 === 0 && ls === 0 && inSec && type !== 'intro' && type !== 'outro') hit('X', 0.6);

		// bass
		const bassOn = full || (type === 'intro' && inSec >= 16) || (type === 'outro' && t.sections.at(-1).bars - inSec > 16) || (type === 'break' && sec.dip[1] === 'bass' && inSec >= 8);
		if (bassOn) {
			const bt = type === 'switch' ? switchBass(t) : t.bassT, c = bt[(lbar * 16 + ls) % bt.length];
			if (c !== '.') {
				let len = 1; while (len < 16 && bt[(lbar * 16 + ls + len) % bt.length] === '.') len++;
				let n = bassNote(t.K, c === 'n' ? nextDeg : deg);
				if (c === 'o') n += 12; if (c === 'f') n += 7;
				if (type === 'switch' && c === 's') n += ten > 0.66 ? 6 : 1; // the sour note: a flat 2 or, with tension up, the tritone
				const dur2 = (c === 'R' || c === 's' ? len : Math.min(len, 2)) * stepDur * 0.95, v = c === 'R' ? 1 : 0.85;
				const B = t.G.bass;
				if (B === 'wobble') {
					const rate = type === 'switch' ? (r16(t, lbar, ls) ? 3 / beatDur : 2 / beatDur) * (1 + ten) : (2 / beatDur) * (sec.dip[1] === 'triplet' ? 1.5 : 1);
					INST.wobble(d, at, n, dur2, v, rate, type === 'switch' ? ten : 0);
				} else INST[B](d, at, n, dur2, v);
			}
		}

		// chords: pads in the breakdown, the genre's chord rhythm in the drop (fewer during the switch-up)
		if (type === 'break' && ls === 0 && lbar % t.chordBars === 0) INST.pad(d, at, chord, beatDur * 4 * t.chordBars, 0.8 + S.bliss * 0.6, 900 + S.bliss * 2200);
		if (type === 'build' && ls === 0 && lbar % t.chordBars === 0 && inSec < 12) INST.pad(d, at, chord, beatDur * 4 * t.chordBars, 0.6, 1400 + inSec * 250);
		if (full || (type === 'intro' && inSec >= 24) || (type === 'break' && inSec >= 8)) {
			const c = t.chordT[(lbar * 16 + ls) % t.chordT.length];
			if (c === 'x' && !(type === 'switch' && ls % 8)) {
				const notes = type === 'switch' && ten > 0.3 ? [chord[0], chord[0] + 1, chord[0] + 6, chord[0] + 10].map(n => n + 12) : chord;
				const inst = t.G.chord;
				if (inst === 'rhodes' || inst === 'pad') INST[inst](d, at, notes, beatDur * (inst === 'pad' ? 4 * t.chordBars : 2), 0.7);
				else INST[inst](d, at, notes, stepDur * 2, 0.8);
			}
		}

		// call and response: 2 bars of call, 2 bars of answer, on two opposite ideas (the section's dipole)
		const leadOn = type === 'break' || type === 'build' || (type === 'drop' && inSec >= 8 && E > 0.35) || (type === 'intro' && inSec >= 24 && E > 0.6);
		if (leadOn) {
			const phrase = Math.floor(lbar / 2) % 2, dip = sec.dip, from = (lbar % 2) * 4 + ls / 4, to = from + 0.25;
			const mot = phrase ? (t.resp[dip[2]] ||= answer(t, dip, t.r)) : t.call;
			const base = type === 'drop' ? 0.55 : 0.85;
			for (const [p, l, s] of mot) if (p >= from && p < to) {
				let n = scaleNote(t.K, s) + 60 + (phrase && dip[1] === 'high' ? 12 : 0) + (!phrase && dip[0] === 'low' ? -12 : 0);
				if (phrase && dip[1] === 'sour') n += t.r.chance(0.5) ? 1 : 6;
				if (phrase && dip[1] === 'major' && t.K.mode === 'minor' && (((n - t.K.tonic) % 12) + 12) % 12 === 3) n += 1; // the lift: a major third
				if (type === 'build') n += Math.floor(inSec / 4) * 2;                                                         // the build pulls upward
				const tt = at + (p - from) * beatDur, dur3 = l * beatDur, wet = phrase && dip[1] === 'wet' ? 1 : dip[0] === 'dry' && !phrase ? 0.02 : 0.25;
				const inst = phrase ? (dip[1] === 'now' ? 'pluckL' : dip[1] === 'bass' ? null : t.lead[1]) : (dip[0] === 'then' ? 'bell' : t.lead[0]);
				if (inst === null) INST.sub(d, tt, n - 36, Math.min(dur3, beatDur), 0.9);
				else INST[inst](d, tt, n, dip[1] === 'short' && !phrase ? dur3 * 0.4 : dur3, base, wet);
			}
		}
	}
	const r16 = (t, bar, s) => ((bar * 7 + s * 3 + t.seed) % 5) < 2;
	function switchBass(t) { // the switch-up: the bass riff gets busier and picks up sour notes ("wop wop wop")
		return t._sw ||= (() => { const r = rng(t.seed ^ 0x5eed), n = t.bassT.length, out = [];
			for (let i = 0; i < n; i++) { const c = t.bassT[i]; out.push(c !== '.' ? (r.chance(0.35 + S.tension * 0.4) ? 's' : c) : (r.chance(0.12 + t.energy * 0.2) ? 'r' : '.')); }
			return out.join(''); })();
	}
	function duck(d, t, beatDur) { const p = d.duck.gain; p.cancelScheduledValues(t); p.setValueAtTime(0.32, t); p.setTargetAtTime(1, t + 0.01, beatDur * 0.14); }

	// ── The selecta: picks the next track and mixes it in ──
	const sel = { now: null, next: null, history: [], hold: null };
	function pickNext(cur) {
		const r = rng(Date.now() >>> 0);
		const on = ORDER.filter(g => S.genres[g]);
		const pool = on.length ? on : ORDER;
		const target = clamp(S.energy + 0.25 * Math.sin(trackNo * 0.9), 0, 1); // a slow wave of energy across the set
		const recent = sel.history.slice(-3).map(h => h.genre);
		let best = null, bestScore = -1;
		for (const g of pool) {
			const G = GENRES[g], mid = (G.bpm[0] + G.bpm[1]) / 2;
			let sc = 1 - Math.abs(G.energy - target) + r() * 0.6;
			if (cur) {
				if (g === cur.genre) sc += (1 - S.wander) * 1.6; else sc += S.wander * 0.6;
				if (Math.abs(mid - cur.bpm) / cur.bpm <= 0.08) sc += 0.7; // blendable
				if (recent.length === 3 && recent.every(x => x === g)) sc -= 2;
			}
			if (sc > bestScore) { bestScore = sc; best = g; }
		}
		const key = nextKey(cur?.key, r() < GENRES[best].minor, r);
		const t = makeTrack(best, key, cur);
		t.blendIn = !!cur && Math.abs(t.bpm - cur.bpm) / cur.bpm <= 0.08;
		if (cur) { cur.blendOut = t.blendIn; }
		audio(); drumKit(best).then(k => { t.kit = k; });
		return t;
	}
	// Per bar: mixer moves (faders, bass swap, high-pass), tempo glides, and starting the next track on time
	function onBar() {
		const g = clock.step, nowT = sel.now;
		if (!nowT) return;
		const bar = Math.floor((g - nowT.start) / 16);
		if (sel.hold && bar >= sel.hold.at + sel.hold.bars) nowT.start += sel.hold.bars * 16; // hold: loop this section
		const b2 = Math.floor((g - nowT.start) / 16);
		if (!sel.next && b2 >= nowT.mixAt - 24) sel.next = pickNext(nowT);
		const N = sel.next;
		if (N && !N.deck && N.kit) {
			const startBar = nowT.blendOut ? nowT.mixAt : nowT.mixAt + 16; // blend: the intro rides over the outro; cut: echo out, then drop on the 1
			if (!nowT.blendOut && b2 === nowT.mixAt + 8) INST.riser(nowT.deck, clock.time, 8 * 240 / clock.bpm, 1);
			if (b2 >= startBar) {
				N.deck = decks.find(d => d !== nowT.deck); N.deck.track = N; N.chord = null; resetDeck(N.deck, N.blendIn ? 0 : 1);
				N.start = N.blendIn ? g : g - 16 * 16; // a cut lands on the intro's full half, bass and all
				if (!N.blendIn) { cutOut(nowT); clock.bpm = N.bpm; INST.impact(N.deck, clock.time); }
			}
		}
		if (N?.deck && (b2 >= nowT.bars || !N.blendIn)) { // the old track is done: the new one is now
			nowT.deck.track = null; nowT.deck.fader.gain.setTargetAtTime(0, clock.time, 0.05);
			sel.history.push({ name: nowT.name, genre: nowT.genre, key: nowT.key, bpm: nowT.bpm, how: N.blendIn ? 'blend' : 'cut' });
			sel.now = N; sel.next = null; sel.hold = null; clock.bpm = N.bpm;
			drawList(); mediaMeta();
		}
		const barDur = 240 / clock.bpm;
		for (const t of [sel.now, sel.next]) if (t?.deck) mixBar(t, Math.floor((g - t.start) / 16), clock.time, barDur);
		if (sel.now && sel.next?.deck && sel.next.blendIn) { // tempo glide across the blend
			const o = Math.floor((g - sel.next.start) / 16);
			clock.bpm = sel.now.bpm + (sel.next.bpm - sel.now.bpm) * clamp(o / 32, 0, 1);
		}
		echo.delayTime.setTargetAtTime(Math.min(3.9, 0.75 * 60 / clock.bpm), clock.time, 0.05); // dotted 8th
	}
	function resetDeck(d, fader) { const t = clock.time; for (const [p, v] of [[d.fader.gain, fader], [d.low.gain, 0], [d.hp.frequency, 18], [d.throw.gain, 0]]) { p.cancelScheduledValues(t); p.setValueAtTime(v, t); } }
	function mixBar(t, bar, time, barDur) { // where each fader/EQ should be by the end of this bar
		const d = t.deck, end = time + barDur, isNext = t === sel.next, isNow = t === sel.now && sel.next?.deck;
		let fader = 1, low = 0, hp = 18;
		if (isNext && t.blendIn) { fader = clamp((bar + 1) / 8, 0, 1); low = bar < 15 ? -26 : 0; }
		if (isNow && t.blendOut) { const o = bar - t.mixAt; low = o >= 15 ? -26 : 0; fader = o < 24 ? 1 : clamp(1 - (o - 23) / 8, 0, 1); }
		const sec = sectionAt(t, Math.min(bar, t.bars - 1));
		if (sec?.type === 'build') { const k = bar - sec.at; hp = k < 8 ? 18 : 18 * (300 / 18) ** ((k - 7) / 9); }
		if (t === sel.now && !t.blendOut && bar - t.mixAt >= 8) hp = 18 * (400 / 18) ** ((bar - t.mixAt - 7) / 9); // winding up for the cut
		if (sec?.type === 'break') hp = 60;
		d.fader.gain.linearRampToValueAtTime(fader, end);
		d.low.gain.setTargetAtTime(low, time, 0.06);
		d.hp.frequency.setTargetAtTime(hp, time, sec?.type === 'build' ? barDur / 3 : 0.05);
	}
	function cutOut(t) { // echo out the old track: its last beat goes into a long echo, then it is gone
		const d = t.deck, at = clock.time, beat = 60 / t.bpm;
		d.throw.gain.cancelScheduledValues(at - beat); d.throw.gain.setValueAtTime(0, at - beat); d.throw.gain.linearRampToValueAtTime(0.9, at); d.throw.gain.setValueAtTime(0, at + 0.01);
		d.fader.gain.setValueAtTime(d.fader.gain.value, at); d.fader.gain.linearRampToValueAtTime(0, at + 0.02);
		echoFb.gain.setValueAtTime(0.62, at); echoFb.gain.setTargetAtTime(0.42, at + beat * 6, beat * 2);
	}

	// ── Clock: a worker keeps ticking even when the tab is in the background; we book ahead on the audio clock ──
	let worker = null;
	function tick() {
		if (!clock.playing) return;
		const ahead = document.hidden ? 3 : 0.3;
		while (clock.time < ac.currentTime + ahead) {
			if (clock.step % 16 === 0) onBar();
			const dur = 15 / clock.bpm;
			for (const t of [sel.now, sel.next]) if (t?.deck && t.kit) playStep(t, clock.step, clock.time, dur);
			clock.time += dur; clock.step++;
		}
	}
	async function start() {
		audio(); if (ac.state === 'suspended') await ac.resume();
		if (!sel.now) {
			const t = pickNext(null); t.kit = await drumKit(t.genre);
			t.deck = decks[0]; t.deck.track = t; sel.now = t; clock.bpm = t.bpm; clock.step = 0; t.start = 0; resetDeck(t.deck, 1);
		}
		clock.time = ac.currentTime + 0.15; clock.playing = true;
		out.gain.setTargetAtTime(S.vol, ac.currentTime, 0.05);
		worker ||= new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 25)'], { type: 'text/javascript' })));
		worker.onmessage = tick; tick();
		ui.play.textContent = '■ Stop'; ui.play.classList.add('on'); drawList(); mediaMeta();
		if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
	}
	function stop() {
		clock.playing = false; if (worker) worker.onmessage = null;
		if (ac) out.gain.setTargetAtTime(0, ac.currentTime, 0.08);
		// a fresh set next time: the clock restarts at the track's current bar
		// resume on a bar line: the current bar starts again from its downbeat
		const old = clock.step; clock.step = Math.ceil(clock.step / 16) * 16;
		for (const t of [sel.now, sel.next]) if (t?.deck) { const bar = Math.floor((old - t.start) / 16); t.start = clock.step - bar * 16; }
		ui.play.textContent = '▶ Play'; ui.play.classList.remove('on');
		if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
		setTimeout(() => { if (!clock.playing) ac?.suspend(); }, 400);
	}
	function mixNow() { // jump the current track to its mix-out point on the next bar
		const t = sel.now; if (!t || !clock.playing) return;
		const bar = Math.floor((clock.step - t.start) / 16), target = t.mixAt - 24;
		if (bar < target) t.start -= (target - bar) * 16;
		sel.hold = null;
	}

	// ── Screen ──
	const ui = {};
	const SEC_COL = { intro: '#5c74ff', break: '#34d6ff', build: '#ffd23d', drop: '#ff7a3d', switch: '#ff4f7b', outro: '#5c74ff' };
	const SEC_NAME = { intro: 'Intro', break: 'Breakdown', build: 'Build', drop: 'Drop', switch: 'Switch-up', outro: 'Outro' };
	function buildUi() {
		ui.play = $('#play'); ui.play.addEventListener('click', () => clock.playing ? stop() : start());
		$('#next').addEventListener('click', mixNow);
		$('#hold').addEventListener('click', e => {
			const t = sel.now; if (!t) return;
			if (sel.hold) sel.hold = null; else { const bar = Math.floor((clock.step - t.start) / 16), s = sectionAt(t, bar); if (s && s.type !== 'outro') sel.hold = s; }
			e.currentTarget.classList.toggle('on', !!sel.hold);
		});
		const fz = $('#faders');
		for (const [k, label, def, tip] of FADERS) {
			const w = document.createElement('label'); w.className = 'fader'; w.title = tip;
			w.innerHTML = `<input type="range" min="0" max="1" step="0.01" value="${S[k] ?? def}" aria-label="${label}"><span>${label}</span>`;
			w.querySelector('input').addEventListener('input', e => { S[k] = +e.target.value; save(); });
			fz.append(w);
		}
		const gz = $('#genres');
		for (const g of ORDER) {
			const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (S.genres[g] ? ' on' : ''); b.textContent = GENRES[g].name;
			b.addEventListener('click', () => { S.genres[g] = !S.genres[g]; b.classList.toggle('on', S.genres[g]); save(); });
			gz.append(b);
		}
		const vol = $('#vol'); vol.value = S.vol;
		vol.addEventListener('input', () => { S.vol = +vol.value; save(); if (ac && clock.playing) out.gain.setTargetAtTime(S.vol, ac.currentTime, 0.05); });
		ui.cv = $('#arc'); ui.cx = ui.cv.getContext('2d');
		requestAnimationFrame(draw);
		if (navigator.mediaSession) {
			navigator.mediaSession.setActionHandler('play', start);
			navigator.mediaSession.setActionHandler('pause', stop);
			navigator.mediaSession.setActionHandler('nexttrack', mixNow);
		}
	}
	const keyLabel = t => `${t.key.n}${t.key.L} · ${camName(t.key.n, t.key.L)}`;
	function mediaMeta() {
		const t = sel.now; if (!t || !navigator.mediaSession || !window.MediaMetadata) return;
		navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: 'Robo-Selecta', album: `${t.G.name} · ${t.bpm} BPM · ${keyLabel(t)}` });
	}
	function drawList() {
		const h = sel.history.slice(-12).reverse();
		$('#history').innerHTML = h.map(x => `<li><b>${x.name}</b><span>${GENRES[x.genre].name} · ${x.bpm} · ${x.key.n}${x.key.L}</span><i>${x.how === 'blend' ? 'blended out' : 'echo-out cut'}</i></li>`).join('') || '<li class="muted">Tracks it has played will show up here.</li>';
	}
	const txt = (el, s) => { if (el.textContent !== s) el.textContent = s; };
	let lastDraw = 0;
	function draw(now) {
		requestAnimationFrame(draw);
		if (document.hidden || now - lastDraw < 50) return;
		lastDraw = now;
		const t = sel.now, n = sel.next;
		if (t) {
			const bar = clamp(Math.floor((clock.step - t.start) / 16), 0, t.bars - 1), s = sectionAt(t, bar);
			txt($('#nowName'), t.name); txt($('#nowMeta'), `${t.G.name} · ${Math.round(clock.bpm)} BPM · ${keyLabel(t)}`);
			txt($('#section'), `${SEC_NAME[s.type]} ${bar - s.at + 1}/${s.bars}${sel.hold ? ' · held' : ''}`);
			txt($('#dipole'), s.type === 'intro' || s.type === 'outro' ? 'Mixing zone: drums and bass only, ready for the next track' : `Call and response: ${s.dip[2].toLowerCase()}`);
		}
		if (n) {
			const ready = n.deck ? 'mixing in now' : `in ${Math.max(0, (n.blendIn ? t.mixAt : t.mixAt + 16) - Math.floor((clock.step - t.start) / 16))} bars`;
			txt($('#nextName'), n.name); txt($('#nextMeta'), `${n.G.name} · ${n.bpm} BPM · ${keyLabel(n)} · ${n.blendIn ? '32-bar blend' : 'echo-out cut'} ${ready}`);
		} else { txt($('#nextName'), '…'); txt($('#nextMeta'), 'Choosing as the track plays'); }
		// the arc: this track's sections as blocks, the playhead, and the live level on top
		const cv = ui.cv, cx = ui.cx, dpr = Math.min(2, devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
		if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
		cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, W, H);
		if (!t) return;
		const LV = { intro: 0.35, break: 0.25, build: 0.6, drop: 1, switch: 0.9, outro: 0.35 };
		for (const s of t.sections) {
			const x = s.at / t.bars * W, w = s.bars / t.bars * W - 2, h = (H - 18) * LV[s.type];
			cx.fillStyle = SEC_COL[s.type] + '55'; cx.fillRect(x, H - h, w, h);
			cx.fillStyle = SEC_COL[s.type]; cx.fillRect(x, H - h, w, 2);
			if (w > 50) { cx.fillStyle = '#c9cdf0'; cx.font = '600 10px system-ui, sans-serif'; cx.fillText(SEC_NAME[s.type], x + 4, H - h + 13); }
		}
		const pos = (clock.step - t.start) / 16 / t.bars;
		cx.fillStyle = '#7dffb0'; cx.fillRect(clamp(pos, 0, 1) * W, 0, 2, H);
		if (analyser && clock.playing) {
			const a = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(a);
			cx.fillStyle = 'rgba(255,255,255,0.18)';
			for (let i = 0; i < 64; i++) { const v = a[i * 2] / 255; cx.fillRect(i * W / 64, 0, W / 64 - 1, v * 16); }
		}
	}
	buildUi();
	window.SELECTA = { sel, clock, S, GENRES, makeTrack, chordNotes, nextKey, camName, playStep, decks, drumKit };
})();
