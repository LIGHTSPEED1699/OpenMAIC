# Abogen narration — one real end-to-end run (evidence)

Captured 2026-09-10 from PR branch commit `84efa508`, running the **production
standalone build** (`npm run build` → `node .next/standalone/server.js`) on the
machine that has the local Abogen service, with a real `POST
/api/generate-classroom` request carrying `enableNarration: true`.

Request (the only meaningful difference from a normal generation):

```json
{
  "requirement": "Create a beginner classroom on Ohm's Law ... Produce 3 scenes. Teach the entire course in English (en-US).",
  "language": "en-US",
  "agentMode": "default",
  "enableNarration": true,
  "enableImageGeneration": false,
  "enableVideoGeneration": false,
  "enableTTS": false
}
```

Result: job `jZob1kfr67` → classroom `R1tJBM1l0T` (*Ohm's Law: V, I, and R*),
3 scenes, `narrationUrl` stamped on all 3.

## Files

| file | what it shows |
| --- | --- |
| `pipeline-job-poll.log` | job lifecycle: queued → generating scenes → `generating_narration` (progress 99) → completed |
| `server-narration-phase.log` | server log: the narration phase and the `narration_pipeline.py` stdout it execFile'd (one Abogen job id per scene, `narration wired for 3/3 scenes`) |
| `artifacts.txt` | `narrationUrl` stamps per scene, on-disk M4Bs, moov atom inside the first 4096 bytes, served headers (`audio/mp4`, `Cache-Control: no-store`), and each Abogen job correlated by id (`Completed`, download bytes == file bytes) |
| `playback-with-narration.png` | playback screenshot taken while the scene-01 narration element was playing (2.7 s in, `paused: false`) |
| `playback-check.log`, `narration-check.json` | browser-side checks (headless Chromium, `new Audio` wrapped so the detached narration element is observable) |
| `01-narration-playing.png`, `03-paused.png`, `04-resumed.png` | the same run at the playing / paused / resumed checkpoints |

## What the browser run asserted

- the scene-01 narration element loads `…/media/scene-01.m4b` (HTTP 200,
  `audio/mp4`, `no-store`) and **plays**: `currentTime` 0.69 → 3.19,
  `duration` 120.3, `readyState` 4
- **mute** → narration `volume` 0 while still advancing; unmute → 1
- **pause** → narration pauses in place (5.675 → 5.726, `paused: true`)
- **resume** → continues from where it stopped, does not restart
