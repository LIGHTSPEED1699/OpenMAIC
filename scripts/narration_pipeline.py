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
import glob, json, os, shutil, sys, time
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


def newest_m4b():
    cands = glob.glob(os.path.join(ABOGEN_OUT, "*", "*.m4b"))
    return max(cands, key=os.path.getmtime) if cands else None


def is_complete_m4b(path, min_stable_checks=2, stability_s=3.0):
    """True only when the M4B has a moov atom and its size is stable.

    Abogen encodes with ffmpeg -movflags +faststart, so the moov atom is
    written LAST. A file that appears on disk mid-encode has no moov (or a
    placeholder) and grows in size; copying it yields an unplayable clip.
    This is the root-cause fix for silent narration.
    """
    try:
        with open(path, "rb") as f:
            head = f.read(64)
        if b"moov" not in head:
            return False
    except OSError:
        return False
    # size stable across a short window
    sz0 = os.path.getsize(path)
    time.sleep(stability_s)
    sz1 = os.path.getsize(path)
    if sz0 != sz1:
        return False
    return is_complete_m4b(path, min_stable_checks - 1, 0.5) if min_stable_checks > 0 else True


def wait_for_m4b(before, timeout_s=900):
    """Wait for a NEW, COMPLETE M4B (moov present, size stable)."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        cur = newest_m4b()
        if cur and cur != before and is_complete_m4b(cur):
            return cur
        time.sleep(5)
    raise TimeoutError("no complete m4b produced")


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
        before = newest_m4b()
        pend = upload_text(s, text, title)
        finish_job(s, pend)
        m4b = wait_for_m4b(before)
        dest = os.path.join(media_dir, f"scene-{i+1:02d}.m4b")
        shutil.copy2(m4b, dest)
        scene["narrationUrl"] = f"/api/classroom-media/{cid}/media/scene-{i+1:02d}.m4b"
        wired += 1
        print(f"wired scene {i+1}: {m4b}")

    with open(cf, "w") as f:
        json.dump(data, f, indent=2)
    print(f"narration wired for {wired}/{len(scenes)} scenes")


if __name__ == "__main__":
    main()
