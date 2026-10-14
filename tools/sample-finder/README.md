# sample finder

Finds sample-worthy bits in a track and cuts them out as labeled WAV clips.

```
pip install -r requirements.txt
python sample_finder.py song.wav            # clips + samples.csv/json -> song_samples/
python sample_finder.py song.mp3 --debug    # also prints where the thresholds sit
python sample_finder.py song.wav --only drum_break,loop
```

| label | what it means |
|---|---|
| `drum_break` | drums carry it, nothing pitched on top (bass can still be there) |
| `instrument_solo` | 4 s+ of a non-vocal lead line sitting on top of the mix |
| `melodic_run` | fast notes, 4.5+ note changes per second |
| `vocal_phrase` / `vocal_chop` | lead line with vibrato; chop if under 1.5 s |
| `lead_chop` | short pitched bit on top, not enough vibrato to say voice vs instrument |
| `vocal_slice` | every vocal phrase/chop and lead chop also cut into single-note one-shots, named by pitch (`01_A4.wav`) in a `*_slices/` folder next to the parent clip. Cuts land mid-glide on note changes and in level dips between syllables. Skip with `--no-slices` |
| `one_shot` | a single hit with clean air before and after (`drum_hit` / `tonal_hit`) |
| `loop` | 1, 2 or 4 bars that repeat in the very next window, cut on the beat |

Clips overlap on purpose (a run inside a solo gets its own clip). Loops have no fades so the seam stays tight; everything else gets 5 ms fades.

## Why the old spike detector came up empty

Onset spikes last about 45 ms (run `--debug` to see it on your track), so a rule like "stay above threshold for 2 s" can never fire. This version looks at onset *density* and percussive/harmonic *ratios* smoothed over 1–2 s windows, and sets thresholds from the track's own percentiles instead of fixed loudness.

## How it decides

- **Lead line**: harmonic part (short HPSS kernel so fast runs survive), high-passed at 300 Hz so the bass doesn't hijack the pitch, then harmonic-salience pitch between E3 and E7. A frame counts as "lead" when that pitch is 1.6x+ stronger than any unrelated pitch (chords and pads sit around 1.0–1.4).
- **Voice vs instrument**: pyin pitch wobble inside held notes. 0.12 semitones or more reads as vibrato, so vocal. Heavy-vibrato sax or violin can get called a vocal, and a dead-straight singer can land in `lead_chop`.
- **Tuning knobs**: `LEAD_DOM` and `VOCAL_WOBBLE` at the top of the detectors, `thresh` in `find_loops` (0.85 correlation).

Assumes 4/4 for bar lengths. Pyin is the slow part, roughly 1/3 of the track's length on a laptop-ish CPU.

## Test track

`python make_test_track.py` builds a 65 s synthetic track with a known break, sung phrases and chops, a sax-ish solo with three runs, four one-shots and a 2-bar loop, plus `test_track_truth.json` as the answer key.
