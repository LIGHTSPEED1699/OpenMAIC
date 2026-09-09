# Generate Flow

## Preconditions

- Repo path is confirmed
- Startup mode has been chosen
- OpenMAIC is healthy at the selected `url`
- Provider keys are configured

> **Live Demo mode**: If using the OpenMAIC Live Demo (open.maic.chat), all
> preconditions (repo, startup, provider keys) are already satisfied.
> Include `Authorization: Bearer <access-code>` header on all requests below.
> See [live-demo.md](live-demo.md) for details.

## Requirement-Only Generation

If the user has already clearly asked to generate the classroom and the preconditions are satisfied, submit the generation job immediately. Do not ask for a second confirmation just before calling `/api/generate-classroom`.

Submit the job with:

```text
POST {url}/api/generate-classroom
```

Request body:

```json
{
  "requirement": "Create an introductory classroom on quantum mechanics for high school students"
}
```

Only send supported content fields:

- `requirement` (required)
- optional `pdfContent`
- optional `language` (`"zh-CN"` | `"en-US"`, defaults to `"zh-CN"`) — any other value silently falls back to `"zh-CN"`
- optional `enableWebSearch` (boolean) — include web search context in outline generation
- optional `enableImageGeneration` (boolean) — allow image generation metadata in outlines
- optional `enableVideoGeneration` (boolean) — allow video generation metadata in outlines
- optional `enableTTS` (boolean) — enable server-side TTS audio generation for speech actions
- optional `enableNarration` (boolean) — after generation, synthesize per-scene M4B narration via the local **Abogen** service and wire it in as scene-level `narrationUrl` (see "Narration Wiring" below). Best-effort: a down Abogen or a script failure logs a warning and does not fail the job.
- optional `agentMode` (`"default"` | `"generate"`) — controls agent profile strategy:
  - `"default"` (or omitted): uses built-in default agents
  - `"generate"`: uses LLM to generate custom agent profiles tailored to the course content

All optional boolean fields default to `false` when omitted. Omitting them preserves backward compatibility.

### Feature Detection

Before sending optional feature flags, query `GET {url}/api/health` and check the `capabilities` object:

```json
{
  "status": "ok",
  "version": "...",
  "capabilities": {
    "webSearch": true,
    "imageGeneration": false,
    "videoGeneration": false,
    "tts": true
  }
}
```

Only set a feature flag to `true` if the corresponding capability is `true`. If the server does not return `capabilities` (older version), do not send the new fields.

Do not rely on request-time model or provider override parameters.

Treat the `POST` response as job submission only. Expect fields such as:

```json
{
  "success": true,
  "jobId": "abc123",
  "status": "queued",
  "step": "queued",
  "pollUrl": "http://localhost:3000/api/generate-classroom/abc123",
  "pollIntervalMs": 5000
}
```

## PDF-Based Generation

1. Resolve the absolute path to the PDF.
2. Confirm before reading the file.
3. Parse the PDF first:

```text
POST {url}/api/parse-pdf
```

4. Then send `requirement` plus `pdfContent` to:

```text
POST {url}/api/generate-classroom
```

## Polling Loop

After the job is submitted:

1. Save `jobId`, `pollUrl`, and `pollIntervalMs`.
2. Do not submit another generation job while this one is still `queued` or `running`.
3. Poll:

```text
GET {pollUrl}
```

4. Prefer a conservative polling cadence of about 60 seconds between polls for classroom generation jobs, even if `pollIntervalMs` is shorter.
5. Treat `queued` and `running` as in-progress states.
6. Stop only when `status` becomes `succeeded` or `failed`.

### Reliability Rules

- Never restart the job just because a poll request fails once.
- If a poll request returns a transient network error or `5xx`, wait about 60 seconds and retry the same `pollUrl`.
- If the job is still running after many polls, tell the user it is still in progress and continue polling instead of resubmitting.
- Prefer fewer poll attempts over aggressive polling. Long-running jobs are more likely to survive agent-loop limits if the tool-call cadence stays low.
- Within a single agent turn, cap active polling to about 10 minutes. If the job is still not finished, tell the user it is still running and include the `jobId` and `pollUrl` so a later turn can continue checking without resubmitting.
- Report progress to the user only when `status`, `step`, or visible progress meaningfully changes. Do not spam every poll result.
- Do not try to recover from auth, provider, model, or base URL errors by changing request parameters. Tell the user to fix OpenMAIC server-side config and retry only after they confirm.
- On `failed`, surface the server error and include the `jobId`.
- On `succeeded`, use `result.classroomId` and `result.url` from the final poll response.

## If The Loop Ends First

If the job is still running when you stop active polling for this turn, tell the user that the classroom generation is still running in the background and invite them to come back a little later to continue checking the same job.

Use natural phrasing such as:

```text
The classroom generation is still running in the background.
Job ID: abc123

Check back with me in a little while and I can continue tracking this same job without starting over.
```

## What To Return

Return the generated classroom ID plus a directly clickable classroom URL.

Output the URL as a raw absolute URL on its own line.

Do not wrap the URL in:

- bold markers such as `**...**`
- markdown links such as `[title](url)`
- code formatting such as `` `...` ``
- angle brackets such as `<...>`
- markdown tables

Use a compact format like:

```text
Classroom ID: Uyh82Y32ZK
Classroom URL:
http://localhost:3001/classroom/Uyh82Y32ZK
```

If the job fails, return the job ID plus the server error.

If generation fails, surface the server error directly instead of paraphrasing it away.

If the error suggests a provider or model configuration problem, explicitly tell the user to update `.env.local` or `server-providers.yml` instead of attempting a runtime override.

## Narration Wiring (Abogen audio)

OpenMAIC's built-in TTS is often disabled (health shows `"tts": false`). To give a
generated classroom voiceover, generate per-scene audio with a local **Abogen**
service (Kokoro TTS, e.g. `http://localhost:8808`) and wire it in as scene-level
narration.

### Automatic (recommended)

Set `enableNarration: true` in the generation request. After the classroom is
persisted, the server runs the repo's narration script
(`scripts/narration_pipeline.py <classroomId> <classroomsDir>` — path
overridable via `NARRATION_PIPELINE_SCRIPT`) which extracts each scene's speech
text, synthesizes one M4B per scene via Abogen, copies it into the classroom
media dir, stamps `scenes[i].narrationUrl`, and re-persists the JSON. The job
reports `generating_narration` at 99% while this runs, and only reports
`succeeded` once narration is wired. Best-effort: a down Abogen or script
failure logs a warning and the job still succeeds (without narration).

### Manual (fallback)

If `enableNarration` is not available (older codebase) or you want to wire
pre-generated M4Bs:

1. **Extract scene scripts.** Each scene's speech text lives in the classroom
   JSON at `<classroomsDir>/<id>.json` under `scenes[].actions[]` where
   `type === 'speech'`. Write one `.txt` per scene (concatenate its speech
   actions) into a scratch dir.

2. **Generate audio via Abogen.** Use the Abogen `/wizard/text` →
   `/wizard/finish` flow to produce one M4B per scene (the pipeline script
   shows the exact request shape). Default voice `bm_george` (British male,
   good for technical math). Output lands under Abogen's configured output
   dir.

3. **Wire narration into the classroom.** `scripts/narration_pipeline.py` does
   this end to end; to wire pre-generated files instead, copy each M4B into the
   classroom media dir and stamp `scenes[i].narrationUrl` with the relative
   `/api/classroom-media/<id>/media/scene-NN.m4b` path, then rewrite the JSON.

4. **Rebuild + restart.** `cd <repo> && pnpm build` (or `npm run build`), then
   restart the server process.

### CRITICAL: the build wipes classroom data

`next build` regenerates `.next/` and **deletes** the stored classroom JSON and
media that live under `.next/standalone/` when serving from the standalone
build. If your deployment keeps classroom data inside the build output, back up
the classroom JSON (and `media/`) before any rebuild and restore it after.

### Verify

- `curl -s -o /dev/null -w "%{http_code} %{content_type}" \
  http://localhost:3000/api/classroom-media/<id>/media/scene-01.m4b` → `200 audio/mp4`.
- Open the classroom, start playback: each scene's M4B plays as voiceover on a
  dedicated element (separate from per-line speech). Speech text still shows and
  advances on the reading timer.

### CRITICAL: incomplete M4B (silent narration) — the #2 gotcha

Abogen encodes with `ffmpeg -movflags +faststart`, so the `moov` atom is written
**last**. If the pipeline copies the `.m4b` the moment the file *appears*, it
copies a mid-write, truncated file that has NO `moov` atom. Browsers cannot
decode an M4A/AAC stream without `moov`, so the classroom is **silent on every
machine** (server and clients alike) even though:
- the stream returns `200`
- `Content-Length` is present
- `file` reports `ISO Media, Apple iTunes ALAC/AAC-LC (.M4A) Audio`
- `ffprobe` fails with `moov atom not found`

The pipeline downloads each scene's finished audio from the job-scoped endpoint
(`GET /jobs/<id>/download/audio`, only served once the Abogen job is
COMPLETED), which guarantees a fully-encoded file, and additionally checks for
`moov` in the bytes before stamping the narration URL. If narration is already
wired but silent, re-run the pipeline (it's idempotent — re-downloads valid
M4Bs).

### CRITICAL: browser caches the corrupt M4B (silent on clients, works on server)

Because the narration URL is stable (`/api/classroom-media/<id>/media/scene-NN.m4b`),
a client that fetched a corrupt file could cache it under that URL and keep
playing the stale silent bytes. The media route therefore sends
`Cache-Control: no-store` for narration files (`.m4a`/`.m4b`) so they are never
cached; immutable media (images, videos) keeps long-lived cache headers.
Clients that already cached a corrupt file must hard-refresh (Ctrl+Shift+R)
once to drop it.

### Combination with per-line TTS

Narration is scene-level voiceover that plays in addition to the action loop. If
`enableTTS` is also enabled, the per-line speech audio and the scene narration
play at the same time. They are designed to be alternatives: enable
`enableNarration` for voiceover (TTS off), or keep `enableTTS` for per-line
speech (narration off).

## Confirmation Requirements

- Ask before reading a local PDF.
- Do not ask for a second confirmation before the generation request if the user has already clearly asked you to generate the classroom.
