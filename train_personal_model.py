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
DEFAULT_SEED = 20260908
_ML_CACHE = None


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


def _face_ref(event: dict[str, Any], key: str, training_dir: Path, verified_faces: set[str]) -> tuple[str, Path]:
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
    if face_id not in verified_faces:
        if sha256_file(path) != face_id:
            raise ValueError(f"SHA-256 файла не совпадает с именем: {path.name}")
        verified_faces.add(face_id)
    return face_id, path


def load_pairs(training_dir: Path) -> tuple[list[PairExample], dict[str, int]]:
    events_dir = training_dir / "events"
    faces_dir = training_dir / "faces"
    if not events_dir.is_dir() or not faces_dir.is_dir():
        raise ValueError("training_data должна содержать подпапки events и faces")

    raw_by_orientation: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    invalid = 0
    event_count = 0
    collectors: set[str] = set()
    verified_faces: set[str] = set()
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

    for path in sorted(events_dir.glob("*.json")):
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
            chosen_id, chosen_path = _face_ref(event, "chosen", training_dir, verified_faces)
            current_id, current_path = _face_ref(event, "current", training_dir, verified_faces)
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
                        event, "recommended", training_dir, verified_faces
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
        # Greedy component assignment keeps every face on only one side while
        # getting close to the requested validation size.
        val_groups: list[list[PairExample]] = []
        train_groups: list[list[PairExample]] = []
        val_count = 0
        for group in groups:
            if val_count < target and len(groups) - len(val_groups) > 1:
                val_groups.append(group)
                val_count += len(group)
            else:
                train_groups.append(group)
        if not train_groups:
            train_groups.append(val_groups.pop())
        val = [p for group in val_groups for p in group]
        train = [p for group in train_groups for p in group]
        if train and val:
            return train, val, "connected-components-no-face-overlap"

    # Rare fallback: all comparisons form one connected graph. We still retain
    # a validation set, but report that face leakage could not be eliminated.
    shuffled = list(pairs)
    rng.shuffle(shuffled)
    val_count = min(len(shuffled) - 1, target)
    val = shuffled[:val_count]
    train = shuffled[val_count:]
    return train, val, "pair-random-face-overlap-possible"


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
            x = (x - mean) / std
            emb = backbone(x)
            emb = torch.nn.functional.normalize(emb, p=2, dim=1)
            emb = emb.cpu()
            for (face_id, _path), row in zip(batch_items, emb):
                embeddings[face_id] = row.clone()
            done = min(len(items), start + len(batch_items))
            print(f"  {done}/{len(items)}", end="\r", flush=True)
    print()
    return embeddings, {
        "embedding_dim": dim,
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


def train_head(
    train_pairs: list[PairExample],
    val_pairs: list[PairExample],
    embeddings: dict[str, Any],
    seed: int,
    epochs: int,
    lr: float,
    weight_decay: float,
    patience: int,
) -> tuple[Any, dict[str, Any]]:
    _np, torch, _nn, F, _Image, _weights_enum, _mobilenet = _import_ml()
    torch.manual_seed(seed)
    train_diffs = tensor_pair_diffs(train_pairs, embeddings, torch)
    val_diffs = tensor_pair_diffs(val_pairs, embeddings, torch) if val_pairs else None
    dim = int(train_diffs.shape[1])

    weight = torch.nn.Parameter(torch.zeros(dim, dtype=torch.float32))
    optimizer = torch.optim.AdamW([weight], lr=lr, weight_decay=weight_decay)
    best_weight = weight.detach().clone()
    best_val = -float("inf")
    best_epoch = 0
    stale = 0

    for epoch in range(1, epochs + 1):
        optimizer.zero_grad(set_to_none=True)
        margins = train_diffs @ weight
        loss = F.softplus(-margins).mean()
        loss.backward()
        optimizer.step()

        train_acc, train_margin, train_loss = pair_metrics(weight.detach(), train_diffs, torch, F)
        if val_diffs is not None and val_diffs.numel() > 0:
            val_acc, val_margin, val_loss = pair_metrics(weight.detach(), val_diffs, torch, F)
            metric = -val_loss
        else:
            val_acc, val_margin, val_loss = float("nan"), float("nan"), float("nan")
            metric = -train_loss

        if metric > best_val + 1e-9:
            best_val = metric
            best_weight = weight.detach().clone()
            best_epoch = epoch
            stale = 0
        else:
            stale += 1

        if epoch == 1 or epoch % 25 == 0:
            val_text = "n/a" if math.isnan(val_acc) else f"{val_acc*100:.1f}% / loss={val_loss:.4f}"
            print(
                f"epoch {epoch:4d} | loss={float(loss.item()):.4f} | "
                f"train={train_acc*100:.1f}% | val={val_text}"
            )
        if stale >= patience:
            break

    final_train_acc, final_train_margin, final_train_loss = pair_metrics(best_weight, train_diffs, torch, F)
    if val_diffs is not None and val_diffs.numel() > 0:
        final_val_acc, final_val_margin, final_val_loss = pair_metrics(best_weight, val_diffs, torch, F)
    else:
        final_val_acc, final_val_margin, final_val_loss = float("nan"), float("nan"), float("nan")

    return best_weight, {
        "best_epoch": best_epoch,
        "epochs_run": epoch,
        "train_pair_accuracy": final_train_acc,
        "validation_pair_accuracy": final_val_acc,
        "train_mean_margin": final_train_margin,
        "validation_mean_margin": final_val_margin,
        "train_pair_loss": final_train_loss,
        "validation_pair_loss": final_val_loss,
    }


def export_onnx(weight: Any, output_path: Path, model_info: dict[str, Any]) -> None:
    _np, torch, nn, F, _Image, weights_enum, mobilenet = _import_ml()
    backbone, dim, _weights_name = build_backbone(torch, nn, mobilenet, weights_enum)

    class PersonalPreferenceModel(nn.Module):
        def __init__(self, backbone_model: Any, head_weight: Any) -> None:
            super().__init__()
            self.backbone = backbone_model
            self.register_buffer("mean", torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32).view(1, 3, 1, 1))
            self.register_buffer("std", torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32).view(1, 3, 1, 1))
            self.head = nn.Linear(dim, 1, bias=False)
            with torch.no_grad():
                self.head.weight.copy_(head_weight.view(1, -1))
            for p in self.parameters():
                p.requires_grad_(False)

        def forward(self, x: Any) -> Any:
            x = (x - self.mean) / self.std
            embedding = self.backbone(x)
            embedding = F.normalize(embedding, p=2, dim=1)
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


def write_report(output_dir: Path, metadata: dict[str, Any]) -> None:
    json_path = output_dir / "personal_preference.json"
    json_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    metrics = metadata["metrics"]
    val = metrics.get("validation_pair_accuracy")
    val_text = "нет отдельной validation выборки" if val is None else f"{val*100:.1f}%"
    report = f"""# Personal Preference Model — training report

Дата обучения: {metadata['trained_utc']}

- Событий найдено: {metadata['dataset']['events_found']}
- Уникальных непротиворечивых пар: {metadata['dataset']['unique_pairs']}
- Базовых пар `chosen > current`: {metadata['dataset']['unique_base_pairs']}
- Дополнительных уникальных пар `chosen > rejected recommendation`: {metadata['dataset']['additional_unique_recommendation_pairs']}
- Отклонений автоматической рекомендации в новых событиях: {metadata['dataset']['recommendation_overrides']}
- Train pairs: {metadata['dataset']['train_pairs']}
- Validation pairs: {metadata['dataset']['validation_pairs']}
- Способ разделения: `{metadata['dataset']['split_method']}`
- Коллекторов/экземпляров Group Face Picker: {metadata['dataset']['collectors']}
- Исключено противоречивых пар: {metadata['dataset']['contradictory_pairs_excluded']}
- Validation pair accuracy: **{val_text}**
- Train pair accuracy: **{metrics['train_pair_accuracy']*100:.1f}%**
- Backbone: `{metadata['model']['backbone']}`
- Выход: `0..1`, больше = ближе к вашим накопленным предпочтениям.

## Важно

Эта точность означает долю отложенных pairwise-сравнений, для которых модель правильно
предсказала ваше предпочтение. Старые события дают `chosen > current`; новые события могут
дополнительно дать `chosen > rejected recommendation`, если вы заменили предложенный кадр.
Она не является универсальной оценкой красоты человека.

Если `split_method` содержит `face-overlap-possible`, validation менее строгая: соберите больше
независимых сравнений и переобучите модель.

Текущая версия Photo Select AI пока не подключает этот файл автоматически. Не заменяйте им
публичный FBP вручную: интерфейс персональной модели будет добавлен отдельным обновлением.
"""
    (output_dir / "training_report.md").write_text(report, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Train a personal pairwise portrait-preference model from Group Face Picker statistics.")
    parser.add_argument("--data", default=str(DEFAULT_DATA), help="training_data folder or Group Face Picker folder")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="output directory")
    parser.add_argument("--validation", type=float, default=0.20, help="validation fraction (default 0.20)")
    parser.add_argument("--min-pairs", type=int, default=20, help="refuse training below this many unique pairs")
    parser.add_argument("--batch-size", type=int, default=32, help="embedding extraction batch size")
    parser.add_argument("--epochs", type=int, default=500)
    parser.add_argument("--patience", type=int, default=60)
    parser.add_argument("--lr", type=float, default=0.02)
    parser.add_argument("--weight-decay", type=float, default=0.002)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--device", choices=("cpu", "cuda", "auto"), default="auto")
    parser.add_argument("--check-data", action="store_true", help="validate/count dataset and exit before loading ML dependencies")
    args = parser.parse_args(argv)

    try:
        training_dir = resolve_training_dir(Path(args.data))
        output_dir = Path(args.output).expanduser().resolve()
        pairs, dataset_stats = load_pairs(training_dir)
        min_pairs = max(2, int(args.min_pairs))
        print(f"Dataset:      {training_dir}")
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

        validation_fraction = max(0.05, min(0.40, float(args.validation)))
        train_pairs, val_pairs, split_method = split_pairs_no_face_leakage(pairs, validation_fraction, int(args.seed))
        if not train_pairs:
            raise ValueError("Не удалось сформировать train выборку")

        _np, torch, _nn, _F, _Image, _weights_enum, _mobilenet = _import_ml()
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
        print(f"Train / val:   {len(train_pairs)} / {len(val_pairs)}")
        print(f"Split:         {split_method}")
        if len(pairs) < 100:
            print("WARNING: датасет пока маленький. Модель будет экспериментальной; продолжайте собирать статистику.")

        all_pairs = train_pairs + val_pairs
        embeddings, backbone_info = extract_embeddings(all_pairs, max(1, int(args.batch_size)), device)
        weight, metrics = train_head(
            train_pairs,
            val_pairs,
            embeddings,
            int(args.seed),
            max(10, int(args.epochs)),
            float(args.lr),
            max(0.0, float(args.weight_decay)),
            max(5, int(args.patience)),
        )

        output_dir.mkdir(parents=True, exist_ok=True)
        model_path = output_dir / "personal_preference.onnx"
        model_info = dict(backbone_info)
        export_onnx(weight, model_path, model_info)

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
                "train_pairs": len(train_pairs),
                "validation_pairs": len(val_pairs),
                "split_method": split_method,
                "validation_fraction_requested": validation_fraction,
            },
            "metrics": {
                **metrics,
                "validation_pair_accuracy": None if math.isnan(val_acc) else val_acc,
            },
            "training": {
                "seed": int(args.seed),
                "lr": float(args.lr),
                "weight_decay": float(args.weight_decay),
                "epochs_requested": int(args.epochs),
                "patience": int(args.patience),
                "device": device,
                "torch": str(torch.__version__),
            },
        }
        write_report(output_dir, metadata)

        print()
        print("Готово.")
        print(f"ONNX:   {model_path}")
        print(f"JSON:   {output_dir / 'personal_preference.json'}")
        print(f"Report: {output_dir / 'training_report.md'}")
        if val_acc is not None and not math.isnan(val_acc):
            print(f"Validation pair accuracy: {val_acc*100:.1f}%")
        if split_method != "connected-components-no-face-overlap":
            print("WARNING: validation содержит возможное пересечение лиц между train и validation.")
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
