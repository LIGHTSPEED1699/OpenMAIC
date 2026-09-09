#!/usr/bin/env python3
"""Auto-narration pipeline for an OpenMAIC classroom.

Reads a persisted classroom JSON, synthesizes one M4B per scene via the local
Abogen service (Kokoro TTS), copies each M4B into the classroom media dir, and
stamps `scenes[i].narrationUrl` with the relative serving path. Re-persists the
JSON. Invoked by the OpenMAIC generation job when `enableNarration` is set.

Configuration (all optional):
  ABOGEN_URL        base URL of Abogen service       (default http://localhost:8808)
  ABOGEN_OUTPUT_DIR Abogen output directory          (default /var/lib/abogen/output)
  ABOGEN_VOICE      Kokoro voice for narration        (default bm_george)

Usage:
  narration_pipeline.py <classroomId> <classroomsDir>
"""
import json, os, sys, time
import requests

ABOGEN = os.environ.get("ABOGEN_URL", "http://localhost:8808")
ABOGEN_OUT = os.environ.get("ABOGEN_OUTPUT_DIR", "/var/lib/abogen/output")
VOICE = os.environ.get("ABOGEN_VOICE", "bm_george")

NORM = {
    "normalization_apostrophe_mode": "spacy",
    "normalization_numbers": "true", "normalization_currency": "true",
    "normalization_titles": "true", "normalization_footnotes": "true",
    "normalization_terminal": "true", "normalization_caps_quotes": "true",
    "normalization_apostrophes_contractions": "true",
    "normalization_apostrophes_plural_possessives": "true",
    "normalization_apostrophes_sibilant_possessives": "true",
    "normalization_apostrophes_decades": "true",
    "normalization_apostrophes_leading_elisions": "true",
    "normalization_phoneme_hints": "true",
    "normalization_contraction_aux_be": "true",
    "normalization_contraction_aux_have": "true",
    "normalization_contraction_modal_will": "true",
    "normalization_contraction_modal_would": "true",
    "normalization_contraction_negation_not": "true",
    "normalization_contraction_let_us": "true",
}


def scene_speech_text(scene):
    """Concatenate a scene's speech-action texts in order."""
    parts = []
    for a in scene.get("actions", []):
        if isinstance(a, dict) and a.get("type") == "speech" and a.get("text", "").strip():
            parts.append(a["text"].strip())
    return "\n\n".join(parts)


def upload_text(s, text, title):
    data = {
        "text": text, "title": title, "language": "b", "voice": VOICE,
        "voice_profile": "__standard", "speed": "1.0", "subtitle_mode": "Disabled",
        "output_format": "m4b", "save_mode": "default_output",
        "merge_chapters_at_end": "true", "save_chapters_separately": "false",
        "silence_between_chapters": "2.0", "chapter_intro_delay": "0.5",
        "read_title_intro": "false", "read_closing_outro": "true",
        "auto_prefix_chapter_titles": "true", "normalize_chapter_opening_caps": "true",
        "chunk_level": "paragraph", "speaker_analysis_threshold": 3,
        "remove_cover": "false", "generate_epub3": "false", "json": "1",
    }
    data.update(NORM)
    r = s.post(ABOGEN + "/wizard/text", data=data,
               headers={"Accept": "application/json"}, timeout=120)
    j = r.json()
    if "pending_id" not in j:
        raise RuntimeError(f"no pending_id: {j}")
    return j["pending_id"]


def finish_job(s, pending_id):
    chapters_j = s.get(f"{ABOGEN}/wizard/chapters?pending_id={pending_id}",
                       headers={"Accept": "application/json"}).json()
    nch = len(chapters_j.get("chapters", [])) or 1
    fin = {
        "pending_id": pending_id, "json": "1", "chunk_level": "paragraph",
        "speaker_analysis_threshold": 3, "generate_epub3": "false",
        "applied_speaker_config": "", "apply_speaker_config": "",
        "save_speaker_config": "", "speaker-narrator-voice": VOICE,
        "speaker-narrator-pronunciation": "", "speaker-narrator-formula": "",
    }
    for i in range(nch):
        fin[f"chapter-{i}-enabled"] = "on"
        fin[f"chapter-{i}-title"] = ""
        fin[f"chapter-{i}-voice"] = "__default"
        fin[f"chapter-{i}-formula"] = ""
    r = s.post(ABOGEN + "/wizard/finish", data=fin,
               headers={"Accept": "application/json"}, timeout=120)
    return r.json().get("job_id", "?")


def has_moov(data):
    return b"moov" in data[:4096]


def wait_for_job_audio(s, job_id, dest, timeout_s=900):
    """Download the finished M4B for this job by id.

    Polls the job-scoped download endpoint (GET /jobs/<id>/download/audio),
    which Abogen only serves once the job is COMPLETED, so the audio is fully
    encoded and playable. Correlating by job id (rather than scavenging the
    newest file in the shared output dir) makes the pipeline immune to any
    concurrent Abogen job. The moov check is belt-and-braces on the bytes we
    actually copy.
    """
    url = ABOGEN + f"/jobs/{job_id}/download/audio"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        r = s.get(url, timeout=30)
        if r.status_code == 200 and r.content and has_moov(r.content):
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                f.write(r.content)
            os.replace(tmp, dest)
            return dest
        if r.status_code not in (200, 404):
            raise RuntimeError(f"job download failed: HTTP {r.status_code}: {r.text[:200]}")
        time.sleep(5)
    raise TimeoutError(f"no complete m4b for job {job_id}")


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: narration_pipeline.py <classroomId> <classroomsDir>")
    cid, cdir = sys.argv[1], sys.argv[2]
    cf = os.path.join(cdir, f"{cid}.json")
    if not os.path.exists(cf):
        sys.exit(f"classroom json not found: {cf}")
    with open(cf) as f:
        data = json.load(f)

    media_dir = os.path.join(cdir, cid, "media")
    os.makedirs(media_dir, exist_ok=True)

    s = requests.Session()
    s.get(ABOGEN + "/")

    scenes = data.get("scenes", [])
    wired = 0
    for i, scene in enumerate(scenes):
        text = scene_speech_text(scene)
        if not text:
            continue
        title = f"scene-{i+1:02d}"
        pend = upload_text(s, text, title)
        job_id = finish_job(s, pend)
        dest = os.path.join(media_dir, f"scene-{i+1:02d}.m4b")
        wait_for_job_audio(s, job_id, dest)
        scene["narrationUrl"] = f"/api/classroom-media/{cid}/media/scene-{i+1:02d}.m4b"
        wired += 1
        print(f"wired scene {i+1}: {job_id} -> {dest}")

    with open(cf, "w") as f:
        json.dump(data, f, indent=2)
    print(f"narration wired for {wired}/{len(scenes)} scenes")


if __name__ == "__main__":
    main()
