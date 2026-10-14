#!/usr/bin/env python3
"""Find sample-worthy bits in a track and cut them out as labeled clips.

Labels:
  drum_break       drums carry the section, little else going on
  instrument_solo  long pitched lead line (non-vocal)
  melodic_run      fast run of notes (>= ~5 notes/sec)
  vocal_phrase     sung line (vibrato / glides), longer than ~1.5 s
  vocal_chop       short sung bit, good for chopping
  lead_chop        short pitched bit on top of the mix, no clear vibrato (voice or instrument)
  vocal_slice      every vocal/lead chop above, also cut into single-note one-shots
                   (named by pitch, in a *_slices/ folder next to the parent clip)
  one_shot         a single hit with clean air around it (drum_hit or tonal_hit)
  loop             1/2/4 bars that repeat in the very next window, so they loop clean

Usage:
  python sample_finder.py track.wav                 # clips -> track_samples/
  python sample_finder.py track.mp3 -o out --debug  # also prints threshold diagnostics

Why the old spike detector found nothing: onset spikes only last a few tens of
milliseconds (run --debug to see the numbers), so asking for a spike to stay above
threshold for whole seconds never fires. Everything here works on densities and
ratios smoothed over ~0.5-1 s windows, and every threshold is relative to the
track itself (percentiles), not a fixed loudness.
"""
import argparse
import csv
import json
import os
import sys

import librosa
import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import median_filter, uniform_filter1d

SR = 22050
HOP = 512
FT = HOP / SR  # seconds per frame (~23 ms)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def frames(sec):
    return max(1, int(round(sec / FT)))


def runs(mask):
    """(start, end) frame index pairs of True runs, end exclusive."""
    m = np.concatenate([[False], np.asarray(mask, bool), [False]])
    d = np.diff(m.astype(int))
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def segments(mask, min_dur, max_gap=0.0):
    """True-runs as (t0, t1) seconds, bridging gaps <= max_gap, dropping runs < min_dur."""
    out = []
    for a, b in runs(mask):
        if out and (a - out[-1][1]) * FT <= max_gap:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return [(a * FT, b * FT) for a, b in out if (b - a) * FT >= min_dur]


def fmt(t):
    return f"{int(t // 60):02d}m{t % 60:05.2f}s"


def db(x):
    return 20 * np.log10(np.maximum(x, 1e-9))


# ---------------------------------------------------------------------------
# analysis
# ---------------------------------------------------------------------------
def lead_line(yk, sr):
    """Loudest monophonic pitch above the bass, per frame, plus how much it stands out.

    Bass partials fool pyin and plain argmax pitch into following the bassline, so this
    high-passes at 300 Hz first and only looks for a lead between E3 and E7. `dom` is the
    lead's salience over the strongest pitch that isn't one of its own octaves/fifths:
    ~1 for chords, pads and drums, 2+ when one line sits on top (a vocal or a solo).
    """
    b, a = signal.butter(4, 300 / (sr / 2), "high")
    xh = signal.filtfilt(b, a, yk)
    nb = 216  # 6 octaves at 1/3 semitone
    C = np.abs(librosa.cqt(xh, sr=sr, hop_length=HOP, fmin=librosa.midi_to_hz(36), n_bins=nb, bins_per_octave=36))
    freqs = librosa.cqt_frequencies(nb, fmin=librosa.midi_to_hz(36), bins_per_octave=36)
    sal = librosa.salience(C, freqs=freqs, harmonics=[1, 2, 3, 4, 5], weights=[1, .8, .6, .5, .4], fill_value=0)
    midi = librosa.hz_to_midi(freqs)
    keep = (midi >= 52) & (midi <= 100)
    sal, midi = sal[keep], midi[keep]
    lead = midi[np.argmax(sal, axis=0)]
    pk = sal.max(axis=0)
    rel = midi[:, None] - lead[None, :]
    related = np.zeros_like(rel, dtype=bool)
    for o in (0, 12, 19, 24, -12, -19, -24):
        related |= np.abs(rel - o) <= 1.5
    other = np.where(related, 0, sal).max(axis=0)
    return xh, lead, pk, pk / (other + 1e-9)


def analyze(y, sr):
    yh, yp = librosa.effects.hpss(y, margin=2.0)
    # short harmonic kernel (~0.2 s) so 16th-note runs count as harmonic, not "neither"
    yk = librosa.effects.harmonic(y, kernel_size=(9, 31), margin=1.0)
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    rms_h = librosa.feature.rms(y=yh, hop_length=HOP)[0]
    rms_p = librosa.feature.rms(y=yp, hop_length=HOP)[0]
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, hop_length=HOP, backtrack=False, units="frames")
    xh, lead, pk, dom = lead_line(yk, sr)
    # pyin only for the fine pitch wiggle (vibrato) that tells a voice from an instrument
    f0, _, vprob = librosa.pyin(xh, fmin=80, fmax=1600, sr=sr, frame_length=2048, hop_length=HOP)
    n = min(len(rms), len(onset_env), len(f0), len(lead))
    tempo, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=HOP)
    return {
        "y": y, "yh": yh, "yp": yp,
        "rms": rms[:n], "rms_h": rms_h[:n], "rms_p": rms_p[:n],
        "onset_env": onset_env[:n], "onsets": onsets[onsets < n],
        "lead": lead[:n], "lead_pk": pk[:n], "lead_dom": dom[:n],
        "f0": f0[:n], "vprob": vprob[:n],
        "tempo": float(np.atleast_1d(tempo)[0]), "beats": beats[beats < n], "n": n,
    }


def debug_report(A):
    """The 'why did it find nothing' printout: how long do spikes really last?"""
    env = A["onset_env"]
    thr = np.percentile(env, 90)
    lens = np.array([(b - a) * FT * 1000 for a, b in runs(env > thr)])
    print("\n--- debug: onset spikes (top 10% of onset strength) ---")
    if len(lens):
        print(f"  {len(lens)} spikes, duration ms: median {np.median(lens):.0f}, "
              f"p90 {np.percentile(lens, 90):.0f}, max {lens.max():.0f}")
        print("  -> spikes are tens of ms long. A 'stay above threshold for N seconds' rule can't fire;")
        print("     this script measures onset DENSITY over ~1-2 s windows instead.")
    loud = A["rms"] > np.percentile(A["rms"], 20)
    pr = A["rms_p"] / (A["rms_p"] + A["rms_h"] + 1e-9)
    print(f"  percussive ratio over non-quiet frames: p25 {np.percentile(pr[loud], 25):.2f} "
          f"p50 {np.percentile(pr[loud], 50):.2f} p75 {np.percentile(pr[loud], 75):.2f}")
    dom = median_filter(A["lead_dom"], frames(0.3))
    print(f"  lead-line dominance: p50 {np.percentile(dom, 50):.2f} p90 {np.percentile(dom, 90):.2f} "
          f"(>= {LEAD_DOM} counts as a lead), {np.mean(dom >= LEAD_DOM) * 100:.0f}% of frames")
    print(f"  tempo estimate: {A['tempo']:.1f} BPM, {len(A['beats'])} beats, {len(A['onsets'])} onsets\n")


# ---------------------------------------------------------------------------
# detectors
# ---------------------------------------------------------------------------
LEAD_DOM = 1.6      # lead salience vs next unrelated pitch; chords/pads sit ~1.0-1.4
VOCAL_WOBBLE = 0.12  # semitones of in-note pitch wobble (vibrato) that reads as a voice


def find_breaks(A, min_dur=2.0):
    n = A["n"]
    w = frames(1.0)
    rms_p = uniform_filter1d(A["rms_p"], w)
    rms_h = uniform_filter1d(A["rms_h"], w)
    perc_ratio = rms_p / (rms_p + rms_h + 1e-9)
    onset_rate = uniform_filter1d(np.bincount(A["onsets"], minlength=n)[:n].astype(float), frames(2.0)) / FT
    # pitched stuff above the bass (chords, leads, vocals); kick-drum boom doesn't count
    tonal = uniform_filter1d(A["lead_pk"], w)

    sounding = A["rms"] > np.percentile(A["rms"], 15)
    pr_thr = float(np.clip(np.percentile(perc_ratio[sounding], 70), 0.3, 0.5))
    tonal_thr = 0.15 * np.percentile(A["lead_pk"], 95)
    mask = (perc_ratio >= pr_thr) & (onset_rate >= 2.0) & (tonal <= tonal_thr) & sounding
    mask = median_filter(mask.astype(int), frames(0.5)).astype(bool)
    out = []
    for t0, t1 in segments(mask, min_dur, max_gap=0.5):
        a, b = frames(t0), frames(t1)
        score = float(np.mean(perc_ratio[a:b]))
        out.append({"label": "drum_break", "start": t0, "end": t1, "score": round(score, 2),
                    "note": f"perc ratio {score:.2f}, {np.mean(onset_rate[a:b]):.1f} hits/s"})
    return out


def wobble_in_notes(lead, f0):
    """Median in-note pitch wobble (semitones) using pyin, over notes the lead tracker holds."""
    fm = librosa.hz_to_midi(np.where(np.isfinite(f0), f0, np.nan))
    vals = []
    for a, b in runs(np.concatenate([[False], np.abs(np.diff(lead)) < 1.0])):
        if b - a < frames(0.25):  # vibrato needs a held note; fast runs smear pyin
            continue
        seg = fm[a:b]
        seg = seg[np.isfinite(seg)]
        seg = seg[np.abs(seg - np.median(seg)) < 1.5] if len(seg) else seg
        if len(seg) >= 5:
            vals.append(float(np.std(seg - np.median(seg))))
    return float(np.median(vals)) if vals else 0.0


def find_pitched(A):
    """Vocals, solos and runs from the lead line."""
    dom = median_filter(A["lead_dom"], frames(0.3))
    lead_mask = (dom >= LEAD_DOM) & (A["lead_pk"] >= 0.25 * np.percentile(A["lead_pk"], 95))
    lead_mask = median_filter(lead_mask.astype(int), 3).astype(bool)
    lead = median_filter(A["lead"], 3)
    out, instr = [], []

    for t0, t1 in segments(lead_mask, 0.25, max_gap=0.15):
        a, b = frames(t0), frames(t1)
        if b - a < 8:
            continue
        wob = wobble_in_notes(lead[a:b], A["f0"][a:b])
        changes = np.concatenate([[0], np.abs(np.diff(np.round(lead[a:b]))) >= 1]).astype(float)
        notes = 1 + int(changes.sum())
        dur = t1 - t0
        note = f"vibrato {wob:.2f} st, {notes} notes"
        if wob >= VOCAL_WOBBLE:
            out.append({"label": "vocal_chop" if dur < 1.5 else "vocal_phrase", "start": t0, "end": t1,
                        "score": round(min(1.0, wob / (2 * VOCAL_WOBBLE)), 2), "note": note})
            continue
        instr.append((t0, t1, notes))
        # melodic runs: dense note changes inside a 0.8 s window
        rate = uniform_filter1d(changes, frames(0.8)) / FT
        for r0, r1 in segments(rate >= 4.5, 0.5, max_gap=0.15):
            ra, rb = frames(r0), frames(r1)
            # the 0.8 s rate window lags the first/last notes; give the clip some slack
            r0, r1 = max(0.0, r0 - 0.25), min(dur, r1 + 0.1)
            out.append({"label": "melodic_run", "start": t0 + r0, "end": t0 + r1,
                        "score": round(min(1.0, float(np.mean(rate[ra:rb])) / 8), 2),
                        "note": f"{np.mean(rate[ra:rb]):.1f} notes/s"})

    # solos: instrument phrases merged across short breaths, long enough to be a feature
    merged = []
    for t0, t1, nn in instr:
        if merged and t0 - merged[-1][1] <= 0.75:
            merged[-1] = (merged[-1][0], t1, merged[-1][2] + nn)
        else:
            merged.append((t0, t1, nn))
    for t0, t1, nn in merged:
        a, b = frames(t0), frames(t1)
        if t1 - t0 >= 4.0 and nn >= 6:
            cover = float(np.mean(lead_mask[a:b]))
            out.append({"label": "instrument_solo", "start": t0, "end": t1, "score": round(cover, 2),
                        "note": f"{nn} notes, lead on top {cover * 100:.0f}% of the time"})
        elif t1 - t0 <= 1.5:
            # a short lone pitched bit; too little vibrato to call it a voice, still choppable
            out.append({"label": "lead_chop", "start": t0, "end": t1,
                        "score": round(min(1.0, float(np.mean(dom[a:b])) / 5), 2) if b > a else 0.0,
                        "note": f"{nn} notes, vocal or instrument (no clear vibrato)"})
    return out


def find_one_shots(A, max_shots=25):
    n = A["n"]
    env = A["rms"]
    floor = np.percentile(env, 5)
    tonal_thr = 0.15 * np.percentile(A["lead_pk"], 95)
    on = sorted(set(A["onsets"].tolist()))
    out = []
    peaks = [float(env[o:o + frames(0.15)].max()) for o in on]
    for i, o in enumerate(on):
        pk = peaks[i]
        # the next onset that's actually another hit (not a wiggle in this one's decay)
        nxt = next((on[k] for k in range(i + 1, len(on)) if db(peaks[k]) > db(pk) - 15), n)
        if (nxt - o) * FT < 0.2:
            continue
        pk_i = o + int(np.argmax(env[o:min(nxt, o + frames(0.15))]))
        if pk < 4 * floor:
            continue
        # rms frames are ~90 ms wide, so the last couple of frames before an onset already
        # see the attack; look a bit earlier for "was something else still ringing"
        pre = env[max(0, o - frames(0.25)):max(1, o - 3)]
        if len(pre) and db(np.max(pre)) > db(pk) - 20:
            continue
        tail = env[pk_i:nxt]
        quiet = np.where(db(tail) < db(pk) - 30)[0]
        if not len(quiet):
            continue  # never dies down before the next thing hits
        a, b = max(0, o - 2), min(pk_i + quiet[0] + frames(0.03), nxt)
        if (b - a) * FT < 0.05:
            continue
        # pitched above the bass -> stab/pluck/note; otherwise a drum (808-ish kicks included)
        perc = float(np.sum(A["rms_p"][a:b]) / (np.sum(A["rms_p"][a:b] + A["rms_h"][a:b]) + 1e-9))
        tonal = np.max(A["lead_pk"][a:b]) > 2 * tonal_thr or perc < 0.2
        kind = "tonal_hit" if tonal else "drum_hit"
        clean = (db(pk) - db(np.max(pre) if len(pre) else floor)) / 60
        out.append({"label": "one_shot", "start": a * FT, "end": b * FT,
                    "score": round(float(min(1.0, clean)), 2), "note": kind})
    out.sort(key=lambda d: -d["score"])
    return sorted(out[:max_shots], key=lambda d: d["start"])


def find_loops(A, sr, bars_options=(1, 2, 4), thresh=0.85):
    beats = A["beats"]
    if len(beats) < 8:
        return []
    chroma = librosa.feature.chroma_cqt(y=A["yh"], sr=sr, hop_length=HOP)
    mfcc = librosa.feature.mfcc(y=A["y"], sr=sr, hop_length=HOP, n_mfcc=13)
    n = min(chroma.shape[1], mfcc.shape[1], A["n"])
    feat = np.vstack([chroma[:, :n], mfcc[1:, :n] / 20, A["onset_env"][None, :n] / (A["onset_env"].max() + 1e-9)])
    # 4 slices per beat so the groove (not just the harmony) has to match
    grid = np.unique(np.concatenate([np.linspace(beats[i], beats[i + 1], 5)[:-1] for i in range(len(beats) - 1)]).astype(int))
    sync = librosa.util.sync(feat, grid, aggregate=np.mean)
    sync = (sync - sync.mean(axis=1, keepdims=True)) / (sync.std(axis=1, keepdims=True) + 1e-9)
    per_beat = 4
    nbeats = len(beats)
    found = []
    for bars in bars_options:
        L = bars * 4  # beats, assuming 4/4
        for i in range(0, nbeats - 2 * L):
            w1 = sync[:, i * per_beat:(i + L) * per_beat].ravel()
            w2 = sync[:, (i + L) * per_beat:(i + 2 * L) * per_beat].ravel()
            if len(w1) != len(w2) or len(w1) == 0:
                continue
            r = float(np.corrcoef(w1, w2)[0, 1])
            if r >= thresh:
                found.append((i, bars, r))
    if not found:
        return []
    # grow repeating regions: a window that repeats next door marks [i, i+2L) as loopy
    out = []
    best_by_start = {}
    for i, bars, r in found:
        if i not in best_by_start or bars < best_by_start[i][0]:
            best_by_start[i] = (bars, r)
    starts = sorted(best_by_start)
    regions = []
    for i in starts:
        bars, r = best_by_start[i]
        end = i + 2 * bars * 4
        if regions and i <= regions[-1]["end_beat"]:
            reg = regions[-1]
            reg["end_beat"] = max(reg["end_beat"], end)
            reg["hits"].append((i, bars, r))
        else:
            regions.append({"start_beat": i, "end_beat": end, "hits": [(i, bars, r)]})
    for reg in regions:
        # the clip: the strongest window, snapped to a downbeat-ish beat (multiple of 4 from region start)
        best = max(h[2] for h in reg["hits"])
        i, bars, r = min((h for h in reg["hits"] if h[2] >= best - 0.03), key=lambda h: (h[1], h[0]))
        s, e = beats[i], beats[min(i + bars * 4, nbeats - 1)]
        span = (beats[min(reg["end_beat"], nbeats - 1)] - beats[reg["start_beat"]]) * FT
        out.append({"label": "loop", "start": s * FT, "end": e * FT, "score": round(r, 2),
                    "note": f"{bars} bar(s) @ {A['tempo']:.0f} BPM, repeats over {span:.1f}s"})
    return out


VOCAL_LABELS = ("vocal_phrase", "vocal_chop", "lead_chop")


def slice_vocal(A, t0, t1, min_len=0.1):
    """Chop a vocal into single-note/syllable one-shots: cut where the note changes
    (held >= 80 ms) or where the level dips between syllables."""
    a, b = frames(t0), frames(t1)
    if b - a < 3:
        return []
    note = np.round(median_filter(A["lead"], 3)[a:b])
    cuts = set()
    # note changes between stably held notes, cut in the middle of the glide
    held = [(r0, r1, note[r0]) for r0, r1 in runs(np.concatenate([[True], np.diff(note) == 0]))]
    held = [h for h in held if h[1] - h[0] >= frames(0.08)]
    for (p0, p1, pn), (n0, n1, nn) in zip(held, held[1:]):
        if pn != nn:
            cuts.add((p1 + n0) // 2)
    # level dips between syllables (6 dB+ under the peaks on both sides)
    lvl = uniform_filter1d(A["rms_h"][a:b], 3)
    w = frames(0.2)
    for i in range(1, len(lvl) - 1):
        if lvl[i] <= lvl[i - 1] and lvl[i] <= lvl[i + 1]:
            left, right = lvl[max(0, i - w):i].max(), lvl[i + 1:i + 1 + w].max()
            if lvl[i] < 0.5 * min(left, right):
                cuts.add(i)
    edges = [0] + sorted(cuts) + [b - a]
    # merge slivers into the previous slice
    keep = [edges[0]]
    for e in edges[1:]:
        if (e - keep[-1]) * FT < min_len and len(keep) > 1:
            keep[-1] = e
        elif (e - keep[-1]) * FT >= min_len or e == edges[-1]:
            keep.append(e)
    if len(keep) > 2 and (keep[-1] - keep[-2]) * FT < min_len:
        del keep[-2]
    out = []
    for s0, s1 in zip(keep, keep[1:]):
        if (s1 - s0) * FT < min_len:
            continue
        mid = note[s0 + (s1 - s0) // 4: s1 - (s1 - s0) // 4 or s1]
        pitch = librosa.midi_to_note(int(np.median(mid if len(mid) else note[s0:s1])), unicode=False)
        out.append({"start": round(t0 + s0 * FT, 3), "end": round(t0 + s1 * FT, 3), "pitch": pitch})
    return out


# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------
def export(y, sr, items, out_dir, stem):
    os.makedirs(out_dir, exist_ok=True)
    for k, it in enumerate(items, 1):
        a, b = int(it["start"] * sr), int(it["end"] * sr)
        clip = y[a:b].copy()
        if it["label"] != "loop":  # loops are cut on the beat; fades would put a dip at the seam
            f = min(int(0.005 * sr), len(clip) // 4)
            if f > 1:
                clip[:f] *= np.linspace(0, 1, f)
                clip[-f:] *= np.linspace(1, 0, f)
        name = f"{k:03d}_{it['label']}_{fmt(it['start'])}-{fmt(it['end'])}.wav"
        sf.write(os.path.join(out_dir, name), clip, sr)
        it["file"] = name
        if it.get("slices"):
            sub = name[:-4] + "_slices"
            os.makedirs(os.path.join(out_dir, sub), exist_ok=True)
            for j, sl in enumerate(it["slices"], 1):
                c = y[int(sl["start"] * sr):int(sl["end"] * sr)].copy()
                f = min(int(0.008 * sr), len(c) // 4)
                if f > 1:
                    c[:f] *= np.linspace(0, 1, f)
                    c[-f:] *= np.linspace(1, 0, f)
                sl["file"] = f"{sub}/{j:02d}_{sl['pitch']}.wav"
                sf.write(os.path.join(out_dir, sl["file"]), c, sr)
    with open(os.path.join(out_dir, "samples.json"), "w") as fh:
        json.dump({"track": stem, "samples": items}, fh, indent=2)
    with open(os.path.join(out_dir, "samples.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["file", "label", "start", "end", "duration", "score", "note"])
        w.writeheader()
        for it in items:
            w.writerow({**{k: it[k] for k in ("file", "label", "score", "note")},
                        "start": f"{it['start']:.2f}", "end": f"{it['end']:.2f}",
                        "duration": f"{it['end'] - it['start']:.2f}"})
            for sl in it.get("slices", []):
                w.writerow({"file": sl["file"], "label": "vocal_slice", "score": "", "note": sl["pitch"],
                            "start": f"{sl['start']:.2f}", "end": f"{sl['end']:.2f}",
                            "duration": f"{sl['end'] - sl['start']:.2f}"})


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("audio")
    p.add_argument("-o", "--out", help="output folder (default: <track>_samples)")
    p.add_argument("--only", help="comma list of labels to keep, e.g. drum_break,loop")
    p.add_argument("--no-clips", action="store_true", help="just print, don't write wavs")
    p.add_argument("--no-slices", action="store_true", help="don't chop vocals into one-shot slices")
    p.add_argument("--debug", action="store_true", help="print threshold diagnostics")
    args = p.parse_args(argv)

    y, sr = librosa.load(args.audio, sr=SR, mono=True)
    print(f"loaded {args.audio}: {len(y) / sr:.1f}s")
    A = analyze(y, sr)
    if args.debug:
        debug_report(A)

    shots = find_one_shots(A)
    pitched = [p for p in find_pitched(A)  # a plucked one-shot isn't also a lead chop
               if p["label"] != "lead_chop" or not any(s["start"] < p["end"] and p["start"] < s["end"] for s in shots)]
    items = find_breaks(A) + pitched + shots + find_loops(A, sr)
    if args.only:
        keep = set(args.only.split(","))
        items = [i for i in items if i["label"] in keep]
    items.sort(key=lambda d: (d["start"], d["label"]))
    for it in items:
        it["start"], it["end"] = round(it["start"], 3), round(it["end"], 3)
        if it["label"] in VOCAL_LABELS and not args.no_slices:
            it["slices"] = slice_vocal(A, it["start"], it["end"])

    for it in items:
        print(f"  {fmt(it['start'])} - {fmt(it['end'])}  {it['label']:<16} {it['score']:<5} {it['note']}")
        if it.get("slices"):
            print(f"      -> {len(it['slices'])} one-shot slices: " + " ".join(sl["pitch"] for sl in it["slices"]))
    if not items:
        print("  nothing found; try --debug to see where the thresholds sit")
    if not args.no_clips and items:
        stem = os.path.splitext(os.path.basename(args.audio))[0]
        out_dir = args.out or f"{stem}_samples"
        export(y, sr, items, out_dir, stem)
        print(f"\n{len(items)} clips -> {out_dir}/ (samples.csv, samples.json)")


if __name__ == "__main__":
    sys.exit(main())
