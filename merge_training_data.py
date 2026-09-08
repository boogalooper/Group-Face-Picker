from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DEFAULT_DEST = ROOT / "training_data"
SCHEMA_VERSION = 1


def _resolve_training_dir(path: Path) -> Path:
    path = path.expanduser().resolve()
    if path.is_dir() and (path.name.casefold() == "training_data" or (path / "events").is_dir() or (path / "faces").is_dir()):
        return path
    nested = path / "training_data"
    if nested.is_dir():
        return nested
    raise ValueError(f"Not a training_data folder or Group Face Picker folder: {path}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    shutil.copyfile(source, temp)
    os.replace(temp, target)


def _load_event(path: Path) -> dict[str, Any]:
    try:
        event = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"Cannot read event {path}: {exc}") from exc
    if not isinstance(event, dict):
        raise ValueError(f"Event is not a JSON object: {path}")
    if int(event.get("schema_version") or 0) != SCHEMA_VERSION:
        raise ValueError(f"Unsupported event schema in {path}: {event.get('schema_version')!r}")
    event_id = str(event.get("event_id") or "").strip().lower()
    if len(event_id) != 32 or any(ch not in "0123456789abcdef" for ch in event_id) or path.stem != event_id:
        raise ValueError(f"Event id does not match filename or format: {path}")
    face_ids: dict[str, str] = {}
    for key in ("chosen", "current"):
        asset = event.get(key)
        if not isinstance(asset, dict):
            raise ValueError(f"Event {path.name} has no valid {key} face reference")
        face_id = str(asset.get("face_id") or "").strip().lower()
        if len(face_id) != 64 or any(ch not in "0123456789abcdef" for ch in face_id):
            raise ValueError(f"Event {path.name} has invalid {key} face hash")
        expected_file = "faces/" + face_id + ".jpg"
        if str(asset.get("file") or "").replace("\\", "/") != expected_file:
            raise ValueError(f"Event {path.name} has inconsistent {key} face path")
        face_ids[key] = face_id
    expected_pair = hashlib.sha256((face_ids["chosen"] + ">" + face_ids["current"]).encode("ascii")).hexdigest()
    if str(event.get("pair_key") or "").strip().lower() != expected_pair:
        raise ValueError(f"Event {path.name} has invalid pair_key")
    return event


def merge_sources(sources: list[Path], destination: Path) -> dict[str, int]:
    destination = destination.expanduser().resolve()
    dest_events = destination / "events"
    dest_faces = destination / "faces"
    dest_events.mkdir(parents=True, exist_ok=True)
    dest_faces.mkdir(parents=True, exist_ok=True)

    stats = {
        "sources": 0,
        "faces_added": 0,
        "faces_existing": 0,
        "events_added": 0,
        "events_existing": 0,
    }
    verified_dest_faces: set[str] = set()
    seen_sources: set[Path] = set()

    for supplied in sources:
        source = _resolve_training_dir(supplied)
        if source == destination or source in seen_sources:
            continue
        seen_sources.add(source)
        stats["sources"] += 1

        source_faces = source / "faces"
        if source_faces.is_dir():
            for face_path in sorted(source_faces.glob("*.jpg")):
                face_hash = _sha256(face_path)
                if face_path.stem != face_hash:
                    raise ValueError(f"Face filename/hash mismatch: {face_path}")
                target = dest_faces / face_path.name
                if target.exists():
                    if face_hash not in verified_dest_faces:
                        if _sha256(target) != face_hash:
                            raise ValueError(f"Destination face hash conflict: {target}")
                        verified_dest_faces.add(face_hash)
                    stats["faces_existing"] += 1
                else:
                    _atomic_copy(face_path, target)
                    verified_dest_faces.add(face_hash)
                    stats["faces_added"] += 1

        source_events = source / "events"
        if not source_events.is_dir():
            continue
        for event_path in sorted(source_events.glob("*.json")):
            event = _load_event(event_path)
            for key in ("chosen", "current"):
                face_id = str(event[key]["face_id"])
                face_file = dest_faces / (face_id + ".jpg")
                if not face_file.is_file():
                    raise ValueError(
                        f"Event {event_path.name} references missing face {face_id}. "
                        "Copy the complete training_data folder from that computer."
                    )
                if face_id not in verified_dest_faces:
                    if _sha256(face_file) != face_id:
                        raise ValueError(f"Referenced face failed hash verification: {face_file}")
                    verified_dest_faces.add(face_id)

            target = dest_events / event_path.name
            source_bytes = event_path.read_bytes()
            if target.exists():
                if target.read_bytes() != source_bytes:
                    raise ValueError(f"Event id conflict with different content: {target.name}")
                stats["events_existing"] += 1
            else:
                temp = target.with_suffix(target.suffix + ".tmp")
                temp.write_bytes(source_bytes)
                os.replace(temp, target)
                stats["events_added"] += 1

    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Merge Group Face Picker training_data folders safely and idempotently."
    )
    parser.add_argument("sources", nargs="+", help="training_data folder(s) or Group Face Picker project folder(s)")
    parser.add_argument("--dest", default=str(DEFAULT_DEST), help="destination training_data folder (default: this script's training_data)")
    args = parser.parse_args(argv)

    try:
        stats = merge_sources([Path(value) for value in args.sources], Path(args.dest))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print("Merge completed.")
    print(f"Sources processed: {stats['sources']}")
    print(f"Faces added:       {stats['faces_added']}")
    print(f"Faces already had: {stats['faces_existing']}")
    print(f"Events added:      {stats['events_added']}")
    print(f"Events already had:{stats['events_existing']}")
    print(f"Destination:       {Path(args.dest).expanduser().resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
