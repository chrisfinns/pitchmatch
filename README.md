# PitchMatch

Sing-back ear training. The app plays a note; you sing it back; it tells you exactly where you landed.

## Practice mode

One note at a time, in a small range that widens as you improve.

1. **Home note.** On first run you sing any comfortable note; practice starts there.
2. **Find it.** The note plays (and replays whenever you go quiet). Sing and steer — the panel fades from red through amber to green. Hold green for 1.2 s. This is the only step where sliding is allowed.
3. **Land it.** Hear the note, then sing one short note cold. Green = landed, amber = right pitch but you scooped or wobbled, red = flat/sharp. The colour only appears after the note, so you can't steer into it.
4. A streak of clean landings (5 by default; 3–20 in Settings) makes a note solid and unlocks the next one — nearest to home, alternating above and below. Miss a new note three times running and you go back to finding it.
5. **Retention.** A streak right after hearing a note mostly proves short-term echo memory, so solid notes have to survive time: each one is checked cold at the start of every new day, and keeps returning as mixed review. Miss one twice and it's back in focus.

**Silence before you sing** (Settings → Memory, both modes) adds a 2–8 s silent gap after the reference, to train holding a pitch in your head.

Short sessions spread through the day work better than one long one.

## Test mode

- **Try 1 is blind.** No visual — just your ear. Miss it and the note replays for **try 2 with a live pitch analyzer**.
- **Scoop detection.** The first 250 ms of your note is judged separately from the sustain. Slide up (or down) into the pitch and it's a miss, even if you settle dead on.
- **Tight scoring.** Default window is ±25¢ held steady for 1 s; go down to ±10¢ in Settings.
- **Key mode (optional).** Plays a scale or I–IV–V–I cadence first, then a random note from that key. Off by default: one random note in your range.
- **Log.** First-try %, second-try saves, scoops, and a hardest → easiest table by note, exact pitch or scale degree, with your flat/sharp tendency per note. Stored in your browser only.

## Run / deploy

No build step — it's a static site.

```bash
npm run dev    # http://localhost:5173
npm test       # pitch detector + scoring tests
```

Deploy on Vercel: import the repo, framework preset **Other**, no build command. The mic needs HTTPS (Vercel provides it) or localhost.

## How the pitch analysis works

- Mic audio is taken raw (echo cancellation, noise suppression and auto-gain off — they bend pitch) and read in an AudioWorklet in fixed 512-sample hops.
- Pitch is YIN with parabolic refinement over a 2048-sample window: within ~1¢ on clean tones across the vocal range (`tests/core.test.mjs`).
- A note must start from silence to count, so humming along with the reference can't be scored.
- Verdict order: wrong octave → flat/sharp (median of the sustain) → scoop (onset vs. where you settled) → unsteady → hit.

## Piano samples

[Salamander Grand Piano V3](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Trimmed, shortened and re-encoded (via the [@audio-samples](https://github.com/darosh/samples-piano-mp3) npm packages); one sample every 3 semitones, C2–C6, ~600 KB.

Real piano strings are slightly out of 12-TET, so each sample is measured with the app's own detector and corrected at playback — the reference reads within 1¢ of the target on the same ruler that scores your voice. Falls back to a synth if samples can't load. Rebuild with `python3 tools/build_samples.py <download-dir>`.
