#!/usr/bin/env python3
"""Build a synthetic test track with known sample-worthy sections.

Writes test_track.wav plus test_track_truth.json (what's where), so
sample_finder.py can be checked against an answer key.

Layout at 96 BPM (1 bar = 2.5 s):
   0.0 - 5.0   pad chords, no drums        (nothing to grab, really)
   5.0 - 15.0  drum break, 4 bars          (drum_break)
  15.0 - 25.0  sung phrases + chops        (vocal_phrase / vocal_chop)
  25.0 - 37.5  sax-ish solo over drums     (instrument_solo, melodic_run)
  37.5 - 45.0  isolated hits               (one_shot)
  45.0 - 65.0  2-bar groove repeated x4    (loop)
"""
import json
import sys

import numpy as np
import soundfile as sf
from scipy import signal

SR = 22050
BPM = 96
BEAT = 60 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(7)


def midi_hz(m):
    return 440.0 * 2 ** ((np.asarray(m, dtype=float) - 69) / 12)


def env(n, attack=0.005, decay=0.2):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-t / decay)


def lowpass(x, hz, order=2):
    b, a = signal.butter(order, hz / (SR / 2), "low")
    return signal.lfilter(b, a, x)


def bandpass(x, lo, hi, order=2):
    b, a = signal.butter(order, [lo / (SR / 2), hi / (SR / 2)], "band")
    return signal.lfilter(b, a, x)


def saw_from_f0(f0):
    phase = np.cumsum(f0) / SR
    return 2 * (phase % 1.0) - 1


# ---- drums -----------------------------------------------------------------
def kick():
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    f = 45 + 80 * np.exp(-t / 0.03)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.001, 0.18)
    x[:40] += rng.normal(0, 0.3, 40)
    return x


def snare():
    n = int(0.25 * SR)
    noise = bandpass(rng.normal(0, 1, n), 1500, 7000) * env(n, 0.001, 0.08)
    tone = np.sin(2 * np.pi * 190 * np.arange(n) / SR) * env(n, 0.001, 0.05)
    return 0.7 * noise + 0.5 * tone


def hat(open_=False):
    n = int((0.25 if open_ else 0.06) * SR)
    b, a = signal.butter(2, 7000 / (SR / 2), "high")
    return signal.lfilter(b, a, rng.normal(0, 1, n)) * env(n, 0.001, 0.09 if open_ else 0.02) * 0.35


KICK, SNARE, HAT, OHAT = kick(), snare(), hat(), hat(True)


def place(buf, x, t, gain=1.0):
    i = int(round(t * SR))
    j = min(len(buf), i + len(x))
    if j > i:
        buf[i:j] += gain * x[: j - i]


def drum_bar(buf, t0, pattern, gain=1.0):
    """pattern: dict of instrument -> list of 16th-note steps."""
    s16 = BEAT / 4
    for inst, steps in pattern.items():
        smp = {"k": KICK, "s": SNARE, "h": HAT, "o": OHAT}[inst]
        for s in steps:
            place(buf, smp, t0 + s * s16, gain)


FUNKY = {"k": [0, 3, 10], "s": [4, 12], "h": [0, 2, 4, 6, 8, 10, 12, 14], "o": [7]}
FUNKY2 = {"k": [0, 3, 9, 10], "s": [4, 12, 15], "h": [0, 2, 4, 6, 8, 10, 12, 14]}
FILL = {"k": [0, 3], "s": [4, 8, 10, 11, 12, 13, 14, 15], "h": [0, 2, 4, 6]}
SIMPLE = {"k": [0, 8], "s": [4, 12], "h": [0, 2, 4, 6, 8, 10, 12, 14]}


# ---- tonal stuff -------------------------------------------------------------
def pad(buf, t0, dur, notes, gain=0.12):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for m in notes:
        for det in (-0.08, 0.08):
            x += saw_from_f0(np.full(n, midi_hz(m + det)))
    x = lowpass(x, 1200) * np.clip(t / 0.4, 0, 1) * np.clip((dur - t) / 0.3, 0, 1)
    place(buf, x, t0, gain / len(notes))


def bass(buf, t0, dur, m, gain=0.35):
    n = int(dur * SR)
    x = lowpass(saw_from_f0(np.full(n, midi_hz(m))), 400) * env(n, 0.005, dur * 0.8)
    place(buf, x, t0, gain)


FORMANTS = {"a": (800, 1150, 2900), "o": (450, 800, 2830), "e": (400, 2000, 2550), "u": (325, 700, 2530)}


def sung(buf, t0, notes, vowel="a", gain=0.5):
    """notes: list of (midi, seconds). Portamento, vibrato, breath."""
    total = sum(d for _, d in notes)
    n = int(total * SR)
    t = np.arange(n) / SR
    midi = np.zeros(n)
    i = 0
    prev = notes[0][0]
    for m, d in notes:
        k = int(d * SR)
        glide = min(int(0.08 * SR), k)
        seg = np.full(k, float(m))
        seg[:glide] = np.linspace(prev, m, glide)
        # vibrato fades in after 150 ms of each note
        tt = np.arange(k) / SR
        depth = 0.35 * np.clip((tt - 0.15) / 0.2, 0, 1)
        seg += depth * np.sin(2 * np.pi * 5.6 * tt)
        midi[i : i + k] = seg[: n - i]
        i += k
        prev = m
    f0 = midi_hz(midi) * (1 + 0.003 * rng.normal(0, 1, n).cumsum() / np.sqrt(np.arange(1, n + 1)))
    src = saw_from_f0(f0) + 0.08 * rng.normal(0, 1, n)
    out = np.zeros(n)
    for f, g in zip(FORMANTS[vowel], (1.0, 0.6, 0.25)):
        out += g * bandpass(src, f * 0.85, f * 1.15)
    shape = np.clip(t / 0.04, 0, 1) * np.clip((total - t) / 0.08, 0, 1)
    place(buf, out * shape, t0, gain)


def sax(buf, t0, notes, gain=0.4):
    """notes: list of (midi, seconds). Hard pitch steps, small vibrato only on long notes."""
    for m, d in notes:
        n = int(d * SR)
        tt = np.arange(n) / SR
        vib = 0.08 * np.sin(2 * np.pi * 4.5 * tt) * (d > 0.6)
        f0 = midi_hz(m + vib)
        x = 0.6 * saw_from_f0(f0) + 0.4 * np.sign(np.sin(2 * np.pi * np.cumsum(f0) / SR))
        x = lowpass(x, 2500) * np.clip(tt / 0.01, 0, 1) * np.clip((d - tt) / 0.015, 0, 1)
        place(buf, x, t0, gain)
        t0 += d


def stab(buf, t0, notes, gain=0.3):
    n = int(0.6 * SR)
    x = sum(saw_from_f0(np.full(n, midi_hz(m))) for m in notes) / len(notes)
    place(buf, lowpass(x, 3000) * env(n, 0.003, 0.12), t0, gain)


def pluck(buf, t0, m, gain=0.4):
    n = int(1.0 * SR)
    t = np.arange(n) / SR
    x = sum(np.sin(2 * np.pi * midi_hz(m) * k * t) / k ** 1.5 for k in range(1, 6))
    place(buf, x * env(n, 0.002, 0.25), t0, gain)


def build():
    dur = 65.0
    buf = np.zeros(int(dur * SR) + SR)
    truth = []

    # 0-5: pad intro
    pad(buf, 0.0, 2.5, [57, 60, 64])
    pad(buf, 2.5, 2.5, [53, 57, 60])

    # 5-15: drum break
    for i, pat in enumerate([FUNKY, FUNKY2, FUNKY, FILL]):
        drum_bar(buf, 5.0 + i * BAR, pat)
    truth.append({"label": "drum_break", "start": 5.0, "end": 15.0})

    # 15-25: vocals over quiet pad
    pad(buf, 15.0, 10.0, [57, 60, 64], gain=0.05)
    sung(buf, 15.2, [(69, 0.6), (72, 0.5), (74, 1.2), (72, 0.7)], "a")       # 3.0 s phrase
    truth.append({"label": "vocal_phrase", "start": 15.2, "end": 18.2})
    for t, notes, v in [(19.0, [(76, 0.45)], "o"), (19.9, [(74, 0.3), (72, 0.35)], "e"), (21.0, [(69, 0.5)], "u")]:
        sung(buf, t, notes, v)
        truth.append({"label": "vocal_chop", "start": t, "end": t + sum(d for _, d in notes)})
    sung(buf, 22.0, [(72, 0.5), (74, 0.5), (76, 1.0), (74, 0.4), (72, 0.8)], "o")  # 3.2 s
    truth.append({"label": "vocal_phrase", "start": 22.0, "end": 25.2})

    # 25-37.5: sax solo over drums + bass
    for i in range(5):
        drum_bar(buf, 25.0 + i * BAR, SIMPLE, gain=0.45)
        bass(buf, 25.0 + i * BAR, BEAT * 2, 45)
        bass(buf, 25.0 + i * BAR + 2 * BEAT, BEAT * 2, 43)
    s16 = BEAT / 4
    run_up = [(m, s16) for m in (69, 71, 72, 74, 76, 77, 79, 81)]
    run_dn = [(m, s16) for m in (84, 83, 81, 79, 77, 76, 74, 72)]
    solo = [(76, 1.0), (74, 0.5), (72, 0.75)] + run_up + [(84, 1.25), (81, 0.6)] + run_dn + \
           [(69, 1.0), (72, 0.5), (74, 0.5)] + run_up + [(81, 1.5)]
    sax(buf, 25.3, solo)
    solo_end = 25.3 + sum(d for _, d in solo)
    truth.append({"label": "instrument_solo", "start": 25.3, "end": solo_end})
    t = 25.3 + 2.25
    truth.append({"label": "melodic_run", "start": t, "end": t + 8 * s16})
    t += 8 * s16 + 1.85
    truth.append({"label": "melodic_run", "start": t, "end": t + 8 * s16})
    t += 8 * s16 + 2.0
    truth.append({"label": "melodic_run", "start": t, "end": t + 8 * s16})

    # 37.5-45: one-shots with air around them
    place(buf, KICK, 38.0)
    stab(buf, 39.5, [60, 64, 67, 70])
    place(buf, SNARE, 41.0)
    pluck(buf, 42.5, 64)
    for t0, ln in [(38.0, 0.35), (39.5, 0.6), (41.0, 0.25), (42.5, 1.0)]:
        truth.append({"label": "one_shot", "start": t0, "end": t0 + ln})

    # 45-65: 2-bar groove x4 (bit-exact repeat)
    g0 = 45.0
    tmp = np.zeros(int(2 * BAR * SR) + SR)
    drum_bar(tmp, 0, FUNKY, 0.8)
    drum_bar(tmp, BAR, FUNKY2, 0.8)
    for k, m in enumerate([45, 45, 48, 43]):
        bass(tmp, k * BAR / 2, BAR / 2 * 0.9, m)
    stab(tmp, BEAT * 1.5, [57, 60, 64], 0.2)
    stab(tmp, BAR + BEAT * 2.5, [55, 59, 62], 0.2)
    loop_len = int(round(2 * BAR * SR))
    tail = tmp[loop_len:].copy()
    tmp = tmp[:loop_len]
    tmp[: len(tail)] += tail  # wrap the ring-out so the loop is seamless
    for k in range(4):
        place(buf, tmp, g0 + k * 2 * BAR)
    truth.append({"label": "loop", "start": g0, "end": g0 + 8 * BAR, "loop_bars": 2})

    buf = buf[: int(dur * SR)]
    buf += rng.normal(0, 1e-4, len(buf))  # tiny noise floor, like a real file
    buf /= np.max(np.abs(buf)) * 1.12
    return buf, truth


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "test_track.wav"
    y, truth = build()
    sf.write(out, y, SR)
    with open(out.rsplit(".", 1)[0] + "_truth.json", "w") as f:
        json.dump({"bpm": BPM, "sections": truth}, f, indent=2)
    print(f"wrote {out} ({len(y) / SR:.1f}s) and truth json")
