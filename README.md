# PitchMatch

Sing-back ear training. The app plays a note; you sing it back; it tells you exactly where you landed.

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
