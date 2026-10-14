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

	// ── Live audio graph: dry + reverb send + delay send → soft clipper → speakers ──
	// No DynamicsCompressorNode on purpose: Chrome's has a fixed ~6 ms look-ahead, which you can feel.
	// A tanh waveshaper catches the peaks instead, with zero added delay.
	let ac, bus, master, revSend, revRet, delSend, delRet, fb;
	const FB = 0.38;
	function audio() {
		if (ac) return ac;
		ac = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
		SR = ac.sampleRate;
		const comp = shaper(ac, 1.4);
		master = ac.createGain(); master.gain.value = 0.6; // the clipper adds ~4 dB on quiet signals; this evens it out
		chain(master, comp, ac.destination);
		bus = ac.createGain(); bus.connect(master);
		// reverb: a generated 2.4s stereo room (decaying noise), no impulse file to download
		const conv = ac.createConvolver(), len = ac.sampleRate * 2.4, ir = ac.createBuffer(2, len, ac.sampleRate);
		for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3.2; }
		conv.buffer = ir;
		revSend = ac.createGain(); revRet = ac.createGain();
		chain(bus, revSend, conv, revRet, master);
		// delay: dotted-eighth-ish echo that darkens as it repeats
		const dl = ac.createDelay(2), lp = ac.createBiquadFilter();
		dl.delayTime.value = 0.33; lp.type = 'lowpass'; lp.frequency.value = 3200;
		fb = ac.createGain(); fb.gain.value = FB;
		delSend = ac.createGain(); delRet = ac.createGain();
		chain(bus, delSend, dl, lp, fb, dl);
		chain(lp, delRet, master);
		setFx();
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
	const revIn = pad.querySelector('[data-fx="reverb"]'), delIn = pad.querySelector('[data-fx="delay"]');
	function setFx() {
		if (!ac) return;
		revSend.gain.setTargetAtTime(revIn.value * 0.7, ac.currentTime, 0.02);
		delSend.gain.setTargetAtTime(delIn.value * 0.6, ac.currentTime, 0.02);
	}
	revIn.addEventListener('input', setFx);
	delIn.addEventListener('input', setFx);
	pad.querySelector('.pad__cut').addEventListener('click', () => {
		revIn.value = 0; delIn.value = 0;
		if (!ac) return;
		const t = ac.currentTime;
		for (const g of [revSend, delSend, revRet, delRet, fb]) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.01); }
		// tails are dead; bring the returns back so the sliders work again
		for (const g of [revRet, delRet]) g.gain.setTargetAtTime(1, t + 0.25, 0.01);
		fb.gain.setTargetAtTime(FB, t + 0.25, 0.01);
	});

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
		chain(src, g, bus);
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
	function knob(el, { min, max, step, value, onInput }) {
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
			e.preventDefault(); e.stopPropagation(); set(value + d * step);
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
		let bpm = 120, running = false, timer = 0, next = 0, beat = 0, clicks = null, gain = null;
		const show = () => { out.textContent = bpm.toFixed(1); };
		const setBpm = v => { bpm = Math.min(300, Math.max(30, +v.toFixed(1))); show(); coarse.set(Math.floor(bpm), false); fine.set(+(bpm % 1).toFixed(1), false); };
		const coarse = knob(box.querySelector('[data-knob="coarse"]'), { min: 30, max: 300, step: 1, value: 120, onInput: v => { bpm = v + fine.get(); show(); } });
		const fine = knob(box.querySelector('[data-knob="fine"]'), { min: 0, max: 0.9, step: 0.1, value: 0, onInput: v => { bpm = coarse.get() + v; show(); } });
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
				next += 60 / bpm; beat++;
			}
		}
		async function start() {
			audio(); if (ac.state === 'suspended') await ac.resume();
			clicks ||= await makeClicks();
			if (!gain) { gain = ac.createGain(); gain.gain.value = 0.5; gain.connect(master); }
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
		return { stop, get bpm() { return bpm; } };
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
		setTimeout(showLatency, 400); // outputLatency is only known once audio is actually flowing
	}));
	rig.querySelector('.rig__close').addEventListener('click', () => rig.close());
	rig.addEventListener('click', e => { if (e.target === rig) rig.close(); }); // tap the backdrop to close
	rig.addEventListener('close', () => { window.wiggler?.stop(); metro.stop(); });

	// Keyboard: 1-4 / Q-R / A-F / Z-V, but only while the popup is open.
	addEventListener('keydown', e => {
		if (!rig.open || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
		const i = KEYS.indexOf(e.code);
		if (i < 0) return;
		e.preventDefault();
		hit(i);
	});
})();
