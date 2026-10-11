from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = ROOT / "training_data"
DEFAULT_OUTPUT = ROOT / "personal_model"
SCHEMA_VERSION = 1
MODEL_SCHEMA_VERSION = 1
DIAGNOSTIC_SCHEMA_VERSION = 1
DEFAULT_SEED = 20260908
DEFAULT_DIAGNOSTIC_FRACTION = 0.10
_ML_CACHE = None
# Coordinates are relative to the existing 224x224 input; no dataset conversion.
FACE_REGIONS = ((0, 0, 224, 224), (34, 22, 190, 202),
                (22, 45, 202, 134), (34, 112, 190, 213))


def region_embeddings(backbone: Any, x: Any, mean: Any, std: Any, torch: Any) -> Any:
    F = torch.nn.functional
    rows = []
    for left, top, right, bottom in FACE_REGIONS:
        crop = x[:, :, top:bottom, left:right]
        if right - left != 224 or bottom - top != 224:
            crop = F.interpolate(crop, size=(224, 224), mode="bilinear", align_corners=False)
        rows.append(F.normalize(backbone((crop - mean) / std), p=2, dim=1))
    return torch.cat(rows, dim=1) / math.sqrt(len(FACE_REGIONS))



@dataclass(frozen=True)
class PairExample:
    pair_key: str
    chosen_id: str
    current_id: str
    chosen_path: Path
    current_path: Path
    event_ids: tuple[str, ...]
    collector_ids: tuple[str, ...]
    sources: tuple[str, ...]


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}
        self.rank: dict[str, int] = {}

    def add(self, item: str) -> None:
        if item not in self.parent:
            self.parent[item] = item
            self.rank[item] = 0

    def find(self, item: str) -> str:
        self.add(item)
        parent = self.parent[item]
        if parent != item:
            self.parent[item] = self.find(parent)
        return self.parent[item]

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_training_dir(path: Path) -> Path:
    path = path.expanduser().resolve()
    if path.is_dir() and path.name.casefold() == "training_data":
        return path
    if path.is_dir() and (path / "events").is_dir() and (path / "faces").is_dir():
        return path
    nested = path / "training_data"
    if nested.is_dir():
        return nested
    raise ValueError(f"Не найдена папка training_data: {path}")


def _face_ref(event: dict[str, Any], key: str, training_dir: Path, verified_faces: set[Path]) -> tuple[str, Path]:
    asset = event.get(key)
    if not isinstance(asset, dict):
        raise ValueError(f"В событии отсутствует объект {key}")
    face_id = str(asset.get("face_id") or "").strip().lower()
    if len(face_id) != 64 or any(ch not in "0123456789abcdef" for ch in face_id):
        raise ValueError(f"Некорректный SHA-256 лица {key}")
    rel = str(asset.get("file") or "").replace("\\", "/")
    expected = f"faces/{face_id}.jpg"
    if rel != expected:
        raise ValueError(f"Некорректная ссылка {key}: {rel!r}, ожидалось {expected!r}")
    path = training_dir / "faces" / f"{face_id}.jpg"
    if not path.is_file():
        raise ValueError(f"Отсутствует файл лица: {path}")
    if path not in verified_faces:
        if sha256_file(path) != face_id:
            raise ValueError(f"SHA-256 файла не совпадает с именем: {path.name}")
        verified_faces.add(path)
    return face_id, path


def load_pairs(training_dir: Path) -> tuple[list[PairExample], dict[str, int]]:
    # Read legacy flat data and each self-contained computer folder together.
    sources = [training_dir] + sorted(p for p in training_dir.iterdir() if p.is_dir())
    event_paths = [(source, path) for source in sources
                   for path in sorted((source / "events").glob("*.json"))]

    raw_by_orientation: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    invalid = 0
    event_count = 0
    collectors: set[str] = set()
    verified_faces: set[Path] = set()
    base_pair_observations = 0
    recommendation_overrides = 0
    recommendation_pair_observations = 0
    recommendation_same_as_current = 0
    recommendation_metadata_invalid = 0

    def add_pair(
        preferred_id: str,
        less_id: str,
        preferred_path: Path,
        less_path: Path,
        event_id: str,
        collector_id: str,
        source: str,
    ) -> None:
        pair_key = hashlib.sha256((preferred_id + ">" + less_id).encode("ascii")).hexdigest()
        raw_by_orientation[(preferred_id, less_id)].append({
            "event_id": event_id,
            "collector_id": collector_id,
            "chosen_path": preferred_path,
            "current_path": less_path,
            "pair_key": pair_key,
            "source": source,
        })

    for source_dir, path in event_paths:
        event_count += 1
        try:
            event = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(event, dict):
                raise ValueError("event is not an object")
            if int(event.get("schema_version") or 0) != SCHEMA_VERSION:
                raise ValueError(f"unsupported schema_version={event.get('schema_version')!r}")
            if str(event.get("preference") or "") != "chosen_over_current":
                raise ValueError("unsupported preference type")
            event_id = str(event.get("event_id") or "").strip().lower()
            if (
                path.stem != event_id
                or len(event_id) != 32
                or any(ch not in "0123456789abcdef" for ch in event_id)
            ):
                raise ValueError("event_id does not match filename or format")
            chosen_id, chosen_path = _face_ref(event, "chosen", source_dir, verified_faces)
            current_id, current_path = _face_ref(event, "current", source_dir, verified_faces)
            if chosen_id == current_id:
                raise ValueError("chosen and current are the same face")
            expected_pair = hashlib.sha256((chosen_id + ">" + current_id).encode("ascii")).hexdigest()
            if str(event.get("pair_key") or "").strip().lower() != expected_pair:
                raise ValueError("pair_key mismatch")
            collector_id = str(event.get("collector_id") or "").strip().lower()
            if collector_id:
                collectors.add(collector_id)

            # Canonical v1 pair.  This is identical to the old trainer, so every
            # previously collected dataset remains fully usable without migration.
            add_pair(chosen_id, current_id, chosen_path, current_path, event_id, collector_id, "current")
            base_pair_observations += 1

            # Newer v1 events may additionally carry the automatically recommended
            # face.  It becomes a second *explicit* preference only if the user
            # overrode that recommendation.  Merely accepting the initial choice
            # does not fabricate a new comparison.
            context = event.get("context") if isinstance(event.get("context"), dict) else {}
            recommended_asset = event.get("recommended")
            recommendation_overridden = context.get("recommendation_overridden") is True
            effective_mode = str(context.get("recommendation_effective_mode") or "off").strip().lower()
            if isinstance(recommended_asset, dict) and recommendation_overridden and effective_mode in ("public", "personal", "combined"):
                # Recommendation metadata is an optional extension of the v1 event.
                # It must never invalidate the canonical chosen > current pair.
                try:
                    recommended_id, recommended_path = _face_ref(
                        event, "recommended", source_dir, verified_faces
                    )
                except Exception as exc:
                    recommendation_metadata_invalid += 1
                    print(
                        f"WARNING: событие {path.name}: дополнительная рекомендация пропущена: {exc}",
                        file=sys.stderr,
                    )
                else:
                    if recommended_id != chosen_id:
                        recommendation_overrides += 1
                        if recommended_id == current_id:
                            # Same information as chosen > current; keep only one raw
                            # observation so counters and weighting are not inflated.
                            recommendation_same_as_current += 1
                        else:
                            add_pair(
                                chosen_id,
                                recommended_id,
                                chosen_path,
                                recommended_path,
                                event_id,
                                collector_id,
                                "recommendation",
                            )
                            recommendation_pair_observations += 1
        except Exception as exc:
            invalid += 1
            print(f"WARNING: пропущено повреждённое событие {path.name}: {exc}", file=sys.stderr)

    # If the exact same unordered pair was ever chosen in both directions,
    # exclude it entirely instead of teaching the ranker contradictory labels.
    unordered_orientations: dict[tuple[str, str], set[tuple[str, str]]] = defaultdict(set)
    for chosen_id, current_id in raw_by_orientation:
        unordered = tuple(sorted((chosen_id, current_id)))
        unordered_orientations[unordered].add((chosen_id, current_id))

    contradictory_unordered = {key for key, values in unordered_orientations.items() if len(values) > 1}
    pairs: list[PairExample] = []
    duplicate_events = 0
    for (chosen_id, current_id), entries in sorted(raw_by_orientation.items()):
        if tuple(sorted((chosen_id, current_id))) in contradictory_unordered:
            continue
        duplicate_events += max(0, len(entries) - 1)
        first = entries[0]
        pairs.append(PairExample(
            pair_key=str(first["pair_key"]),
            chosen_id=chosen_id,
            current_id=current_id,
            chosen_path=Path(first["chosen_path"]),
            current_path=Path(first["current_path"]),
            event_ids=tuple(sorted({str(e["event_id"]) for e in entries})),
            collector_ids=tuple(sorted({str(e["collector_id"]) for e in entries if e["collector_id"]})),
            sources=tuple(sorted({str(e["source"]) for e in entries})),
        ))

    unique_base_pairs = sum(1 for pair in pairs if "current" in pair.sources)
    unique_recommendation_pairs = sum(1 for pair in pairs if "recommendation" in pair.sources)
    additional_unique_recommendation_pairs = sum(
        1 for pair in pairs if "recommendation" in pair.sources and "current" not in pair.sources
    )
    stats = {
        "events_found": event_count,
        "data_folders": len({source for source, _ in event_paths}),
        "events_invalid": invalid,
        "unique_pairs": len(pairs),
        "unique_base_pairs": unique_base_pairs,
        "unique_recommendation_pairs": unique_recommendation_pairs,
        "additional_unique_recommendation_pairs": additional_unique_recommendation_pairs,
        "base_pair_observations": base_pair_observations,
        "recommendation_overrides": recommendation_overrides,
        "recommendation_pair_observations": recommendation_pair_observations,
        "recommendation_same_as_current": recommendation_same_as_current,
        "recommendation_metadata_invalid": recommendation_metadata_invalid,
        "duplicate_same_direction_events": duplicate_events,
        "contradictory_pairs_excluded": len(contradictory_unordered),
        "collectors": len(collectors),
    }
    return pairs, stats


def split_pairs_no_face_leakage(
    pairs: list[PairExample], validation_fraction: float, seed: int
) -> tuple[list[PairExample], list[PairExample], str]:
    if len(pairs) < 2:
        return pairs, [], "none"

    uf = UnionFind()
    for pair in pairs:
        uf.union(pair.chosen_id, pair.current_id)
    components: dict[str, list[PairExample]] = defaultdict(list)
    for pair in pairs:
        components[uf.find(pair.chosen_id)].append(pair)

    groups = list(components.values())
    rng = random.Random(seed)
    rng.shuffle(groups)
    groups.sort(key=len, reverse=True)

    target = max(1, int(round(len(pairs) * validation_fraction)))
    val: list[PairExample] = []
    train: list[PairExample] = []

    if len(groups) >= 2:
        # Assign whole face-connected components. Optimize size AND comparison
        # type counts; the old largest-first fill concentrated hard pairs in val.
        counts = [(len(g), sum("recommendation" in p.sources for p in g)) for g in groups]
        totals = (len(pairs), sum(c[1] for c in counts))
        targets = (target, totals[1] * validation_fraction)

        def cost(n: int, r: int) -> float:
            base_total = totals[0] - totals[1]
            return ((n - targets[0]) / max(1, targets[0])) ** 2 + (
                (r - targets[1]) / max(1, targets[1])) ** 2 + (
                ((n - r) - (targets[0] - targets[1])) /
                max(1, base_total * validation_fraction)) ** 2

        best = None
        best_cost = float("inf")
        for attempt in range(128):
            order = list(range(len(groups)))
            rng.shuffle(order)
            selected: set[int] = set()
            n = r = 0
            for i in order:
                dn, dr = counts[i]
                if n + dn < len(pairs) and cost(n + dn, r + dr) < cost(n, r):
                    selected.add(i)
                    n += dn
                    r += dr
            if selected and cost(n, r) < best_cost:
                best, best_cost = selected, cost(n, r)
        if best is not None:
            val = [p for i, group in enumerate(groups) if i in best for p in group]
            train = [p for i, group in enumerate(groups) if i not in best for p in group]
            return train, val, "stratified-connected-components-no-face-overlap"

    # Rare fallback: all comparisons form one connected graph. We still retain
    # a validation set, but report that face leakage could not be eliminated.
    shuffled = list(pairs)
    rng.shuffle(shuffled)
    val_count = min(len(shuffled) - 1, target)
    val = shuffled[:val_count]
    train = shuffled[val_count:]
    return train, val, "pair-random-face-overlap-possible"


def _stable_pair_order_key(pair_key: str, seed: int) -> str:
    return hashlib.sha256(f"{seed}:{pair_key}".encode("ascii")).hexdigest()


def _diagnostic_target_size(pair_count: int, fraction: float) -> int:
    if pair_count < 4:
        return 0
    requested = max(1, int(round(pair_count * fraction)))
    # Keep the diagnostic anchor useful without taking too much data away from
    # model selection.  The final exported model is refit on 100% of pairs, so
    # this only affects regularization/model-selection training.
    requested = max(20 if pair_count >= 80 else 1, requested)
    requested = min(250, requested)
    return min(requested, max(1, pair_count // 4))


def load_or_create_diagnostic_holdout(
    training_dir: Path,
    pairs: list[PairExample],
    fraction: float,
    seed: int,
    reset: bool = False,
) -> tuple[list[PairExample], dict[str, Any]]:
    """Return a fixed pair-level diagnostic anchor persisted across retraining.

    The manifest stores only pair keys from the dataset present at creation time.
    New pairs are deliberately *not* added later, so the diagnostic score remains
    directly comparable between subsequent training runs.
    """
    manifest_path = training_dir / "diagnostic_holdout.json"
    pair_by_key = {pair.pair_key: pair for pair in pairs}

    manifest: dict[str, Any] | None = None
    if manifest_path.is_file() and not reset:
        try:
            loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                raise ValueError("manifest is not an object")
            if int(loaded.get("schema_version") or 0) != DIAGNOSTIC_SCHEMA_VERSION:
                raise ValueError("unsupported diagnostic manifest schema")
            keys = loaded.get("pair_keys")
            if not isinstance(keys, list) or not all(isinstance(item, str) for item in keys):
                raise ValueError("pair_keys is invalid")
            manifest = loaded
        except Exception as exc:
            raise ValueError(
                f"Повреждён {manifest_path.name}: {exc}. "
                "Удалите его или запустите обучение с --reset-diagnostic-holdout."
            ) from exc

    created = manifest is None
    if created:
        target = _diagnostic_target_size(len(pairs), fraction)
        ordered = sorted(pairs, key=lambda p: (_stable_pair_order_key(p.pair_key, seed), p.pair_key))

        # Ensure the fixed anchor contains at least a small useful sample of the
        # harder rejected-recommendation comparisons when they exist.  Without
        # this, a 10% random anchor can contain only a handful of them and the
        # source-specific metric becomes too noisy to be useful.
        recommendation_candidates = [pair for pair in ordered if "recommendation" in pair.sources]
        recommendation_target = 0
        if recommendation_candidates and target > 0:
            recommendation_target = min(
                len(recommendation_candidates),
                max(4 if len(recommendation_candidates) >= 8 else 1,
                    int(round(len(recommendation_candidates) * 0.15))),
                max(1, target // 3),
            )
        selected = recommendation_candidates[:recommendation_target]
        selected_keys = {pair.pair_key for pair in selected}
        for pair in ordered:
            if len(selected) >= target:
                break
            if pair.pair_key not in selected_keys:
                selected.append(pair)
                selected_keys.add(pair.pair_key)

        manifest = {
            "schema_version": DIAGNOSTIC_SCHEMA_VERSION,
            "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "seed": int(seed),
            "fraction_at_creation": float(fraction),
            "dataset_unique_pairs_at_creation": len(pairs),
            "recommendation_pairs_at_creation": sum(1 for pair in pairs if "recommendation" in pair.sources),
            "recommendation_pairs_selected": sum(1 for pair in selected if "recommendation" in pair.sources),
            "pair_keys": [pair.pair_key for pair in selected],
        }
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    keys = [str(item) for item in manifest.get("pair_keys", [])]
    available = [pair_by_key[key] for key in keys if key in pair_by_key]
    missing = len(keys) - len(available)
    info = {
        "manifest_file": manifest_path.name,
        "created_now": created,
        "pairs_in_manifest": len(keys),
        "pairs_available": len(available),
        "pairs_missing": missing,
        "dataset_unique_pairs_at_creation": int(manifest.get("dataset_unique_pairs_at_creation") or 0),
        "created_utc": str(manifest.get("created_utc") or ""),
    }
    return available, info


def exclude_diagnostic_face_leakage(
    pairs: list[PairExample], diagnostic_pairs: list[PairExample]
) -> tuple[list[PairExample], int]:
    diagnostic_keys = {pair.pair_key for pair in diagnostic_pairs}
    diagnostic_faces = {
        face_id
        for pair in diagnostic_pairs
        for face_id in (pair.chosen_id, pair.current_id)
    }
    development: list[PairExample] = []
    guard_excluded = 0
    for pair in pairs:
        if pair.pair_key in diagnostic_keys:
            continue
        if pair.chosen_id in diagnostic_faces or pair.current_id in diagnostic_faces:
            guard_excluded += 1
            continue
        development.append(pair)
    return development, guard_excluded


def _import_ml():
    global _ML_CACHE
    if _ML_CACHE is not None:
        return _ML_CACHE
    try:
        import numpy as np
        import torch
        import torch.nn as nn
        import torch.nn.functional as F
        from PIL import Image
        from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small
    except Exception as exc:
        raise RuntimeError(
            "Не установлено окружение обучения. Запускайте train_personal_model.bat, а не Python-файл напрямую. "
            f"Причина: {exc}"
        ) from exc
    _ML_CACHE = (np, torch, nn, F, Image, MobileNet_V3_Small_Weights, mobilenet_v3_small)
    return _ML_CACHE


def load_face_tensor(path: Path, Image: Any, torch: Any) -> Any:
    with Image.open(path) as source:
        image = source.convert("RGB").resize((224, 224), Image.Resampling.BICUBIC)
    # Avoid torchvision transforms here so training and exported inference use
    # one explicit preprocessing contract: float RGB CHW in [0,1].
    import numpy as np
    arr = np.asarray(image, dtype=np.float32) / 255.0
    image.close()
    return torch.from_numpy(arr).permute(2, 0, 1).contiguous()


def build_backbone(torch: Any, nn: Any, mobilenet_v3_small: Any, weights_enum: Any):
    weights = weights_enum.IMAGENET1K_V1
    base = mobilenet_v3_small(weights=weights)
    features = nn.Sequential(base.features, base.avgpool, nn.Flatten(1))
    for param in features.parameters():
        param.requires_grad_(False)
    features.eval()
    return features, 576, str(weights)


def unique_face_paths(pairs: Iterable[PairExample]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for pair in pairs:
        result[pair.chosen_id] = pair.chosen_path
        result[pair.current_id] = pair.current_path
    return result


def extract_embeddings(
    pairs: list[PairExample], batch_size: int, device_name: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    np, torch, nn, _F, Image, weights_enum, mobilenet = _import_ml()
    device = torch.device(device_name)
    backbone, dim, weights_name = build_backbone(torch, nn, mobilenet, weights_enum)
    backbone.to(device)

    mean = torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32, device=device).view(1, 3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32, device=device).view(1, 3, 1, 1)
    faces = unique_face_paths(pairs)
    items = sorted(faces.items())
    embeddings: dict[str, Any] = {}

    print(f"Извлечение visual embeddings: {len(items)} уникальных лиц, устройство={device}")
    with torch.inference_mode():
        for start in range(0, len(items), batch_size):
            batch_items = items[start:start + batch_size]
            tensors = [load_face_tensor(path, Image, torch) for _face_id, path in batch_items]
            x = torch.stack(tensors, dim=0).to(device)
            emb = region_embeddings(backbone, x, mean, std, torch)
            emb = emb.cpu()
            for (face_id, _path), row in zip(batch_items, emb):
                embeddings[face_id] = row.clone()
            done = min(len(items), start + len(batch_items))
            print(f"  {done}/{len(items)}", end="\r", flush=True)
    print()
    return embeddings, {
        "embedding_dim": dim * len(FACE_REGIONS),
        "face_regions": [list(r) for r in FACE_REGIONS],
        "backbone": "torchvision.mobilenet_v3_small",
        "backbone_weights": weights_name,
        "input_size": 224,
        "mean": [0.485, 0.456, 0.406],
        "std": [0.229, 0.224, 0.225],
    }


def tensor_pair_diffs(pairs: list[PairExample], embeddings: dict[str, Any], torch: Any) -> Any:
    rows = [embeddings[p.chosen_id] - embeddings[p.current_id] for p in pairs]
    if not rows:
        return torch.empty((0, next(iter(embeddings.values())).numel()), dtype=torch.float32)
    return torch.stack(rows, dim=0).float()


def pair_metrics(weight: Any, diffs: Any, torch: Any, F: Any) -> tuple[float, float, float]:
    if diffs.numel() == 0:
        return float("nan"), float("nan"), float("nan")
    margins = diffs @ weight
    accuracy = float((margins > 0).float().mean().item())
    mean_margin = float(margins.mean().item())
    loss = float(F.softplus(-margins).mean().item())
    return accuracy, mean_margin, loss


def subset_pair_metrics(
    weight: Any,
    pairs: list[PairExample],
    embeddings: dict[str, Any],
    source: str | None = None,
) -> dict[str, Any]:
    _np, torch, _nn, F, _Image, _weights_enum, _mobilenet = _import_ml()
    selected = pairs if source is None else [pair for pair in pairs if source in pair.sources]
    if not selected:
        return {
            "pairs": 0,
            "accuracy": None,
            "mean_margin": None,
            "loss": None,
        }
    diffs = tensor_pair_diffs(selected, embeddings, torch)
    accuracy, mean_margin, loss = pair_metrics(weight, diffs, torch, F)
    return {
        "pairs": len(selected),
        "accuracy": accuracy,
        "mean_margin": mean_margin,
        "loss": loss,
    }


def fit_regularized_head(pairs: list[PairExample], embeddings: dict[str, Any], c: float) -> Any:
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    _np, torch, *_ = _import_ml()
    diffs = tensor_pair_diffs(pairs, embeddings, torch).numpy()
    # Mirroring makes both labels explicit. No bias: reversing a pair must
    # negate its margin, not change its definition.
    model = LogisticRegression(C=c, fit_intercept=False, solver="lbfgs",
                               max_iter=300, tol=1e-7)
    model.fit(np.concatenate([diffs, -diffs]),
              np.concatenate([np.ones(len(diffs)), np.zeros(len(diffs))]))
    return torch.from_numpy(model.coef_[0].astype(np.float32))


def select_regularization(pairs: list[PairExample], embeddings: dict[str, Any],
                          fraction: float, seed: int) -> tuple[float, list[dict[str, Any]]]:
    seeds = (seed, seed + 173, seed + 947)
    # Preserve the initially tested default partitions exactly.
    if seed == DEFAULT_SEED:
        seeds = (seed, 173, 947)
    splits = [split_pairs_no_face_leakage(pairs, fraction, value) for value in seeds]
    if any("face-overlap-possible" in method for _, _, method in splits):
        print("WARNING: некоторые разбиения содержат пересечения face-id; смотрите JSON.", file=sys.stderr)
    candidates = []
    for c in (0.1, 1.0, 10.0, 100.0):
        folds = []
        for i, (train, val, method) in enumerate(splits):
            weight = fit_regularized_head(train, embeddings, c)
            score = subset_pair_metrics(weight, val, embeddings)
            score.update({"seed": seeds[i], "split_method": method,
                          "train_pairs": len(train), "validation_pairs": len(val)})
            folds.append(score)
            print(f"C={c:g}, split {i+1}/3: accuracy={score['accuracy']*100:.1f}%, loss={score['loss']:.4f}")
        row = {"C": c, "folds": folds,
               "mean_loss": sum(f["loss"] for f in folds) / len(folds),
               "mean_accuracy": sum(f["accuracy"] for f in folds) / len(folds)}
        candidates.append(row)
    selected = min(candidates, key=lambda row: row["mean_loss"])
    print(f"Selected C={selected['C']:g}; mean validation accuracy={selected['mean_accuracy']*100:.1f}%")
    return selected["C"], candidates


def export_onnx(weight: Any, output_path: Path, model_info: dict[str, Any]) -> None:
    _np, torch, nn, F, _Image, weights_enum, mobilenet = _import_ml()
    backbone, dim, _weights_name = build_backbone(torch, nn, mobilenet, weights_enum)

    class PersonalPreferenceModel(nn.Module):
        def __init__(self, backbone_model: Any, head_weight: Any) -> None:
            super().__init__()
            self.backbone = backbone_model
            self.register_buffer("mean", torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32).view(1, 3, 1, 1))
            self.register_buffer("std", torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32).view(1, 3, 1, 1))
            self.head = nn.Linear(dim * len(FACE_REGIONS), 1, bias=False)
            with torch.no_grad():
                self.head.weight.copy_(head_weight.view(1, -1))
            for p in self.parameters():
                p.requires_grad_(False)

        def forward(self, x: Any) -> Any:
            embedding = region_embeddings(self.backbone, x, self.mean, self.std, torch)
            raw = self.head(embedding)
            return torch.sigmoid(raw)

    model = PersonalPreferenceModel(backbone, weight).eval()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp = output_path.with_suffix(output_path.suffix + ".tmp")
    example = torch.zeros((1, 3, 224, 224), dtype=torch.float32)
    torch.onnx.export(
        model,
        example,
        str(temp),
        export_params=True,
        opset_version=17,
        do_constant_folding=True,
        input_names=["image"],
        output_names=["preference_score"],
        dynamic_axes={"image": {0: "batch"}, "preference_score": {0: "batch"}},
        dynamo=False,
    )

    import onnx
    import onnxruntime as ort
    onnx_model = onnx.load(str(temp))
    onnx.checker.check_model(onnx_model)
    session = ort.InferenceSession(str(temp), providers=["CPUExecutionProvider"])
    generator = torch.Generator().manual_seed(123)
    example = torch.rand((3, 3, 224, 224), generator=generator)
    sample = example.numpy()
    ort_out = session.run(None, {"image": sample})[0]
    with torch.inference_mode():
        torch_out = model(example).numpy()
    max_error = float(abs(ort_out - torch_out).max())
    if not math.isfinite(max_error) or max_error > 1e-4:
        temp.unlink(missing_ok=True)
        raise RuntimeError(f"ONNX self-test mismatch: max abs error={max_error}")
    os.replace(temp, output_path)
    model_info["onnx_self_test_max_abs_error"] = max_error



DIAGNOSTIC_HISTORY_SCHEMA_VERSION = 1


def _read_json_object(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def load_previous_training_metadata(
    training_dir: Path, output_dir: Path
) -> dict[str, Any] | None:
    """Best-effort read of the previous successful diagnostic result.

    0.6.23 persists the latest comparable metric in training_data so it survives
    replacing the application folder.  For the first upgrade from 0.6.22 we
    fall back to the existing personal_preference.json and migrate on success.
    A missing or damaged history must never prevent a new training run.
    """
    history = _read_json_object(training_dir / "diagnostic_history.json")
    if history and int(history.get("schema_version") or 0) == DIAGNOSTIC_HISTORY_SCHEMA_VERSION:
        snapshot = history.get("latest")
        if isinstance(snapshot, dict):
            return snapshot
    return _read_json_object(output_dir / "personal_preference.json")


def save_diagnostic_history(training_dir: Path, metadata: dict[str, Any]) -> None:
    """Persist the latest successful Stable diagnostic next to training data."""
    snapshot = {
        "trained_utc": metadata.get("trained_utc"),
        "dataset": {
            "diagnostic_holdout": (metadata.get("dataset") or {}).get("diagnostic_holdout") or {},
        },
        "metrics": {
            "stable_diagnostic": (metadata.get("metrics") or {}).get("stable_diagnostic") or {},
        },
    }
    payload = {
        "schema_version": DIAGNOSTIC_HISTORY_SCHEMA_VERSION,
        "latest": snapshot,
    }
    path = training_dir / "diagnostic_history.json"
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temp, path)


def stable_diagnostic_comparison(
    previous: dict[str, Any] | None,
    current_diagnostic_info: dict[str, Any],
    current_metrics: dict[str, Any],
) -> dict[str, Any]:
    """Compare Stable diagnostic only when the fixed holdout is unchanged.

    The holdout creation timestamp is persisted in diagnostic_holdout.json and was
    already included in 0.6.22 metadata, so the first 0.6.23 run can compare
    directly with an existing 0.6.22 result.
    """
    result: dict[str, Any] = {"status": "no_previous"}
    if not previous:
        return result

    result["previous_trained_utc"] = str(previous.get("trained_utc") or "")
    try:
        prev_dataset = previous.get("dataset") or {}
        prev_info = prev_dataset.get("diagnostic_holdout") or {}
        prev_metrics = (previous.get("metrics") or {}).get("stable_diagnostic") or {}
        cur_metrics = current_metrics.get("stable_diagnostic") or {}

        prev_created = str(prev_info.get("created_utc") or "")
        cur_created = str(current_diagnostic_info.get("created_utc") or "")
        prev_manifest_count = int(prev_info.get("pairs_in_manifest") or 0)
        cur_manifest_count = int(current_diagnostic_info.get("pairs_in_manifest") or 0)
        prev_missing = int(prev_info.get("pairs_missing") or 0)
        cur_missing = int(current_diagnostic_info.get("pairs_missing") or 0)

        if not prev_created or not cur_created or prev_created != cur_created:
            result["status"] = "holdout_changed"
            return result
        if prev_manifest_count != cur_manifest_count:
            result["status"] = "holdout_changed"
            return result
        if prev_missing or cur_missing:
            result["status"] = "incomplete_holdout"
            return result

        previous_blocks: dict[str, Any] = {}
        changes: dict[str, float | None] = {}
        for key in ("all", "base", "recommendation"):
            prev_block = prev_metrics.get(key) or {}
            cur_block = cur_metrics.get(key) or {}
            prev_pairs = int(prev_block.get("pairs") or 0)
            cur_pairs = int(cur_block.get("pairs") or 0)
            prev_acc = prev_block.get("accuracy")
            cur_acc = cur_block.get("accuracy")
            previous_blocks[key] = {
                "pairs": prev_pairs,
                "accuracy": prev_acc if isinstance(prev_acc, (int, float)) else None,
            }
            if prev_pairs != cur_pairs:
                result["status"] = "holdout_changed"
                return result
            if isinstance(prev_acc, (int, float)) and isinstance(cur_acc, (int, float)):
                changes[key] = (float(cur_acc) - float(prev_acc)) * 100.0
            else:
                changes[key] = None

        result.update({
            "status": "comparable",
            "previous": previous_blocks,
            "change_percentage_points": changes,
        })
        return result
    except Exception:
        result["status"] = "invalid_previous"
        return result

def write_report(output_dir: Path, metadata: dict[str, Any]) -> None:
    (output_dir / "personal_preference.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    m = metadata["metrics"]
    d = metadata["dataset"]
    diag = m["stable_diagnostic"]
    def percent(block):
        return "n/a" if block.get("accuracy") is None else f"{block['accuracy']*100:.1f}% ({block['pairs']} пар)"
    lines = ["# Personal Preference Model — training report", "",
             "Дата обучения: " + metadata["trained_utc"], "",
             f"- Событий: {d['events_found']}; пропущено: {d['events_invalid']}",
             f"- Уникальных пар: {d['unique_pairs']}",
             f"- Папок данных: {d['data_folders']}",
             f"- Development pairs: {d['development_pairs']}",
             f"- Диагностических пар: {d['diagnostic_pairs']}",
             f"- Исключено из подбора из-за пересечения с diagnostic: {d['diagnostic_guard_pairs_excluded']}",
             f"- Средняя validation accuracy на трёх разбиениях: {m['validation_pair_accuracy']*100:.1f}%",
             f"- Выбранная регуляризация C: {metadata['training']['regularization_C']:g}",
             "- Stable diagnostic — все: " + percent(diag["all"]),
             "- Stable diagnostic — chosen > current: " + percent(diag["base"]),
             "- Stable diagnostic — chosen > rejected recommendation: " + percent(diag["recommendation"]),
             f"- Финальная ONNX обучена на {d['final_refit_pairs']} парах",
             f"- Точность финальной ONNX на обучающих парах: {m['final_refit']['all_pairs_accuracy']*100:.1f}%", "",
             "## Проверенные варианты", "",
             "| C | Средняя validation accuracy | Средняя validation loss |",
             "|---|---:|---:|"]
    for row in m["cross_validation"]:
        lines.append(f"| {row['C']:g} | {row['mean_accuracy']*100:.1f}% | {row['mean_loss']:.4f} |")
    comparison = m["stable_diagnostic_comparison"]
    lines += ["", "Сравнение с предыдущей диагностикой: " + str(comparison.get("status"))]
    if comparison.get("status") == "comparable":
        for key, value in comparison["change_percentage_points"].items():
            if value is not None:
                lines.append(f"- {key}: {value:+.1f} п.п.")
    lines += ["", "## Как трактовать результат", "",
              "Модель использует весь кроп, центральную часть, области глаз и рта. "
              "Формат исходных JPEG/JSON не изменяется. Обработка лица требует четырёх проходов backbone.",
              "Регуляризация выбирается по средней ошибке трёх разбиений; одинаковые face-id "
              "не разделяются между train и validation, когда граф позволяет это. "
              "Разные кадры одного человека могут оставаться с обеих сторон.",
              "Диагностическая выборка не используется для выбора C. Для её оценки модель "
              "обучается на development pairs. Финальная ONNX затем обучается на всех парах; "
              "её точность на обучающем наборе не является независимой оценкой качества.",
              "Три validation-разбиения частично пересекаются и не являются тремя независимыми тестами.",
              "Повторный подбор алгоритма по одной и той же диагностике постепенно уменьшает её независимость.", ""]
    (output_dir / "training_report.md").write_text("\n".join(lines), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Train a personal pairwise portrait-preference model from Group Face Picker statistics.")
    parser.add_argument("--data", default=str(DEFAULT_DATA), help="training_data folder or Group Face Picker folder")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="output directory")
    parser.add_argument("--validation", type=float, default=0.20, help="validation fraction (default 0.20)")
    parser.add_argument("--min-pairs", type=int, default=20, help="refuse training below this many unique pairs")
    parser.add_argument("--batch-size", type=int, default=32, help="embedding extraction batch size")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--device", choices=("cpu", "cuda", "auto"), default="auto")
    parser.add_argument(
        "--diagnostic-fraction",
        type=float,
        default=DEFAULT_DIAGNOSTIC_FRACTION,
        help="fixed diagnostic holdout fraction used only for cross-run comparison (default 0.10)",
    )
    parser.add_argument(
        "--reset-diagnostic-holdout",
        action="store_true",
        help="recreate diagnostic_holdout.json; this breaks comparability with previous reports",
    )
    parser.add_argument("--check-data", action="store_true", help="validate/count dataset and exit before loading ML dependencies")
    args = parser.parse_args(argv)

    try:
        training_dir = resolve_training_dir(Path(args.data))
        output_dir = Path(args.output).expanduser().resolve()
        pairs, dataset_stats = load_pairs(training_dir)
        min_pairs = max(2, int(args.min_pairs))
        print(f"Dataset:      {training_dir}")
        print(f"Data folders: {dataset_stats['data_folders']}")
        print(f"Events:       {dataset_stats['events_found']}")
        print(f"Unique pairs: {dataset_stats['unique_pairs']}")
        print(f"  base chosen>current:                 {dataset_stats['unique_base_pairs']}")
        print(f"  extra chosen>rejected recommendation:{dataset_stats['additional_unique_recommendation_pairs']}")
        print(f"Recommendation overrides recorded:     {dataset_stats['recommendation_overrides']}")
        print(f"Collectors:   {dataset_stats['collectors']}")
        if dataset_stats["events_invalid"]:
            print(f"Invalid events skipped: {dataset_stats['events_invalid']}")
        if dataset_stats["duplicate_same_direction_events"]:
            print(f"Repeated same-direction events collapsed: {dataset_stats['duplicate_same_direction_events']}")
        if dataset_stats["contradictory_pairs_excluded"]:
            print(f"Contradictory unordered pairs excluded: {dataset_stats['contradictory_pairs_excluded']}")
        if len(pairs) < min_pairs:
            raise ValueError(
                f"Недостаточно данных: найдено {len(pairs)} уникальных непротиворечивых пар. "
                f"Минимум для запуска обучения: {min_pairs}."
            )
        if args.check_data:
            print("Dataset check: OK")
            return 0

        output_dir.mkdir(parents=True, exist_ok=True)
        previous_training_metadata = load_previous_training_metadata(training_dir, output_dir)
        validation_fraction = max(0.05, min(0.40, float(args.validation)))
        diagnostic_fraction = max(0.02, min(0.25, float(args.diagnostic_fraction)))
        diagnostic_pairs, diagnostic_info = load_or_create_diagnostic_holdout(
            training_dir,
            pairs,
            diagnostic_fraction,
            int(args.seed),
            reset=bool(args.reset_diagnostic_holdout),
        )
        if diagnostic_info["pairs_missing"]:
            print(
                "WARNING: часть фиксированного diagnostic holdout отсутствует в текущем датасете: "
                f"{diagnostic_info['pairs_missing']} пар.",
                file=sys.stderr,
            )

        development_pairs, diagnostic_guard_excluded = exclude_diagnostic_face_leakage(
            pairs, diagnostic_pairs
        )
        if len(development_pairs) < 2:
            raise ValueError(
                "После исключения фиксированного diagnostic holdout осталось слишком мало пар "
                "для model-selection обучения. Удалите diagnostic_holdout.json и повторите обучение."
            )

        train_pairs, val_pairs, split_method = split_pairs_no_face_leakage(
            development_pairs, validation_fraction, int(args.seed)
        )
        if not train_pairs:
            raise ValueError("Не удалось сформировать train выборку")

        _np, torch, _nn, _F, _Image, _weights_enum, _mobilenet = _import_ml()
        torch.set_num_threads(min(4, max(1, os.cpu_count() or 1)))
        if args.device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        elif args.device == "cuda" and not torch.cuda.is_available():
            print("WARNING: CUDA недоступна; обучение продолжится на CPU.", file=sys.stderr)
            device = "cpu"
        else:
            device = args.device

        print("============================================================")
        print("Group Face Picker - personal preference training")
        print("============================================================")
        print(
            f"Stable diagnostic: {len(diagnostic_pairs)} pairs "
            f"({'created now' if diagnostic_info['created_now'] else 'reused'})"
        )
        if diagnostic_guard_excluded:
            print(f"Diagnostic face-leakage guard excluded from model selection: {diagnostic_guard_excluded}")
        print(f"Train / val:   {len(train_pairs)} / {len(val_pairs)}")
        print(f"Split:         {split_method}")
        if len(pairs) < 100:
            print("WARNING: датасет пока маленький. Модель будет экспериментальной; продолжайте собирать статистику.")

        # Extract once for the full dataset.  The final refit will use all pairs,
        # while the first fit below is only for honest model selection.
        embeddings, backbone_info = extract_embeddings(pairs, max(1, int(args.batch_size)), device)
        c, cv = select_regularization(development_pairs, embeddings, validation_fraction, int(args.seed))
        selected = min(cv, key=lambda row: row["mean_loss"])
        selection_weight = fit_regularized_head(development_pairs, embeddings, c)
        metrics = {
            "cross_validation": cv,
            "validation_pair_accuracy": selected["mean_accuracy"],
            "validation_pair_loss": selected["mean_loss"],
            "stable_diagnostic": {
                "all": subset_pair_metrics(selection_weight, diagnostic_pairs, embeddings),
                "base": subset_pair_metrics(selection_weight, diagnostic_pairs, embeddings, "current"),
                "recommendation": subset_pair_metrics(selection_weight, diagnostic_pairs, embeddings, "recommendation"),
            },
        }
        metrics["stable_diagnostic_comparison"] = stable_diagnostic_comparison(previous_training_metadata, diagnostic_info, metrics)
        for name, block in metrics["stable_diagnostic"].items():
            if block["accuracy"] is not None:
                print(f"Stable diagnostic {name}: {block['accuracy']*100:.1f}% ({block['pairs']} pairs)")
        print(f"Final regularized refit on all {len(pairs)} pairs...")
        final_weight = fit_regularized_head(pairs, embeddings, c)
        full_score = subset_pair_metrics(final_weight, pairs, embeddings)
        metrics["final_refit"] = {
            "all_pairs_accuracy": full_score["accuracy"],
            "all_pairs_loss": full_score["loss"],
            "base": subset_pair_metrics(final_weight, pairs, embeddings, "current"),
            "recommendation": subset_pair_metrics(final_weight, pairs, embeddings, "recommendation"),
        }

        model_path = output_dir / "personal_preference.onnx"
        model_info = dict(backbone_info)
        export_onnx(final_weight, model_path, model_info)

        val_acc = metrics["validation_pair_accuracy"]
        metadata = {
            "schema_version": MODEL_SCHEMA_VERSION,
            "model_type": "pairwise_personal_portrait_preference",
            "trained_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "training_data_path": str(training_dir),
            "model": {
                **model_info,
                "file": model_path.name,
                "sha256": sha256_file(model_path),
                "input": "float32 RGB NCHW 224x224 in [0,1]",
                "output": "preference_score sigmoid in [0,1]",
                "recommended_use": "compare frames of the same person; higher is preferred",
            },
            "dataset": {
                **dataset_stats,
                "diagnostic_pairs": len(diagnostic_pairs),
                "diagnostic_guard_pairs_excluded": diagnostic_guard_excluded,
                "development_pairs": len(development_pairs),
                "train_pairs": len(train_pairs),
                "validation_pairs": len(val_pairs),
                "final_refit_pairs": len(pairs),
                "split_method": split_method,
                "validation_fraction_requested": validation_fraction,
                "diagnostic_fraction_requested": diagnostic_fraction,
                "diagnostic_holdout": diagnostic_info,
            },
            "metrics": {
                **metrics,
                "validation_pair_accuracy": None if math.isnan(val_acc) else val_acc,
            },
            "training": {
                "seed": int(args.seed),
                "method": "multiregion_pairwise_logistic_L2",
                "regularization_C": c,
                "selection_objective": "mean validation loss over three grouped splits",
                "diagnostic_fraction": diagnostic_fraction,
                "device": device,
                "torch": str(torch.__version__),
            },
        }
        write_report(output_dir, metadata)
        try:
            save_diagnostic_history(training_dir, metadata)
        except Exception as exc:
            print(
                f"WARNING: не удалось обновить diagnostic_history.json: {exc}",
                file=sys.stderr,
            )

        print()
        print("Готово.")
        print(f"ONNX:   {model_path}")
        print(f"JSON:   {output_dir / 'personal_preference.json'}")
        print(f"Report: {output_dir / 'training_report.md'}")
        if val_acc is not None and not math.isnan(val_acc):
            print(f"Validation pair accuracy: {val_acc*100:.1f}%")
        print(
            "Final ONNX training-set accuracy: "
            f"{metrics['final_refit']['all_pairs_accuracy']*100:.1f}%"
        )
        if "face-overlap-possible" in split_method:
            print("WARNING: validation содержит возможное пересечение лиц между train и validation.")
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
