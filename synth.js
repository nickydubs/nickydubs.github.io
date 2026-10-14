// PianiSynth: the Air Wiggler's subtractive + FM hybrid synth, plus its 128 factory patches (bank A).
// Pure audio + data here; the knobs, keyboard and memory live in beatpad.js.
(() => {
	const WAVES = ['Saw', 'Pulse', 'Tri', 'Sine'];
	const RATIOS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8];
	const FTYPES = ['lowpass', 'bandpass', 'highpass'];
	const INIT = { // an "init" patch: one plain saw through an open filter
		w1: 0, w2: 0, pw: 0.5, pwm: 0, lfo: 0.6, mix: 0, det: 7, semi: 0, fm: 0, ratio: 1,
		cut: 6000, res: 1, famt: 0.3, pamt: 0, lvl: 0.7, a: 0.005, d: 0.5, s: 0.7, r: 0.3, glide: 0, ft: 0,
		tA: true, tF: true, tP: false, tM: false,
	};
	const hz = n => 440 * 2 ** ((n - 69) / 12);

	// ── Factory patches: 32 hand-made cores, each in four flavours (as is, Dark, Snap, Wide) = 128 ──
	const R = v => RATIOS.indexOf(v);
	const CORES = [
		['Moog Bass', { w1: 0, w2: 1, pw: 0.4, semi: -12, mix: 0.5, cut: 320, res: 6, famt: 0.55, a: 0.002, d: 0.25, s: 0.25, r: 0.12 }],
		['Reese', { w1: 0, w2: 0, det: 26, mix: 0.9, cut: 900, res: 2, famt: 0.1, a: 0.01, d: 1, s: 0.9, r: 0.3 }],
		['808 Sub', { w1: 3, w2: 2, semi: 12, mix: 0.15, cut: 2000, famt: 0, tF: false, pamt: 12, tP: true, d: 0.9, s: 0, r: 0.5 }],
		['FM Slap Bass', { w1: 3, w2: 3, mix: 0, fm: 4, ratio: R(1), tM: true, cut: 3000, famt: 0.2, d: 0.25, s: 0.15, r: 0.1 }],
		['Acid Squelch', { w1: 0, mix: 0, cut: 220, res: 18, famt: 0.7, d: 0.2, s: 0.05, r: 0.08, glide: 0.06 }],
		['Pluck Bass', { w1: 1, pw: 0.25, mix: 0, cut: 600, res: 4, famt: 0.5, d: 0.18, s: 0, r: 0.15 }],
		['Supersaw Lead', { w1: 0, w2: 0, det: 18, mix: 0.8, cut: 5000, res: 1, famt: 0.2, a: 0.01, d: 0.5, s: 0.8, r: 0.35, glide: 0.03 }],
		['Square Lead', { w1: 1, w2: 1, pw: 0.5, pwm: 0.35, lfo: 4.5, semi: 12, mix: 0.3, cut: 3500, res: 3, famt: 0.25, s: 0.8 }],
		['FM Scream', { w1: 0, mix: 0, fm: 2.5, ratio: R(2), tM: true, cut: 4200, res: 8, famt: 0.3, d: 0.6, s: 0.5, r: 0.3 }],
		['Whistle', { w1: 3, w2: 2, semi: 12, mix: 0.2, cut: 8000, famt: 0, a: 0.04, s: 1, r: 0.4, glide: 0.08 }],
		['Chip Lead', { w1: 1, pw: 0.125, mix: 0, cut: 18000, famt: 0, tF: false, a: 0.001, d: 0.1, s: 0.8, r: 0.05 }],
		['Glide Saw', { w1: 0, w2: 1, semi: -12, mix: 0.4, cut: 2800, res: 4, famt: 0.3, s: 0.7, glide: 0.18 }],
		['DX E.Piano', { w1: 3, w2: 3, mix: 0.3, semi: 12, fm: 3.5, ratio: R(1), tM: true, cut: 9000, famt: 0, tF: false, a: 0.002, d: 1.4, s: 0.15, r: 0.5 }],
		['Tine Piano', { w1: 3, mix: 0, fm: 5, ratio: R(3.5), tM: true, cut: 12000, famt: 0, tF: false, a: 0.001, d: 1.8, s: 0.1, r: 0.6 }],
		['Clav Funk', { w1: 1, pw: 0.2, mix: 0, cut: 1800, res: 5, famt: 0.45, d: 0.25, s: 0.3, r: 0.05 }],
		['Drawbar Organ', { w1: 3, w2: 3, semi: 12, mix: 0.6, fm: 0.3, ratio: R(3), cut: 9000, famt: 0, tF: false, tA: false, s: 1, r: 0.05 }],
		['Wurly', { w1: 2, w2: 1, pw: 0.3, mix: 0.3, pwm: 0.1, lfo: 5, cut: 2500, res: 2, famt: 0.3, d: 0.9, s: 0.2, r: 0.3 }],
		['Toy Piano', { w1: 3, mix: 0, fm: 6, ratio: R(4), tM: true, cut: 12000, famt: 0, tF: false, d: 0.5, s: 0, r: 0.3 }],
		['Juno Strings', { w1: 0, w2: 1, pwm: 0.5, lfo: 0.5, det: 10, mix: 0.6, cut: 3200, res: 1, famt: 0.15, a: 0.6, d: 1, s: 0.8, r: 1.4 }],
		['Warm Pad', { w1: 2, w2: 0, det: 12, mix: 0.5, cut: 1400, famt: 0.2, a: 1.2, d: 2, s: 0.8, r: 2.5 }],
		['Glass Pad', { w1: 3, w2: 3, det: 6, mix: 0.5, semi: 12, fm: 1.5, ratio: R(2), cut: 7000, famt: 0.1, a: 1.5, d: 2, s: 0.8, r: 3 }],
		['Dark Choir', { w1: 1, w2: 1, pw: 0.35, pwm: 0.3, lfo: 0.3, det: 9, mix: 0.6, ft: 1, cut: 1200, res: 3, famt: 0.1, a: 1, d: 1, s: 0.9, r: 2 }],
		['Sweep Pad', { w1: 0, w2: 0, det: 14, mix: 0.7, cut: 300, res: 9, famt: 0.6, a: 2, d: 3, s: 0.3, r: 3 }],
		['Shimmer', { w1: 3, w2: 2, semi: 19, mix: 0.4, fm: 1, ratio: R(2), cut: 9000, famt: 0, a: 2.5, d: 2, s: 0.8, r: 4 }],
		['Harp Pluck', { w1: 2, w2: 0, semi: 12, mix: 0.2, cut: 2600, famt: 0.5, d: 0.35, s: 0, r: 0.4 }],
		['Marimba', { w1: 3, mix: 0, fm: 2, ratio: R(4), tM: true, cut: 8000, famt: 0, tF: false, d: 0.3, s: 0, r: 0.2 }],
		['Kalimba', { w1: 3, mix: 0, fm: 3, ratio: R(5), tM: true, cut: 8000, famt: 0, tF: false, d: 0.45, s: 0, r: 0.5 }],
		['FM Bell', { w1: 3, mix: 0, fm: 6, ratio: R(3.5), tM: true, cut: 14000, famt: 0, tF: false, d: 2.5, s: 0, r: 2.5 }],
		['Steel Drum', { w1: 3, w2: 3, semi: 12, mix: 0.25, fm: 2.2, ratio: R(2.5), tM: true, cut: 6000, famt: 0, tF: false, d: 0.6, s: 0, r: 0.4 }],
		['Synth Brass', { w1: 0, w2: 0, det: 8, mix: 0.7, cut: 900, res: 2, famt: 0.55, a: 0.06, d: 0.4, s: 0.7, r: 0.2 }],
		['Laser Zap', { w1: 3, mix: 0, fm: 3, ratio: R(1.5), pamt: 24, tP: true, cut: 9000, famt: 0, tF: false, d: 0.15, s: 0, r: 0.1 }],
		['Wind Tunnel', { w1: 3, w2: 3, mix: 0.5, det: 40, fm: 10, ratio: R(7), ft: 1, cut: 1500, res: 10, famt: 0.2, a: 1, d: 1, s: 0.8, r: 2 }],
	];
	const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
	const FLAVOURS = [
		['', p => p],
		[' Dark', p => ({ ...p, cut: clamp(p.cut * 0.45, 60, 18000), res: clamp(p.res + 2, 0, 25), famt: clamp(p.famt * 0.8, 0, 1) })],
		[' Snap', p => ({ ...p, a: Math.max(0.001, p.a * 0.3), d: p.d * 0.5, s: p.s * 0.6, famt: clamp(p.famt + 0.15, 0, 1), r: p.r * 0.7 })],
		[' Wide', p => ({ ...p, det: clamp(p.det + 12, 0, 50), mix: Math.max(p.mix, 0.55), a: p.a * 2 + 0.02, r: p.r * 1.5 })],
	];
	const PRESETS = CORES.flatMap(([name, o]) => FLAVOURS.map(([suf, f]) => ({ name: name + suf, p: f({ ...INIT, ...o }) })));

	// ── Engine ──
	function createEngine(ac, out) {
		const P = { ...INIT };
		const master = ac.createGain();
		const cutSrc = ac.createConstantSource(), resSrc = ac.createConstantSource(); // shared, so you can sweep held notes
		const lfo = ac.createOscillator();
		cutSrc.start(); resSrc.start(); lfo.start();
		master.connect(out);
		const voices = new Map();
		let lastF = 0;
		function live() {
			const t = ac.currentTime;
			master.gain.setTargetAtTime(P.lvl * 0.5, t, 0.02);
			cutSrc.offset.setTargetAtTime(P.cut, t, 0.02);
			resSrc.offset.setTargetAtTime(P.res, t, 0.02);
			lfo.frequency.setTargetAtTime(P.lfo, t, 0.02);
		}
		live();
		// ADSR on any AudioParam: from base up to peak, settle at base + (peak - base) * sustain
		function env(param, t, base, peak) {
			param.cancelScheduledValues(t);
			param.setValueAtTime(base, t);
			param.linearRampToValueAtTime(peak, t + P.a);
			param.setTargetAtTime(base + (peak - base) * P.s, t + P.a, Math.max(0.003, P.d / 3));
		}
		function release(param, t, base, r) {
			const v = param.value;
			param.cancelScheduledValues(t);
			param.setValueAtTime(v, t);
			param.setTargetAtTime(base, t, Math.max(0.003, r / 4));
		}
		function osc(wave, f, t, sum, freqs) {
			const o = ac.createOscillator();
			freqs.push(o);
			if (wave !== 1) { o.type = ['sawtooth', , 'triangle', 'sine'][wave]; o.connect(sum); return [o]; }
			// Pulse = a saw minus a delayed copy of itself; the delay sets the width, an LFO on it gives PWM
			o.type = 'sawtooth';
			const inv = ac.createGain(), dl = ac.createDelay(0.1), depth = ac.createGain();
			inv.gain.value = -1;
			dl.delayTime.value = P.pw / f;
			depth.gain.value = P.pwm * 0.45 / f;
			o.connect(sum); o.connect(dl); dl.connect(inv); inv.connect(sum);
			lfo.connect(depth); depth.connect(dl.delayTime);
			return [o, depth];
		}
		// Live notes (no `at`) are tracked by note number; scheduled ones (the piano roll) are returned to the
		// caller, who books their release with releaseAt().
		function noteOn(note, vel = 0.8, at) {
			if (at === undefined) {
				noteOff(note, true);
				if (voices.size >= 10) noteOff(voices.keys().next().value, true); // steal the oldest
			}
			const t = Math.max(ac.currentTime, at || 0), f = hz(note);
			const sum = ac.createGain(), filt = ac.createBiquadFilter(), vca = ac.createGain(), dc = ac.createBiquadFilter();
			filt.type = FTYPES[P.ft]; filt.frequency.value = 0; filt.Q.value = 0;
			cutSrc.connect(filt.frequency); resSrc.connect(filt.Q);
			dc.type = 'highpass'; dc.frequency.value = 18; // pulse waves carry DC; keep it out of the mix
			const freqs = [], extra = [];
			const g1 = ac.createGain(), g2 = ac.createGain();
			g1.gain.value = 1 - P.mix * 0.5; g2.gain.value = P.mix;
			extra.push(...osc(P.w1, f, t, g1, freqs));
			const f2 = f * 2 ** (P.semi / 12);
			if (P.mix > 0) extra.push(...osc(P.w2, f2, t, g2, freqs));
			g1.connect(sum); g2.connect(sum);
			freqs.forEach((o, i) => { o.frequency.value = i === 0 || P.mix === 0 ? f : f2; if (i > 0) o.detune.value = P.det; });
			if (P.glide > 0 && lastF) for (const o of freqs) { // portamento from the last note played
				const target = o.frequency.value;
				o.frequency.setValueAtTime(target * lastF / f, t);
				o.frequency.setTargetAtTime(target, t, P.glide / 3);
			}
			lastF = f;
			// FM: a sine modulator on both oscillators' frequency
			let mod = null, modG = null;
			if (P.fm > 0) {
				mod = ac.createOscillator(); modG = ac.createGain();
				mod.frequency.value = f * RATIOS[P.ratio];
				const depth = P.fm * f * RATIOS[P.ratio] * 0.5;
				if (P.tM) env(modG.gain, t, depth * 0.05, depth); else modG.gain.value = depth;
				mod.connect(modG);
				for (const o of freqs) modG.connect(o.frequency);
			}
			if (P.tP && P.pamt) for (const o of [...freqs, ...(mod ? [mod] : [])]) env(o.detune, t, o.detune.value, o.detune.value + P.pamt * 100);
			if (P.tF) env(filt.detune, t, 0, P.famt * 6000); // cutoff opens up to 5 octaves
			const peak = 0.3 + 0.7 * vel;
			if (P.tA) env(vca.gain, t, 0, peak);
			else { vca.gain.setValueAtTime(0, t); vca.gain.linearRampToValueAtTime(peak, t + 0.004); }
			chain(sum, filt, dc, vca, master);
			for (const o of freqs) o.start(t);
			mod?.start(t);
			const v = { freqs, mod, modG, vca, filt, extra };
			if (at === undefined) voices.set(note, v);
			return v;
		}
		function releaseAt(v, at) {
			const r = P.tA ? P.r : 0.02, t = Math.max(at, ac.currentTime);
			v.vca.gain.cancelScheduledValues(t);
			v.vca.gain.setTargetAtTime(0, t, Math.max(0.003, r / 4));
			if (P.tF) { v.filt.detune.cancelScheduledValues(t); v.filt.detune.setTargetAtTime(0, t, Math.max(0.003, P.r / 4)); }
			const end = t + r * 1.6 + 0.05;
			for (const o of v.freqs) o.stop(end);
			v.mod?.stop(end);
			cleanup(v, end);
		}
		function cleanup(v, end) {
			setTimeout(() => { try { cutSrc.disconnect(v.filt.frequency); resSrc.disconnect(v.filt.Q); } catch {} for (const x of v.extra) if (x.gain) try { lfo.disconnect(x); } catch {} }, (end - ac.currentTime) * 1000 + 50);
		}
		function noteOff(note, fast) {
			const v = voices.get(note);
			if (!v) return;
			voices.delete(note);
			const t = ac.currentTime, r = fast ? 0.015 : P.tA ? P.r : 0.02;
			release(v.vca.gain, t, 0, r);
			if (P.tF && !fast) release(v.filt.detune, t, 0, P.r);
			const end = t + r * 1.6 + 0.05;
			for (const o of v.freqs) o.stop(end);
			v.mod?.stop(end);
			cleanup(v, end);
		}
		function chain(...n) { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); }
		return {
			P, noteOn, noteOff, releaseAt, live,
			allOff() { for (const n of [...voices.keys()]) noteOff(n, true); },
			load(p) { Object.assign(P, INIT, p); live(); },
		};
	}

	window.PianiSynth = { WAVES, RATIOS, FTYPES, INIT, PRESETS, createEngine };
})();
