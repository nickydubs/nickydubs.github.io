// Shared audio core for the beat pad, DJFX and the Robo-Selecta.
// One place for the things every app needs and none should get wrong on its own:
//   - the AudioContext, with a Safe (about 10 ms) or Tight (smallest buffer) latency setting
//   - the master chain, as one tiny AudioWorklet: glue compression, master volume, a gentle limiter, a soft clip,
//     and a guard that throws away bad samples (NaN/Infinity) so one glitch can never latch the output into silence
//     (Chrome's DynamicsCompressorNode does exactly that, so no app here uses it any more)
//   - a clip light, a cap on overlapping sounds, Lite mode, and a throttled animation loop
// Everything is block-rate (one gain decision per 128 samples, smoothed across the block), so the master costs
// almost nothing on the audio thread.
window.NDAudio = window.NDAudio || (() => {
	'use strict';
	const PREF_KEY = 'nd-audio';
	const phone = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches);
	const prefs = { latency: 'safe', lite: phone, master: 0.85, phone }; // phones start in Lite, computers do not
	try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch {}
	const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} };
	const listeners = new Set();
	function setPref(k, v) { prefs[k] = v; savePrefs(); for (const fn of listeners) fn(k, v); }

	const MASTER = `
	class NdMaster extends AudioWorkletProcessor {
		static get parameterDescriptors() {
			return [{ name: 'gain', defaultValue: 0.85, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
				{ name: 'glue', defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
		}
		constructor() {
			super(); this.g = 1; this.env = 0; this.lim = 1; this.mg = 0.85;
			this.n = 0; this.pk = 0; this.clip = 0; this.bad = 0; this.grMax = 0;
		}
		process(I, O, p) {
			const inp = I[0], out = O[0], len = out[0].length, chs = out.length, blk = len / sampleRate;
			if (!inp.length) { for (const c of out) c.fill(0); return true; }
			// 1) guard and measure
			let pk = 0;
			for (let c = 0; c < chs; c++) {
				const x = inp[c] || inp[0], y = out[c];
				for (let i = 0; i < len; i++) {
					let v = x[i];
					if (!(v > -64 && v < 64)) { v = 0; this.bad++; this.env = 0; this.lim = 1; } // NaN, Infinity or a blown-up filter
					y[i] = v; const a = v < 0 ? -v : v; if (a > pk) pk = a;
				}
			}
			// 2) glue: a soft-knee compressor deciding once per block (attack 10 ms, release 180 ms)
			const glue = p.glue[0], thr = -6 - 16 * glue, ratio = 1 + 3 * glue, knee = 6;
			const lvl = 20 * Math.log10(pk + 1e-9), over = lvl - thr;
			let gr = over <= -knee / 2 ? 0 : over >= knee / 2 ? over * (1 - 1 / ratio) : (1 - 1 / ratio) * (over + knee / 2) ** 2 / (2 * knee);
			const ca = Math.exp(-blk / 0.01), cr = Math.exp(-blk / 0.18);
			this.env = gr > this.env ? ca * this.env + (1 - ca) * gr : cr * this.env + (1 - cr) * gr;
			const makeup = 3 * glue, g1 = 10 ** ((makeup - this.env) / 20) * this.mg;
			// master volume glides too (no zipper noise when you drag it)
			this.mg += (p.gain[0] - this.mg) * (1 - Math.exp(-blk / 0.03));
			// 3) limiter: no look-ahead; pull down at once when the block would go over, let go over 120 ms
			const ceil = 0.89, gHi = Math.max(this.g / this.lim, g1), need = pk * gHi > ceil ? ceil / (pk * gHi) : 1; // the block starts at the old gain, so check the higher of the two
			if (need < this.lim) this.lim = need; else this.lim += (1 - this.lim) * (1 - Math.exp(-blk / 0.12));
			const g0 = this.g, gEnd = g1 * this.lim, dg = (gEnd - g0) / len;
			// 4) apply, smoothing the gain across the block; a soft clip catches whatever the limiter's ramp lets through
			let clip = 0;
			for (let c = 0; c < chs; c++) {
				const y = out[c]; let g = g0;
				for (let i = 0; i < len; i++) {
					g += dg; let v = y[i] * (need < 1 ? Math.min(g, gEnd) : g);
					if (v > 0.9 || v < -0.9) { clip++; const s = v < 0 ? -1 : 1, a = v * s; v = s * (0.9 + 0.1 * Math.tanh((a - 0.9) * 10)); }
					y[i] = v;
				}
			}
			this.g = gEnd;
			// 5) meter: about ten reports a second
			const red = -20 * Math.log10(this.lim);
			if (pk > this.pk) this.pk = pk; if (red > this.grMax) this.grMax = red; this.clip += clip;
			if ((this.n += len) >= 4800) {
				this.port.postMessage({ pk: this.pk, lim: this.grMax, glue: this.env, clip: this.clip, bad: this.bad });
				this.n = 0; this.pk = 0; this.grMax = 0; this.clip = 0; this.bad = 0;
			}
			return true;
		}
	}
	registerProcessor('nd-master', NdMaster);`;

	// Make the context. `kind`: 'play' (pads, decks: Safe or Tight from prefs) or 'listen' (the selecta: big buffer, never crackles)
	function context(kind = 'play') {
		const C = window.AudioContext || window.webkitAudioContext;
		const hint = kind === 'listen' ? 'playback' : prefs.latency === 'tight' ? 0 : 0.012;
		try { return new C({ latencyHint: hint }); } catch { return new C({ latencyHint: 'interactive' }); }
	}

	// Build the master chain on a context: returns { input, node, ready, setGain, setGlue, onMeter }.
	// Until the worklet loads (a few ms) audio passes through a plain gain, so nothing is ever silent while it loads.
	function master(ac, { gain = prefs.master, glue = 0.4 } = {}) {
		const input = ac.createGain(), fallback = ac.createGain();
		input.connect(fallback); fallback.connect(ac.destination);
		const m = { input, node: null, gain, glue, meter: null, ready: null };
		m.setGain = v => { m.gain = v; if (m.node) m.node.parameters.get('gain').setTargetAtTime(v, ac.currentTime, 0.02); else fallback.gain.setTargetAtTime(Math.min(v, 0.8), ac.currentTime, 0.02); };
		m.setGlue = v => { m.glue = v; if (m.node) m.node.parameters.get('glue').setValueAtTime(v, ac.currentTime); };
		m.onMeter = fn => { m.meter = fn; };
		fallback.gain.value = Math.min(gain, 0.8);
		m.ready = (ac.audioWorklet ? ac.audioWorklet.addModule(URL.createObjectURL(new Blob([MASTER], { type: 'text/javascript' }))) : Promise.reject(new Error('no worklet')))
			.then(() => {
				const node = new AudioWorkletNode(ac, 'nd-master', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
				node.parameters.get('gain').value = m.gain; node.parameters.get('glue').value = m.glue;
				node.port.onmessage = e => { m.last = e.data; if (m.meter) m.meter(e.data); };
				input.connect(node); node.connect(ac.destination);
				const t = ac.currentTime; fallback.gain.setTargetAtTime(0, t, 0.005); setTimeout(() => { try { input.disconnect(fallback); } catch {} }, 100);
				m.node = node; return m;
			})
			.catch(e => { console.warn('master worklet unavailable, using a plain gain', e); return m; });
		return m;
	}

	// A red clip light: `el` gets .is-clip while the limiter works hard or the soft clip catches peaks, and a title saying why
	function clipLight(m, el) {
		let off = 0;
		const prev = m.meter;
		m.onMeter(d => {
			prev && prev(d);
			const hot = d.clip > 0 || d.lim > 4 || d.bad > 0;
			if (hot) { el.classList.add('is-clip'); el.title = d.bad ? 'A glitch was caught and removed' : `Too hot: the limiter pulled ${d.lim.toFixed(1)} dB. Turn something down.`; clearTimeout(off); off = setTimeout(() => el.classList.remove('is-clip'), 600); }
		});
	}

	// Cap on overlapping sounds, and "mono" pads: hitting the same key again cuts the last hit of that key.
	// play(src, gainNode, key, when): registers a started voice; the oldest goes (with a 6 ms fade) when over the cap.
	function voices(ac, max = 24) {
		const list = [], byKey = new Map();
		const kill = (v, at) => {
			if (v.dead) return; v.dead = true;
			try { const p = v.g.gain; p.cancelScheduledValues(at); p.setValueAtTime(p.value, at); p.linearRampToValueAtTime(0, at + 0.006); v.s.stop(at + 0.01); } catch {}
		};
		return {
			get max() { return max; }, set max(n) { max = n; },
			play(s, g, key, when = ac.currentTime) {
				const v = { s, g, key, dead: false };
				if (key != null) { const old = byKey.get(key); if (old) kill(old, Math.max(when, ac.currentTime)); byKey.set(key, v); }
				list.push(v);
				s.addEventListener('ended', () => { v.dead = true; const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); if (byKey.get(key) === v) byKey.delete(key); });
				while (list.filter(x => !x.dead).length > max) { const o = list.find(x => !x.dead); kill(o, ac.currentTime); }
				return v;
			},
			stopAll(at = ac.currentTime) { for (const v of list) kill(v, at); },
			get count() { return list.filter(x => !x.dead).length; },
		};
	}

	// Throttled screen loop: runs fn(now) at most `fps` times a second, never while the tab is hidden; Lite mode halves it
	function frames(fn, fps = 30) {
		let last = 0;
		const loop = now => {
			requestAnimationFrame(loop);
			if (document.hidden) return;
			const gap = 1000 / (prefs.lite ? fps / 2 : fps);
			if (now - last < gap) return;
			last = now; fn(now);
		};
		requestAnimationFrame(loop);
	}

	// Keep the context running: some systems suspend it (a headset unplugged, another app taking the device)
	function keepAlive(ac, wanted) {
		const poke = () => { if (wanted() && ac.state !== 'running' && ac.state !== 'closed') ac.resume().catch(() => {}); };
		ac.addEventListener('statechange', poke);
		document.addEventListener('visibilitychange', poke);
		setInterval(poke, 2000);
	}

	return { prefs, setPref, onPref: fn => listeners.add(fn), context, master, clipLight, voices, frames, keepAlive };
})();
