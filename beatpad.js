// Nicky Dubs beat pad: 16 pads, two kits synthesized right here in the browser (no samples to download,
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
	};

	// Two kits. `len` = render length (s), `group` = mute group (MPC-style choke), `c` = pad colour.
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
	const buffers = {}, custom = { soul: [], 808: [] };
	let rendering = null;
	function renderAll() {
		return rendering || (rendering = Promise.all(Object.entries(KITS).map(async ([id, kit]) => {
			buffers[id] = await Promise.all(kit.pads.map(p => renderPad(p, kit.dusty)));
		})));
	}

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
			led.addEventListener('click', () => { audio(); P[m.id].on = !P[m.id].on; led.setAttribute('aria-pressed', P[m.id].on); apply(m.id); });
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
				knob(wrap.querySelector('.knob'), {
					min: 0, max: list ? curve.length - 1 : 1, step: list ? 1 : 0.005, value: toKnob(def),
					onInput: v => { P[m.id][key] = toReal(v); show(); apply(m.id); },
				});
				show();
			}
			// extras: tempo sync for the delay, sidechain source for the compressor
			if (m.sync !== undefined) {
				const b = document.createElement('button');
				b.type = 'button'; b.className = 'rack__opt'; b.setAttribute('aria-pressed', 'true'); b.textContent = 'Sync';
				b.title = 'Snap the delay time to the metronome tempo';
				b.addEventListener('click', () => { P.dly.sync = !P.dly.sync; b.setAttribute('aria-pressed', P.dly.sync); hooks.forEach(f => f()); });
				head.append(b);
			}
			if (m.key !== undefined) {
				const b = document.createElement('button');
				b.type = 'button'; b.className = 'rack__opt'; b.title = 'Sidechain: which sound pumps the compressor (tap to cycle)';
				const lbl = () => { b.textContent = 'SC: ' + KEYS_SC.find(k => k[0] === P.comp.key)[1]; b.setAttribute('aria-pressed', P.comp.key !== 'off'); };
				b.addEventListener('click', () => { const i = KEYS_SC.findIndex(k => k[0] === P.comp.key); P.comp.key = KEYS_SC[(i + 1) % KEYS_SC.length][0]; lbl(); applyComp(); });
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
		pad.querySelectorAll('[data-kit]').forEach(b => b.classList.toggle('is-on', b.dataset.kit === kit));
	}
	pad.querySelectorAll('[data-kit]').forEach(b => b.addEventListener('click', () => { kit = b.dataset.kit; label(); }));
	label();

	async function hit(i) {
		const c = audio();
		if (c.state === 'suspended') c.resume();
		els[i].animate([{ transform: 'scale(0.93)', filter: 'brightness(1.9)' }, { transform: 'scale(1)', filter: 'brightness(1)' }],
			{ duration: 260, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)' });
		const own = custom[kit][i];
		if (!own && !buffers[kit]) await renderAll();
		const buf = own ? own.buffer : buffers[kit][i];
		const group = own ? null : KITS[kit].pads[i][4];
		const t = c.currentTime;
		if (group && voices[group]) { // choke: closed hat cuts open hat, a new 808 note cuts the last
			const v = voices[group];
			v.g.gain.setTargetAtTime(0, t, 0.008);
			v.src.stop(t + 0.05);
		}
		const src = c.createBufferSource(), g = c.createGain();
		src.buffer = buf;
		chain(src, g, !own && isKey(KITS[kit].pads[i]) ? keyBus : bus);
		src.start(t);
		window.wiggler?.hit(own ? 'u' : KITS[kit].pads[i][3], i === 0 || /kick/i.test(KITS[kit].pads[i][0]) ? 1.2 : 0.8);
		if (group) { voices[group] = { src, g }; src.onended = () => { if (voices[group]?.src === src) delete voices[group]; }; }
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
		const coarse = knob(box.querySelector('[data-knob="coarse"]'), { min: 30, max: 300, step: 1, keyStep: 1, value: 120, onInput: v => { bpm = v + fine.get(); show(); } });
		const fine = knob(box.querySelector('[data-knob="fine"]'), { min: 0, max: 0.9, step: 0.1, keyStep: 0.1, value: 0, onInput: v => { bpm = coarse.get() + v; show(); } });
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
			setBpm(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
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
			Object.assign(s, { state: 'empty', buf: null, rbuf: null });
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
			const i = LKEYS.indexOf(e.code);
			if (i < 0) return;
			e.preventDefault(); tap(i);
		});
		return {
			wake() { if (!raf) raf = requestAnimationFrame(ui); },
			sleep() { S.forEach((s, i) => { if (recSlot === i) clear(i); else if (s.state === 'playing') pause(i); }); repeatOff(); scratchOff(); setDel(false); },
		};
	})();

	// ── The popup: opening it warms up audio + renders the kits, so the very first hit is instant ──
	const bot = pad.querySelector('.bot');
	if (bot && window.wiggler) wiggler.mount(bot);
	document.querySelectorAll('.rig-open').forEach(b => b.addEventListener('click', () => {
		rig.showModal();
		const c = audio();
		if (c.state === 'suspended') c.resume();
		renderAll();
		window.wiggler?.start();
		loops?.wake();
		setTimeout(showLatency, 400); // outputLatency is only known once audio is actually flowing
	}));
	rig.querySelector('.rig__close').addEventListener('click', () => rig.close());
	rig.addEventListener('click', e => { if (e.target === rig) rig.close(); }); // tap the backdrop to close
	rig.addEventListener('close', () => { window.wiggler?.stop(); metro.stop(); loops?.sleep(); });

	// Keyboard: 1-4 / Q-R / A-F / Z-V, but only while the popup is open.
	addEventListener('keydown', e => {
		if (!rig.open || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
		const i = KEYS.indexOf(e.code);
		if (i < 0) return;
		e.preventDefault();
		hit(i);
	});
})();
