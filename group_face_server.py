from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
from io import BytesIO
import os
import pickle
import shutil
import socket
import socketserver
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

APP_NAME = "Group Face Picker"
VERSION = "0.5.4"
SETTINGS_SCHEMA_VERSION = 6
SERVER_INSTANCE_ID = uuid.uuid4().hex[:12]
CACHE_VERSION = 11
QUERY_TTL_SECONDS = 30 * 60
JOB_TTL_SECONDS = 15 * 60
CACHE_CLEANUP_INTERVAL_SECONDS = 15 * 60
DEFAULT_CACHE_TTL_HOURS = 48
DEFAULT_MATCH_THRESHOLD = 0.28
DEFAULT_PREVIEW_SIZE = 96
DEFAULT_SERVER_HOST = "127.0.0.1"
DEFAULT_SERVER_PORT = 6420
DEFAULT_COMPUTE_MODE = "auto"
DEFAULT_SCAN_THREADS = 2
DEFAULT_PREVIEW_THREADS = 2
DEFAULT_ANALYSIS_QUALITY = "balanced"
DEFAULT_GROUP_BOUNDARY_SEARCH = False
DEFAULT_FACE_SCALE_MATCH = False
ANALYSIS_DET_SIZES = {"fast": 640, "balanced": 800, "accurate": 1024}
DET_THRESHOLD = 0.22
MAX_FACES = 80
RAW_EXTENSIONS = {
    ".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".rw2", ".orf"
}
SUPPORTED_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp", ".psd"
} | RAW_EXTENSIONS
FACE_CACHE_SIZE = 320
RECOGNITION_MIN_FACE_PIXELS = 160
GROUP_CHANGE_THRESHOLD = 0.20
GROUP_CHANGE_MIN_PEOPLE = 3
GROUP_STRONG_CHANGE_THRESHOLD = 0.35
GROUP_STRONG_CHANGE_MIN_PEOPLE = 4
GROUP_BOUNDARY_CONFIRM_FRAMES = 2
GROUP_IDENTITY_THRESHOLD = 0.48
GROUP_TARGET_PRESENCE_THRESHOLD = 0.38
GROUP_TARGET_MISS_STOP_FRAMES = 3
GROUP_RECENT_REFERENCE_FRAMES = 2
GROUP_CACHE_PREFIX = "group_"

ROOT = Path(__file__).resolve().parent
MODEL_ROOT = ROOT / "models" / "insightface"
RUNTIME_DIR = ROOT / "runtime"
CACHE_DIR = RUNTIME_DIR / "cache"
LOG_DIR = RUNTIME_DIR / "logs"
for directory in (CACHE_DIR, LOG_DIR):
    directory.mkdir(parents=True, exist_ok=True)

LOG_FILE = LOG_DIR / "group-face-server.log"
CONFIG_FILE = ROOT / "gfp_config.json"
DEFAULT_CONFIG = {
    "server_host": DEFAULT_SERVER_HOST,
    "server_port": DEFAULT_SERVER_PORT,
    "preview_size": DEFAULT_PREVIEW_SIZE,
    "cache_ttl_hours": DEFAULT_CACHE_TTL_HOURS,
    "match_threshold": DEFAULT_MATCH_THRESHOLD,
    "compute_mode": DEFAULT_COMPUTE_MODE,
    "scan_threads": DEFAULT_SCAN_THREADS,
    "preview_threads": DEFAULT_PREVIEW_THREADS,
    "analysis_quality": DEFAULT_ANALYSIS_QUALITY,
    "group_boundary_search": DEFAULT_GROUP_BOUNDARY_SEARCH,
    "face_scale_match": DEFAULT_FACE_SCALE_MATCH,
}
LOGGER = logging.getLogger(APP_NAME)
LOGGER.setLevel(logging.INFO)
LOGGER.propagate = False
LOGGER.handlers[:] = []
_fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(threadName)s: %(message)s", "%H:%M:%S")
_console = logging.StreamHandler(sys.stdout)
_console.setFormatter(_fmt)
LOGGER.addHandler(_console)
try:
    _file = logging.FileHandler(LOG_FILE, encoding="utf-8")
    _file.setFormatter(_fmt)
    LOGGER.addHandler(_file)
except OSError:
    pass


class UserVisibleError(RuntimeError):
    pass


CONFIG_LOCK = threading.RLock()
_RUNTIME_CONFIG: Optional[Dict[str, Any]] = None


def _config_with_defaults(data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    raw = dict(DEFAULT_CONFIG)
    if isinstance(data, dict):
        raw.update(data)
    server_host = str(raw.get("server_host") or DEFAULT_SERVER_HOST).strip() or DEFAULT_SERVER_HOST
    try:
        server_port = int(raw.get("server_port") or DEFAULT_SERVER_PORT)
    except Exception:
        server_port = DEFAULT_SERVER_PORT
    if server_port < 1 or server_port > 65535:
        server_port = DEFAULT_SERVER_PORT
    try:
        preview_size = int(raw.get("preview_size") or DEFAULT_PREVIEW_SIZE)
    except Exception:
        preview_size = DEFAULT_PREVIEW_SIZE
    preview_size = max(64, min(320, int(round(preview_size / 8.0) * 8)))
    try:
        cache_ttl_hours = int(raw.get("cache_ttl_hours") or DEFAULT_CACHE_TTL_HOURS)
    except Exception:
        cache_ttl_hours = DEFAULT_CACHE_TTL_HOURS
    cache_ttl_hours = max(12, min(168, cache_ttl_hours))
    try:
        match_threshold = float(raw.get("match_threshold") or DEFAULT_MATCH_THRESHOLD)
    except Exception:
        match_threshold = DEFAULT_MATCH_THRESHOLD
    match_threshold = max(0.10, min(0.60, match_threshold))
    compute_mode = str(raw.get("compute_mode") or DEFAULT_COMPUTE_MODE).strip().lower()
    if compute_mode not in ("auto", "cpu", "gpu"):
        compute_mode = DEFAULT_COMPUTE_MODE
    try:
        scan_threads = int(raw.get("scan_threads") or DEFAULT_SCAN_THREADS)
    except Exception:
        scan_threads = DEFAULT_SCAN_THREADS
    scan_threads = max(1, min(4, scan_threads))
    try:
        preview_threads = int(raw.get("preview_threads") or DEFAULT_PREVIEW_THREADS)
    except Exception:
        preview_threads = DEFAULT_PREVIEW_THREADS
    preview_threads = max(1, min(8, preview_threads))
    analysis_quality = str(raw.get("analysis_quality") or DEFAULT_ANALYSIS_QUALITY).strip().lower()
    if analysis_quality not in ANALYSIS_DET_SIZES:
        analysis_quality = DEFAULT_ANALYSIS_QUALITY
    group_boundary_search = bool(raw.get("group_boundary_search", DEFAULT_GROUP_BOUNDARY_SEARCH))
    face_scale_match = bool(raw.get("face_scale_match", DEFAULT_FACE_SCALE_MATCH))
    return {
        "server_host": server_host,
        "server_port": server_port,
        "preview_size": preview_size,
        "cache_ttl_hours": cache_ttl_hours,
        "match_threshold": match_threshold,
        "compute_mode": compute_mode,
        "scan_threads": scan_threads,
        "preview_threads": preview_threads,
        "analysis_quality": analysis_quality,
        "group_boundary_search": group_boundary_search,
        "face_scale_match": face_scale_match,
    }


def _load_runtime_config() -> Dict[str, Any]:
    global _RUNTIME_CONFIG
    with CONFIG_LOCK:
        if _RUNTIME_CONFIG is not None:
            return dict(_RUNTIME_CONFIG)
        data = None
        if CONFIG_FILE.is_file():
            try:
                data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            except Exception:
                LOGGER.warning("Could not read config file %s; defaults will be used.", CONFIG_FILE)
        _RUNTIME_CONFIG = _config_with_defaults(data)
        return dict(_RUNTIME_CONFIG)


def _save_runtime_config(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Persist normalized settings atomically and update live server state."""
    global _RUNTIME_CONFIG
    normalized = _config_with_defaults(settings)
    temp_file = CONFIG_FILE.with_suffix(CONFIG_FILE.suffix + ".tmp")
    try:
        payload = json.dumps(normalized, ensure_ascii=False, indent=2) + "\n"
        temp_file.write_text(payload, encoding="utf-8")
        os.replace(str(temp_file), str(CONFIG_FILE))
    except Exception as exc:
        try:
            if temp_file.exists():
                temp_file.unlink()
        except Exception:
            pass
        raise UserVisibleError("Could not save config file: %s" % exc) from exc
    try:
        persisted = _config_with_defaults(json.loads(CONFIG_FILE.read_text(encoding="utf-8")))
    except Exception as exc:
        raise UserVisibleError("Settings file was written but could not be verified: %s" % exc) from exc
    if persisted != normalized:
        raise UserVisibleError("Settings verification failed: values on disk differ from requested values.")
    with CONFIG_LOCK:
        _RUNTIME_CONFIG = dict(persisted)
    LOGGER.info("[SETTINGS] Saved and verified: %s", persisted)
    return dict(persisted)


def _get_runtime_config() -> Dict[str, Any]:
    return _load_runtime_config()


def _cache_ttl_seconds() -> int:
    return int(_get_runtime_config().get("cache_ttl_hours", DEFAULT_CACHE_TTL_HOURS) * 60 * 60)


def _match_threshold() -> float:
    return float(_get_runtime_config().get("match_threshold", DEFAULT_MATCH_THRESHOLD))


def _preview_size() -> int:
    return int(_get_runtime_config().get("preview_size", DEFAULT_PREVIEW_SIZE))


def _compute_mode() -> str:
    return str(_get_runtime_config().get("compute_mode", DEFAULT_COMPUTE_MODE))


def _scan_threads() -> int:
    return int(_get_runtime_config().get("scan_threads", DEFAULT_SCAN_THREADS))


def _preview_threads() -> int:
    return int(_get_runtime_config().get("preview_threads", DEFAULT_PREVIEW_THREADS))


def _analysis_quality() -> str:
    return str(_get_runtime_config().get("analysis_quality", DEFAULT_ANALYSIS_QUALITY))


def _det_size() -> int:
    return int(ANALYSIS_DET_SIZES.get(_analysis_quality(), ANALYSIS_DET_SIZES[DEFAULT_ANALYSIS_QUALITY]))


def _group_boundary_search() -> bool:
    return bool(_get_runtime_config().get("group_boundary_search", DEFAULT_GROUP_BOUNDARY_SEARCH))


def _face_scale_match() -> bool:
    return bool(_get_runtime_config().get("face_scale_match", DEFAULT_FACE_SCALE_MATCH))


def _analysis_signature() -> str:
    return "quality=%s;det=%d;group-boundary=%d" % (_analysis_quality(), _det_size(), 1 if _group_boundary_search() else 0)


CUDA_DLL_HANDLES: List[Any] = []

def _configure_private_cuda_dll_search_path() -> List[str]:
    """Expose CUDA/cuDNN DLLs installed by pip inside the private venv.

    On Windows the nvidia-* wheels keep DLLs below site-packages/nvidia/*/bin.
    Those directories are not automatically visible to the Windows loader when
    onnxruntime_providers_cuda.dll is loaded. Add them before importing ORT.
    """
    if os.name != "nt":
        return []

    candidate_roots: List[Path] = []
    for entry in sys.path:
        try:
            root = Path(entry) / "nvidia"
        except Exception:
            continue
        if root.is_dir():
            candidate_roots.append(root)

    dll_dirs: List[Path] = []
    seen = set()
    for root in candidate_roots:
        try:
            children = list(root.iterdir())
        except OSError:
            continue
        for child in children:
            for directory in (child / "bin", child / "lib", child / "lib" / "x64"):
                if not directory.is_dir():
                    continue
                key = os.path.normcase(str(directory.resolve()))
                if key in seen:
                    continue
                seen.add(key)
                dll_dirs.append(directory)

    if not dll_dirs:
        return []

    # PATH remains useful for child loads performed by native provider DLLs.
    existing_path = os.environ.get("PATH", "")
    existing_norm = {os.path.normcase(os.path.abspath(part)) for part in existing_path.split(os.pathsep) if part}
    prepend: List[str] = []
    for directory in dll_dirs:
        value = str(directory)
        if os.path.normcase(os.path.abspath(value)) not in existing_norm:
            prepend.append(value)
    if prepend:
        os.environ["PATH"] = os.pathsep.join(prepend + ([existing_path] if existing_path else []))

    # Python 3.8+ uses an explicit DLL search path on Windows. Keep the handles
    # alive for the lifetime of the process; closing them removes the paths.
    add_dll_directory = getattr(os, "add_dll_directory", None)
    if add_dll_directory is not None:
        for directory in dll_dirs:
            try:
                CUDA_DLL_HANDLES.append(add_dll_directory(str(directory)))
            except OSError:
                pass

    return [str(directory) for directory in dll_dirs]


@dataclass
class FaceRecord:
    bbox: Tuple[float, float, float, float]
    kps: List[List[float]]
    embedding: List[float]
    preview_jpeg: bytes = b""
    preview_master_path: str = ""


@dataclass
class DetectedFaceGeometry:
    bbox: Tuple[float, float, float, float]
    kps: List[List[float]]


@dataclass
class ImageRecord:
    path: str
    name: str
    width: int
    height: int
    source_width: int
    source_height: int
    faces: List[FaceRecord]


@dataclass
class GroupIndex:
    folder: str
    fingerprint: str
    images: List[ImageRecord]
    members: List[str]
    left_probe: str = ""
    right_probe: str = ""
    cache_id: str = ""


@dataclass
class QueryCandidate:
    source_path: str
    name: str
    width: int
    height: int
    analysis_width: int
    analysis_height: int
    face: FaceRecord
    similarity: float
    crop: Tuple[int, int, int, int]
    is_active: bool = False


@dataclass
class QueryContext:
    created_at: float
    target_eye_offsets: List[List[float]]
    target_face_width: float
    target_face_height: float
    candidates: List[QueryCandidate]


class FaceEngine:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._app = None
        self._providers: List[Any] = []
        self._using_cpu_fallback = False
        self._mode = DEFAULT_COMPUTE_MODE
        self._det_size = ANALYSIS_DET_SIZES[DEFAULT_ANALYSIS_QUALITY]

    def prepare(self) -> None:
        with self._lock:
            if self._app is not None:
                return
            mode = _compute_mode()
            det_size = _det_size()
            app, providers, fallback = self._create_app(mode, det_size)
            self._app = app
            self._providers = providers
            self._using_cpu_fallback = fallback
            self._mode = mode
            self._det_size = det_size
            LOGGER.info("Face engine ready. Mode: %s; Provider: %s; det-size: %dx%d", mode, self.provider_name(), det_size, det_size)

    def provider_name(self) -> str:
        if not self._providers:
            return "unknown"
        first = self._providers[0]
        if isinstance(first, (tuple, list)):
            first = first[0]
        suffix = " (CPU fallback)" if self._using_cpu_fallback else ""
        return str(first) + suffix

    def current_state(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "mode": self._mode,
                "provider": self.provider_name(),
                "det_size": self._det_size,
            }

    def _choose_providers(self, ort: Any, recognition_model: Path, mode: str) -> Tuple[List[Any], bool]:
        available = list(ort.get_available_providers())
        if mode == "cpu":
            if "CPUExecutionProvider" in available:
                return ["CPUExecutionProvider"], False
            raise UserVisibleError("CPUExecutionProvider is not available in ONNX Runtime.")

        if mode in ("auto", "gpu"):
            if "CUDAExecutionProvider" in available:
                dll_dirs = _configure_private_cuda_dll_search_path()
                if dll_dirs:
                    LOGGER.info("Private CUDA DLL paths enabled: %d", len(dll_dirs))
                try:
                    probe = ort.InferenceSession(
                        str(recognition_model),
                        providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
                    )
                    active = list(probe.get_providers())
                    del probe
                    if active and active[0] == "CUDAExecutionProvider":
                        LOGGER.info("CUDA provider probe succeeded.")
                        return ["CUDAExecutionProvider", "CPUExecutionProvider"], False
                    if mode == "gpu":
                        raise UserVisibleError("GPU mode was requested, but CUDAExecutionProvider did not activate.")
                    LOGGER.warning("CUDA provider is registered but did not activate; using CPUExecutionProvider.")
                except UserVisibleError:
                    raise
                except Exception as exc:
                    if mode == "gpu":
                        raise UserVisibleError("GPU mode cannot be enabled: %s" % exc) from exc
                    LOGGER.warning("CUDA provider probe failed; using CPUExecutionProvider: %s", exc)
            elif mode == "gpu":
                raise UserVisibleError("GPU mode was requested, but CUDAExecutionProvider is not installed/available.")

        if "CPUExecutionProvider" in available:
            return ["CPUExecutionProvider"], mode == "auto"
        if available and mode == "auto":
            return [available[0]], False
        raise UserVisibleError("ONNX Runtime has no usable execution provider.")

    def _create_app(self, mode: str, det_size: int):
        expected = MODEL_ROOT / "models" / "buffalo_l"
        missing = [name for name in ("det_10g.onnx", "w600k_r50.onnx") if not (expected / name).is_file()]
        if missing:
            raise UserVisibleError(
                "InsightFace buffalo_l is not installed: missing " + ", ".join(missing) + ". Run install.bat."
            )

        _configure_private_cuda_dll_search_path()
        try:
            import onnxruntime as ort
            from insightface.app import FaceAnalysis
        except Exception as exc:
            raise UserVisibleError("Python modules are incomplete. Run install.bat. Details: %s" % exc) from exc

        providers, fallback = self._choose_providers(ort, expected / "w600k_r50.onnx", mode)
        app = FaceAnalysis(
            name="buffalo_l",
            root=str(MODEL_ROOT),
            allowed_modules=["detection", "recognition"],
            providers=providers,
        )
        gpu = bool(providers and (providers[0][0] if isinstance(providers[0], tuple) else providers[0]) == "CUDAExecutionProvider")
        app.prepare(ctx_id=0 if gpu else -1, det_thresh=DET_THRESHOLD, det_size=(det_size, det_size))
        return app, providers, fallback

    def reconfigure(self, mode: str, det_size: int) -> Dict[str, Any]:
        mode = str(mode or DEFAULT_COMPUTE_MODE).lower()
        if mode not in ("auto", "cpu", "gpu"):
            mode = DEFAULT_COMPUTE_MODE
        det_size = int(det_size)
        with self._lock:
            if self._app is not None and self._mode == mode and self._det_size == det_size:
                return self.current_state()
            LOGGER.info("Reconfiguring face engine: mode=%s, det-size=%d", mode, det_size)
            app, providers, fallback = self._create_app(mode, det_size)
            self._app = app
            self._providers = providers
            self._using_cpu_fallback = fallback
            self._mode = mode
            self._det_size = det_size
            LOGGER.info("Face engine reconfigured. Provider: %s", self.provider_name())
            return self.current_state()

    def _snapshot(self) -> Tuple[Any, str, str, int]:
        self.prepare()
        with self._lock:
            app = self._app
            mode = self._mode
            first_provider = str(self._providers[0]) if self._providers else ""
            det_size = self._det_size
        return app, mode, first_provider, det_size

    def _cpu_fallback_app(self, failed_app: Any, det_size: int) -> Any:
        with self._lock:
            # Another worker may already have performed the fallback.
            if self._app is failed_app:
                fallback_app, providers, _ = self._create_app("cpu", det_size)
                self._app = fallback_app
                self._providers = providers
                self._using_cpu_fallback = True
            return self._app

    def detect_geometry(self, rgb: Any) -> List[DetectedFaceGeometry]:
        """Run SCRFD only; recognition is deliberately performed later on face crops.

        ``rgb`` is already a detector-sized image. SCRFD therefore never receives
        the original 20-60 MP frame and cannot allocate another full-size BGR copy.
        """
        import cv2
        import numpy as np

        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        app, mode, first_provider, det_size = self._snapshot()

        def run(current_app: Any):
            detector = current_app.det_model
            try:
                return detector.detect(bgr, max_num=0, metric="default")
            except TypeError:
                return detector.detect(bgr, max_num=0)

        try:
            bboxes, kpss = run(app)
        except Exception as exc:
            if mode == "auto" and "CUDAExecutionProvider" in first_provider:
                LOGGER.exception("CUDA detection failed in Auto mode; rebuilding InsightFace on CPU.")
                app = self._cpu_fallback_app(app, det_size)
                bboxes, kpss = run(app)
            else:
                raise exc

        h, w = rgb.shape[:2]
        result: List[DetectedFaceGeometry] = []
        if bboxes is None:
            return result
        for index in range(int(getattr(bboxes, "shape", [0])[0] or 0)):
            bbox = np.asarray(bboxes[index, :4], dtype=np.float32).reshape(-1)
            if bbox.size < 4:
                continue
            x1 = float(max(0.0, min(float(w), bbox[0])))
            y1 = float(max(0.0, min(float(h), bbox[1])))
            x2 = float(max(x1 + 1.0, min(float(w), bbox[2])))
            y2 = float(max(y1 + 1.0, min(float(h), bbox[3])))
            if kpss is None or index >= len(kpss):
                continue
            kps = np.asarray(kpss[index], dtype=np.float32)
            if kps.ndim != 2 or kps.shape[0] < 5 or kps.shape[1] < 2:
                continue
            points = [[float(kps[i, 0]), float(kps[i, 1])] for i in range(5)]
            result.append(DetectedFaceGeometry(bbox=(x1, y1, x2, y2), kps=points))
        result.sort(key=lambda item: (item.bbox[2] - item.bbox[0]) * (item.bbox[3] - item.bbox[1]), reverse=True)
        return result[:MAX_FACES]

    def recognize(self, rgb: Any, kps: List[List[float]]) -> List[float]:
        """Run ArcFace on one small local face region."""
        import cv2
        import numpy as np
        from insightface.app.common import Face

        if rgb is None or getattr(rgb, "size", 0) == 0:
            return []
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        points = np.asarray(kps, dtype=np.float32)
        if points.ndim != 2 or points.shape[0] < 5 or points.shape[1] < 2:
            return []
        app, mode, first_provider, det_size = self._snapshot()

        def run(current_app: Any):
            recognizer = current_app.models.get("recognition")
            if recognizer is None:
                raise UserVisibleError("InsightFace recognition model is not loaded.")
            face = Face(kps=points.copy())
            recognizer.get(bgr, face)
            value = getattr(face, "normed_embedding", None)
            if value is None:
                value = getattr(face, "embedding", None)
            return value

        try:
            emb_value = run(app)
        except Exception as exc:
            if mode == "auto" and "CUDAExecutionProvider" in first_provider:
                LOGGER.exception("CUDA recognition failed in Auto mode; rebuilding InsightFace on CPU.")
                app = self._cpu_fallback_app(app, det_size)
                emb_value = run(app)
            else:
                raise exc

        emb = np.asarray(emb_value if emb_value is not None else [], dtype=np.float32).reshape(-1)
        if emb.size == 0 or not np.all(np.isfinite(emb)):
            return []
        norm = float(np.linalg.norm(emb))
        if norm <= 1e-12:
            return []
        emb = emb / norm
        return [float(value) for value in emb]


ENGINE = FaceEngine()
INDEX_LOCK = threading.RLock()
ACTIVE_GROUP_INDEX: Optional[GroupIndex] = None
JOBS_LOCK = threading.RLock()
JOBS: Dict[str, Dict[str, Any]] = {}
QUERY_LOCK = threading.RLock()
QUERIES: Dict[str, QueryContext] = {}
CACHE_CLEANUP_LOCK = threading.RLock()
LAST_CACHE_CLEANUP = 0.0


def _set_active_group_index(index: Optional[GroupIndex]) -> None:
    """Keep only the current detected group in RAM; disk caches remain reusable."""
    global ACTIVE_GROUP_INDEX
    with INDEX_LOCK:
        previous = ACTIVE_GROUP_INDEX
        ACTIVE_GROUP_INDEX = index
    if previous is not None and previous is not index:
        LOGGER.info("[CACHE] Released previous group index from RAM: %s .. %s",
                    Path(previous.members[0]).name if previous.members else "?",
                    Path(previous.members[-1]).name if previous.members else "?")


def _norm_path(path: str) -> str:
    try:
        return os.path.normcase(os.path.abspath(path))
    except Exception:
        return os.path.normcase(path)


def _json_response(message_type: str, message: Any = None, **extra: Any) -> Dict[str, Any]:
    response = {"type": message_type, "message": message}
    response.update(extra)
    return response


def _is_raw_path(path: Path) -> bool:
    return path.suffix.lower() in RAW_EXTENSIONS


def _xmp_sidecar_for(path: Path) -> Path:
    return path.with_suffix(".xmp")


CRS_NS = "http://ns.adobe.com/camera-raw-settings/1.0/"
RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
XMPMETA_NS = "adobe:ns:meta/"


def _extract_camera_raw_settings_xmp(payload: bytes) -> Optional[bytes]:
    """Build a minimal XMP sidecar containing only Adobe Camera Raw settings.

    This intentionally avoids cloning ratings, captions, creator metadata, etc.
    Camera Raw settings are copied whether the source came from a sidecar or
    from Photoshop's xmpMetadata.rawData for an embedded-XMP RAW/DNG.
    """
    if not payload:
        return None
    try:
        import copy
        import xml.etree.ElementTree as ET

        ET.register_namespace("x", XMPMETA_NS)
        ET.register_namespace("rdf", RDF_NS)
        ET.register_namespace("crs", CRS_NS)
        root = ET.fromstring(payload)
        source_descriptions = root.findall(".//{%s}Description" % RDF_NS)
        if not source_descriptions:
            return None
        attrs: Dict[str, str] = {}
        children: List[Any] = []
        for desc in source_descriptions:
            for key, value in desc.attrib.items():
                if key.startswith("{%s}" % CRS_NS):
                    attrs[key] = value
            for child in list(desc):
                if str(child.tag).startswith("{%s}" % CRS_NS):
                    children.append(copy.deepcopy(child))
        if not attrs and not children:
            return None
        xmpmeta = ET.Element("{%s}xmpmeta" % XMPMETA_NS)
        rdf = ET.SubElement(xmpmeta, "{%s}RDF" % RDF_NS)
        desc = ET.SubElement(rdf, "{%s}Description" % RDF_NS)
        desc.set("{%s}about" % RDF_NS, "")
        for key, value in attrs.items():
            desc.set(key, value)
        for child in children:
            desc.append(child)
        body = ET.tostring(xmpmeta, encoding="utf-8", xml_declaration=False)
        return (
            b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
            + body
            + b'\n<?xpacket end="w"?>\n'
        )
    except Exception:
        LOGGER.exception("[RAW] Could not extract Camera Raw settings from XMP")
        return None


def _source_camera_raw_xmp(source_path: Path, photoshop_xmp: str = "") -> Optional[bytes]:
    sidecar = _xmp_sidecar_for(source_path)
    candidates: List[bytes] = []
    if sidecar.is_file():
        try:
            candidates.append(sidecar.read_bytes())
        except Exception:
            LOGGER.exception("[RAW] Could not read source XMP sidecar: %s", sidecar)
    if photoshop_xmp:
        try:
            candidates.append(str(photoshop_xmp).encode("utf-8"))
        except Exception:
            pass
    for payload in candidates:
        extracted = _extract_camera_raw_settings_xmp(payload)
        if extracted:
            return extracted
    return None


def _clone_source_xmp_to_group(source_path: Path, members: Iterable[str], photoshop_xmp: str = "") -> int:
    if not _is_raw_path(source_path):
        return 0
    payload = _source_camera_raw_xmp(source_path, photoshop_xmp)
    if not payload:
        LOGGER.info("[RAW] No Camera Raw XMP settings found for %s; sidecars were not cloned.", source_path.name)
        return 0
    copied = 0
    for value in members:
        candidate = Path(str(value))
        if not candidate.is_file() or _norm_path(str(candidate)) == _norm_path(str(source_path)) or not _is_raw_path(candidate):
            continue
        sidecar = _xmp_sidecar_for(candidate)
        if sidecar.exists():
            continue
        try:
            sidecar.write_bytes(payload)
            copied += 1
        except Exception:
            LOGGER.exception("[RAW] Could not create Camera Raw sidecar: %s", sidecar)
    if copied:
        LOGGER.info("[RAW] Camera Raw settings cloned to %d missing sidecar(s) inside the detected group.", copied)
    return copied


def _read_raw_preview_with_dimensions(path: Path):
    """Read the embedded RAW preview and native dimensions in one rawpy open."""
    from PIL import Image, ImageOps

    try:
        import rawpy
        with rawpy.imread(str(path)) as raw:
            width = int(raw.sizes.width)
            height = int(raw.sizes.height)
            thumb = raw.extract_thumb()

        if thumb.format == rawpy.ThumbFormat.JPEG:
            with Image.open(BytesIO(thumb.data)) as source:
                image = ImageOps.exif_transpose(source).convert("RGB").copy()
        else:
            source = Image.fromarray(thumb.data)
            try:
                image = source.convert("RGB")
            finally:
                try:
                    source.close()
                except Exception:
                    pass

        if width <= 0 or height <= 0:
            width, height = int(image.width), int(image.height)
        elif image.width > 0 and image.height > 0:
            preview_ratio = float(image.width) / float(image.height)
            direct = abs((float(width) / float(height)) - preview_ratio)
            swapped = abs((float(height) / float(width)) - preview_ratio)
            if swapped + 1e-6 < direct:
                width, height = height, width
        return image, int(width), int(height)
    except Exception as exc:
        raise UserVisibleError("Cannot read RAW preview %s: %s" % (path.name, exc)) from exc


def _scale_selection(selection: Dict[str, int], sx: float, sy: float) -> Dict[str, int]:
    return {
        "left": int(round(selection["left"] * sx)),
        "top": int(round(selection["top"] * sy)),
        "right": int(round(selection["right"] * sx)),
        "bottom": int(round(selection["bottom"] * sy)),
    }


def _exif_oriented_size(image: Any) -> Tuple[int, int]:
    width, height = int(image.width), int(image.height)
    try:
        orientation = int(image.getexif().get(274, 1) or 1)
    except Exception:
        orientation = 1
    if orientation in (5, 6, 7, 8):
        return height, width
    return width, height


def _transpose_exif_in_place(image: Any) -> Any:
    from PIL import ImageOps

    try:
        ImageOps.exif_transpose(image, in_place=True)
        return image
    except TypeError:
        # Pillow >=10.4 supports in_place. Keep a compatibility fallback for an
        # unexpectedly older private environment without changing behavior.
        return ImageOps.exif_transpose(image)


def _fit_detector_size(width: int, height: int, det_size: int) -> Tuple[int, int]:
    width = max(1, int(width))
    height = max(1, int(height))
    det_size = max(1, int(det_size))
    scale = min(1.0, float(det_size) / float(max(width, height)))
    return max(1, int(round(width * scale))), max(1, int(round(height * scale)))


def _read_detector_rgb(path: Path) -> Tuple[Any, int, int]:
    """Decode only a detector-sized frame and return its full oriented dimensions.

    JPEG uses libjpeg's draft/downsample-on-load path whenever available. Other
    formats are reduced before conversion to NumPy, which still avoids the old
    full-resolution RGB + BGR ndarray duplication. PSD may still need to decode
    its merged composite at native size, but SCRFD never sees that native array.
    """
    import numpy as np
    from PIL import Image

    det_size = _det_size()
    if _is_raw_path(path):
        preview, source_w, source_h = _read_raw_preview_with_dimensions(path)
        try:
            rgb = np.array(preview, dtype=np.uint8, copy=True)
        finally:
            try:
                preview.close()
            except Exception:
                pass
        return rgb, int(source_w), int(source_h)

    pillow_error: Optional[Exception] = None
    source = None
    try:
        source = Image.open(path)
        full_w, full_h = _exif_oriented_size(source)
        # JPEG draft asks libjpeg to decode close to the detector resolution
        # instead of materializing the native 40-60 MP image first.
        try:
            source.draft("RGB", (det_size, det_size))
        except Exception:
            pass
        oriented = _transpose_exif_in_place(source)
        if oriented is not source:
            try:
                source.close()
            except Exception:
                pass
            source = oriented
        target_w, target_h = _fit_detector_size(full_w, full_h, det_size)
        if (int(source.width), int(source.height)) != (target_w, target_h):
            resized = source.resize((target_w, target_h), resample=Image.Resampling.BILINEAR)
        else:
            resized = source
        try:
            if resized.mode != "RGB":
                converted = resized.convert("RGB")
            else:
                converted = resized
            try:
                rgb = np.array(converted, dtype=np.uint8, copy=True)
            finally:
                if converted is not resized:
                    converted.close()
        finally:
            if resized is not source:
                resized.close()
        return rgb, int(full_w), int(full_h)
    except Exception as exc:
        pillow_error = exc
    finally:
        if source is not None:
            try:
                source.close()
            except Exception:
                pass

    if path.suffix.lower() == ".psd":
        try:
            from psd_tools import PSDImage

            psd = PSDImage.open(path)
            full_w, full_h = int(psd.width), int(psd.height)
            image = psd.composite()
            if image is None:
                image = psd.topil()
            if image is None:
                raise RuntimeError("PSD has no readable merged composite")
            target_w, target_h = _fit_detector_size(full_w, full_h, det_size)
            resized = image.resize((target_w, target_h), resample=Image.Resampling.BILINEAR)
            try:
                converted = resized.convert("RGB")
                try:
                    return np.array(converted, dtype=np.uint8, copy=True), full_w, full_h
                finally:
                    converted.close()
            finally:
                resized.close()
                image.close()
        except Exception as exc:
            detail = "%s; psd-tools fallback: %s" % (pillow_error, exc) if pillow_error else str(exc)
            raise UserVisibleError("Cannot read PSD %s: %s" % (path.name, detail)) from exc

    raise UserVisibleError("Cannot read image %s: %s" % (path.name, pillow_error))


def _open_region_source(path: Path, min_scale: float = 1.0) -> Tuple[Any, int, int]:
    """Open an oriented image for small face-region crops, avoiding a full NumPy copy.

    For JPEG, ``min_scale`` may let libjpeg decode at 1/2, 1/4 or 1/8 native
    resolution while keeping enough pixels for ArcFace. Returned width/height are
    the native oriented dimensions; caller maps coordinates to the actual PIL size.
    """
    from PIL import Image

    if _is_raw_path(path):
        preview, source_w, source_h = _read_raw_preview_with_dimensions(path)
        return preview, int(source_w), int(source_h)

    pillow_error: Optional[Exception] = None
    source = None
    try:
        source = Image.open(path)
        raw_w, raw_h = int(source.width), int(source.height)
        full_w, full_h = _exif_oriented_size(source)
        min_scale = max(0.0, min(1.0, float(min_scale)))
        if min_scale < 0.999:
            try:
                # draft() operates before EXIF orientation, so request the
                # underlying JPEG dimensions rather than the oriented pair.
                source.draft(
                    "RGB",
                    (max(1, int(round(raw_w * min_scale))), max(1, int(round(raw_h * min_scale)))),
                )
            except Exception:
                pass
        oriented = _transpose_exif_in_place(source)
        if oriented is not source:
            try:
                source.close()
            except Exception:
                pass
            source = oriented
        return source, int(full_w), int(full_h)
    except Exception as exc:
        pillow_error = exc
        if source is not None:
            try:
                source.close()
            except Exception:
                pass

    if path.suffix.lower() == ".psd":
        try:
            from psd_tools import PSDImage

            psd = PSDImage.open(path)
            image = psd.composite()
            if image is None:
                image = psd.topil()
            if image is None:
                raise RuntimeError("PSD has no readable merged composite")
            return image, int(psd.width), int(psd.height)
        except Exception as exc:
            detail = "%s; psd-tools fallback: %s" % (pillow_error, exc) if pillow_error else str(exc)
            raise UserVisibleError("Cannot read PSD %s: %s" % (path.name, detail)) from exc

    raise UserVisibleError("Cannot read image %s: %s" % (path.name, pillow_error))


def _expanded_face_box(bbox: Tuple[float, float, float, float], width: int, height: int, factor: float = 1.85) -> Tuple[int, int, int, int]:
    bx1, by1, bx2, by2 = bbox
    bw = max(1.0, bx2 - bx1)
    bh = max(1.0, by2 - by1)
    side = max(bw, bh) * float(factor)
    cx = (bx1 + bx2) * 0.5
    cy = (by1 + by2) * 0.5
    left = max(0, int(math.floor(cx - side * 0.5)))
    top = max(0, int(math.floor(cy - side * 0.52)))
    right = min(int(width), int(math.ceil(cx + side * 0.5)))
    bottom = min(int(height), int(math.ceil(cy + side * 0.48)))
    if right <= left:
        right = min(int(width), left + 1)
    if bottom <= top:
        bottom = min(int(height), top + 1)
    return left, top, right, bottom


def _recognition_crop_from_pil(source: Any, full_bbox: Tuple[float, float, float, float], full_kps: List[List[float]], full_width: int, full_height: int) -> Tuple[Any, List[List[float]]]:
    import numpy as np

    source_w, source_h = int(source.width), int(source.height)
    sx = float(source_w) / float(max(1, full_width))
    sy = float(source_h) / float(max(1, full_height))
    scaled_bbox = (
        full_bbox[0] * sx,
        full_bbox[1] * sy,
        full_bbox[2] * sx,
        full_bbox[3] * sy,
    )
    scaled_kps = [[point[0] * sx, point[1] * sy] for point in full_kps]
    left, top, right, bottom = _expanded_face_box(scaled_bbox, source_w, source_h, factor=1.90)
    piece = source.crop((left, top, right, bottom))
    try:
        if piece.mode != "RGB":
            converted = piece.convert("RGB")
        else:
            converted = piece
        try:
            rgb = np.array(converted, dtype=np.uint8, copy=True)
        finally:
            if converted is not piece:
                converted.close()
    finally:
        piece.close()
    local_kps = [[point[0] - left, point[1] - top] for point in scaled_kps]
    return rgb, local_kps


def _build_face_preview_jpeg_from_pil(source: Any, full_bbox: Tuple[float, float, float, float], full_width: int, full_height: int, size: int = FACE_CACHE_SIZE) -> bytes:
    from PIL import Image, ImageOps

    source_w, source_h = int(source.width), int(source.height)
    sx = float(source_w) / float(max(1, full_width))
    sy = float(source_h) / float(max(1, full_height))
    scaled_bbox = (
        full_bbox[0] * sx,
        full_bbox[1] * sy,
        full_bbox[2] * sx,
        full_bbox[3] * sy,
    )
    bx1, by1, bx2, by2 = scaled_bbox
    bw = max(1.0, bx2 - bx1)
    bh = max(1.0, by2 - by1)
    side = max(bw, bh) * 1.55
    cx = (bx1 + bx2) * 0.5
    cy = (by1 + by2) * 0.5
    left = int(round(cx - side * 0.5))
    top = int(round(cy - side * 0.52))
    right = int(round(cx + side * 0.5))
    bottom = int(round(cy + side * 0.48))
    crop = Image.new("RGB", (max(1, right - left), max(1, bottom - top)), (25, 25, 25))
    preview = None
    piece = None
    try:
        src_box = (max(0, left), max(0, top), min(source_w, right), min(source_h, bottom))
        if src_box[2] > src_box[0] and src_box[3] > src_box[1]:
            piece = source.crop(src_box).convert("RGB")
            crop.paste(piece, (src_box[0] - left, src_box[1] - top))
        preview = ImageOps.fit(crop, (size, size), method=Image.Resampling.LANCZOS)
        buffer = BytesIO()
        preview.save(buffer, format="JPEG", quality=88)
        return buffer.getvalue()
    finally:
        if piece is not None:
            piece.close()
        if preview is not None:
            preview.close()
        crop.close()


def _scan_files(folder: Path) -> List[Path]:
    files = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS]
    return sorted(files, key=lambda p: p.name.casefold())


def _path_state(path: Path) -> Tuple[str, int, int]:
    stat = path.stat()
    return (_norm_path(str(path)), int(stat.st_size), int(stat.st_mtime_ns))


def _group_fingerprint(folder: Path, members: Iterable[str], left_probe: str = "", right_probe: str = "") -> str:
    """Fingerprint only the detected group plus the immediate boundary probes."""
    digest = hashlib.sha256()
    digest.update(_norm_path(str(folder)).encode("utf-8", "surrogatepass"))
    digest.update(_analysis_signature().encode("ascii"))
    for label, values in (("M", list(members)), ("L", [left_probe] if left_probe else []), ("R", [right_probe] if right_probe else [])):
        for value in values:
            path = Path(value)
            state = _path_state(path)
            digest.update(label.encode("ascii"))
            digest.update(state[0].encode("utf-8", "surrogatepass"))
            digest.update(str(state[1]).encode("ascii"))
            digest.update(str(state[2]).encode("ascii"))
    return digest.hexdigest()


def _group_cache_id(folder: Path, members: List[str]) -> str:
    first = _norm_path(members[0]) if members else ""
    last = _norm_path(members[-1]) if members else ""
    payload = "%s\n%s\n%s\n%s" % (_norm_path(str(folder)), first, last, _analysis_signature())
    return hashlib.sha256(payload.encode("utf-8", "surrogatepass")).hexdigest()[:24]


def _group_cache_paths(cache_id: str) -> Tuple[Path, Path]:
    stem = GROUP_CACHE_PREFIX + str(cache_id)
    return CACHE_DIR / (stem + ".pickle"), CACHE_DIR / (stem + ".json")


def _group_preview_dir(cache_id: str) -> Path:
    return CACHE_DIR / (GROUP_CACHE_PREFIX + str(cache_id) + "_faces")


def _preview_variant_path(face: FaceRecord, size: int) -> Path:
    master = Path(face.preview_master_path)
    if not master.is_file():
        raise UserVisibleError("Cached face preview is missing. The group cache must be rebuilt.")
    return master.with_name(master.stem + "_%03d.png" % int(size))


def _touch_group_cache(index: GroupIndex) -> None:
    cache_id = index.cache_id or _group_cache_id(Path(index.folder), index.members)
    for path in _group_cache_paths(cache_id):
        try:
            if path.is_file():
                os.utime(path, None)
        except OSError:
            pass
    preview_dir = _group_preview_dir(cache_id)
    try:
        if preview_dir.is_dir():
            os.utime(preview_dir, None)
    except OSError:
        pass


def _cleanup_disk_cache(force: bool = False) -> None:
    """Remove expired group caches and their cached face previews."""
    global LAST_CACHE_CLEANUP
    now = time.time()
    with CACHE_CLEANUP_LOCK:
        if not force and now - LAST_CACHE_CLEANUP < CACHE_CLEANUP_INTERVAL_SECONDS:
            return
        LAST_CACHE_CLEANUP = now
        removed = 0
        for path in list(CACHE_DIR.glob(GROUP_CACHE_PREFIX + "*.pickle")) + list(CACHE_DIR.glob("*.tmp")):
            try:
                age = now - path.stat().st_mtime
                cache_id = path.stem[len(GROUP_CACHE_PREFIX):] if path.name.startswith(GROUP_CACHE_PREFIX) and path.suffix == ".pickle" else ""
                incompatible = False
                if cache_id and force:
                    meta = CACHE_DIR / (GROUP_CACHE_PREFIX + cache_id + ".json")
                    try:
                        if meta.is_file():
                            incompatible = int(json.loads(meta.read_text(encoding="utf-8")).get("version") or 0) != CACHE_VERSION
                    except Exception:
                        incompatible = True
                if not incompatible and age <= _cache_ttl_seconds():
                    continue
                path.unlink()
                removed += 1
                if cache_id:
                    meta = CACHE_DIR / (GROUP_CACHE_PREFIX + cache_id + ".json")
                    try:
                        if meta.exists():
                            meta.unlink()
                    except OSError:
                        pass
                    shutil.rmtree(_group_preview_dir(cache_id), ignore_errors=True)
                LOGGER.info("[CACHE] Removed %s group cache: %s", "incompatible" if incompatible else "expired", path.name)
            except OSError:
                pass

        for meta in CACHE_DIR.glob(GROUP_CACHE_PREFIX + "*.json"):
            try:
                cache_id = str(meta.stem)[len(GROUP_CACHE_PREFIX):]
                pickle_path = CACHE_DIR / (GROUP_CACHE_PREFIX + cache_id + ".pickle")
                if not pickle_path.exists() and now - meta.stat().st_mtime > 60:
                    meta.unlink()
                    shutil.rmtree(_group_preview_dir(cache_id), ignore_errors=True)
            except OSError:
                pass

        # A process interruption during PNG/JPEG cache creation may leave .tmp
        # files inside a face-cache directory. They are never valid inputs.
        for temp_preview in CACHE_DIR.glob(GROUP_CACHE_PREFIX + "*_faces/*.tmp"):
            try:
                if now - temp_preview.stat().st_mtime > 60:
                    temp_preview.unlink()
            except OSError:
                pass

        # Remove orphaned face directories whose index no longer exists.
        for preview_dir in CACHE_DIR.glob(GROUP_CACHE_PREFIX + "*_faces"):
            try:
                if not preview_dir.is_dir():
                    continue
                name = preview_dir.name
                cache_id = name[len(GROUP_CACHE_PREFIX):-len("_faces")]
                pickle_path = CACHE_DIR / (GROUP_CACHE_PREFIX + cache_id + ".pickle")
                if not pickle_path.exists() and now - preview_dir.stat().st_mtime > 60:
                    shutil.rmtree(preview_dir, ignore_errors=True)
            except OSError:
                pass
        if removed:
            LOGGER.info("[CACHE] Expired group caches removed: %d", removed)


def _save_group_index(index: GroupIndex) -> None:
    if not index.members:
        raise RuntimeError("Cannot save an empty group index")
    cache_id = index.cache_id or _group_cache_id(Path(index.folder), index.members)
    index.cache_id = cache_id
    target, meta_target = _group_cache_paths(cache_id)
    preview_dir = _group_preview_dir(cache_id)
    # A changed file can rebuild the same first..last group range and therefore
    # reuse the same cache_id. Recreate the face directory so resized PNG
    # variants from the previous fingerprint can never survive the rebuild.
    if preview_dir.exists():
        shutil.rmtree(preview_dir)
    preview_dir.mkdir(parents=True, exist_ok=True)

    # Persist one small master JPEG per detected face. These files are the UI
    # preview source for all later child selections, so original 20–60 MP/PSD/RAW
    # files are never reopened just to build the chooser.
    for image_pos, image in enumerate(index.images):
        for face_pos, face in enumerate(image.faces):
            master = preview_dir / ("%04d_%03d.jpg" % (image_pos, face_pos))
            if face.preview_jpeg:
                temp_master = master.with_suffix(master.suffix + ".tmp")
                temp_master.write_bytes(face.preview_jpeg)
                os.replace(str(temp_master), str(master))
            elif not master.is_file() and face.preview_master_path:
                old_master = Path(face.preview_master_path)
                if old_master.is_file():
                    shutil.copyfile(str(old_master), str(master))
            if not master.is_file():
                raise RuntimeError("Could not persist cached preview for %s face %d" % (image.name, face_pos))
            face.preview_master_path = str(master)
            face.preview_jpeg = b""

    temp = target.with_name(target.name + ".tmp")
    meta_temp = meta_target.with_name(meta_target.name + ".tmp")
    payload = {"version": CACHE_VERSION, "index": index}
    with temp.open("wb") as stream:
        pickle.dump(payload, stream, protocol=pickle.HIGHEST_PROTOCOL)
    metadata = {
        "version": CACHE_VERSION,
        "cache_id": cache_id,
        "folder": index.folder,
        "fingerprint": index.fingerprint,
        "analysis_signature": _analysis_signature(),
        "members": index.members,
        "left_probe": index.left_probe,
        "right_probe": index.right_probe,
        "pickle": target.name,
    }
    meta_temp.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, target)
    os.replace(meta_temp, meta_target)


def _validate_group_layout(meta: Dict[str, Any], source_path: Path, files: List[Path]) -> bool:
    if int(meta.get("version") or 0) != CACHE_VERSION:
        return False
    if str(meta.get("analysis_signature") or "") != _analysis_signature():
        return False
    if _norm_path(str(meta.get("folder") or "")) != _norm_path(str(source_path.parent)):
        return False
    members = [str(value) for value in (meta.get("members") or [])]
    if not members:
        return False
    source_norm = _norm_path(str(source_path))
    member_norm = [_norm_path(value) for value in members]
    if source_norm not in member_norm:
        return False
    current_norm = [_norm_path(str(path)) for path in files]
    try:
        start = current_norm.index(member_norm[0])
    except ValueError:
        return False
    if current_norm[start:start + len(member_norm)] != member_norm:
        return False
    left_probe = str(meta.get("left_probe") or "")
    right_probe = str(meta.get("right_probe") or "")
    if left_probe:
        if start <= 0 or current_norm[start - 1] != _norm_path(left_probe):
            return False
    elif start != 0:
        return False
    end = start + len(member_norm) - 1
    if right_probe:
        if end + 1 >= len(current_norm) or current_norm[end + 1] != _norm_path(right_probe):
            return False
    elif end != len(current_norm) - 1:
        return False
    try:
        fingerprint = _group_fingerprint(source_path.parent, members, left_probe, right_probe)
    except OSError:
        return False
    return fingerprint == str(meta.get("fingerprint") or "")


def _load_group_cache_from_meta(meta: Dict[str, Any]) -> Optional[GroupIndex]:
    cache_id = str(meta.get("cache_id") or "")
    target = CACHE_DIR / str(meta.get("pickle") or (GROUP_CACHE_PREFIX + cache_id + ".pickle"))
    if not target.is_file():
        return None
    try:
        with target.open("rb") as stream:
            payload = pickle.load(stream)
        if payload.get("version") != CACHE_VERSION:
            return None
        index = payload.get("index")
        if not isinstance(index, GroupIndex):
            return None
        if index.fingerprint != str(meta.get("fingerprint") or ""):
            return None
        index.cache_id = cache_id or index.cache_id
        for image in index.images:
            for face in image.faces:
                if not face.preview_master_path or not Path(face.preview_master_path).is_file():
                    LOGGER.warning("[CACHE] Missing cached face preview; rebuilding group: %s", image.name)
                    return None
        _touch_group_cache(index)
        return index
    except Exception:
        LOGGER.exception("Could not read group cache %s", target)
        return None


def _find_cached_group(source_path: Path, files: List[Path]) -> Optional[GroupIndex]:
    source_norm = _norm_path(str(source_path))

    with INDEX_LOCK:
        active = ACTIVE_GROUP_INDEX
    if active is not None and source_norm in [_norm_path(value) for value in active.members]:
        meta = {
            "version": CACHE_VERSION,
            "analysis_signature": _analysis_signature(),
            "folder": active.folder,
            "members": active.members,
            "left_probe": active.left_probe,
            "right_probe": active.right_probe,
            "fingerprint": active.fingerprint,
        }
        if _validate_group_layout(meta, source_path, files):
            _touch_group_cache(active)
            LOGGER.info("[CACHE] Active group cache is current: %s .. %s", Path(active.members[0]).name, Path(active.members[-1]).name)
            return active

    for meta_path in CACHE_DIR.glob(GROUP_CACHE_PREFIX + "*.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        members = [str(value) for value in (meta.get("members") or [])]
        if source_norm not in [_norm_path(value) for value in members]:
            continue
        if not _validate_group_layout(meta, source_path, files):
            continue
        index = _load_group_cache_from_meta(meta)
        if index is None:
            continue
        _set_active_group_index(index)
        LOGGER.info("[CACHE] Loaded group cache from disk: %s .. %s (%d analyzed files)", Path(index.members[0]).name, Path(index.members[-1]).name, len(index.images))
        return index
    return None


def _update_job(job_id: str, **values: Any) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is not None:
            job.update(values)
            job["updated_at"] = time.time()


def _analyze_image_record(path: Path) -> ImageRecord:
    import numpy as np

    if _is_raw_path(path):
        # RAW already provides a comparatively small embedded preview. Keep that
        # preview as the analysis coordinate system and native dimensions only
        # for the final Photoshop/Camera Raw mapping.
        source, native_w, native_h = _read_raw_preview_with_dimensions(path)
        try:
            analysis_w, analysis_h = int(source.width), int(source.height)
            target_w, target_h = _fit_detector_size(analysis_w, analysis_h, _det_size())
            if (analysis_w, analysis_h) != (target_w, target_h):
                from PIL import Image
                detector_image = source.resize((target_w, target_h), resample=Image.Resampling.BILINEAR)
            else:
                detector_image = source
            try:
                if detector_image.mode != "RGB":
                    converted = detector_image.convert("RGB")
                else:
                    converted = detector_image
                try:
                    detector_rgb = np.array(converted, dtype=np.uint8, copy=True)
                finally:
                    if converted is not detector_image:
                        converted.close()
            finally:
                if detector_image is not source:
                    detector_image.close()
            detector_h, detector_w = detector_rgb.shape[:2]
            detected = ENGINE.detect_geometry(detector_rgb)
            raw_sx = float(analysis_w) / float(max(1, detector_w))
            raw_sy = float(analysis_h) / float(max(1, detector_h))
            geometries = []
            for geometry in detected:
                bx1, by1, bx2, by2 = geometry.bbox
                geometries.append(DetectedFaceGeometry(
                    bbox=(bx1 * raw_sx, by1 * raw_sy, bx2 * raw_sx, by2 * raw_sy),
                    kps=[[point[0] * raw_sx, point[1] * raw_sy] for point in geometry.kps],
                ))
            faces: List[FaceRecord] = []
            for geometry in geometries:
                try:
                    crop_rgb, local_kps = _recognition_crop_from_pil(
                        source, geometry.bbox, geometry.kps, analysis_w, analysis_h
                    )
                    embedding = ENGINE.recognize(crop_rgb, local_kps)
                    if not embedding:
                        continue
                    preview = _build_face_preview_jpeg_from_pil(
                        source, geometry.bbox, analysis_w, analysis_h, FACE_CACHE_SIZE
                    )
                    faces.append(
                        FaceRecord(
                            bbox=geometry.bbox,
                            kps=[[float(point[0]), float(point[1])] for point in geometry.kps[:5]],
                            embedding=embedding,
                            preview_jpeg=preview,
                        )
                    )
                except Exception:
                    LOGGER.exception("[INDEX] Could not recognize/cache RAW face for %s", path.name)
        finally:
            try:
                source.close()
            except Exception:
                pass
        return ImageRecord(
            path=str(path),
            name=path.name,
            width=analysis_w,
            height=analysis_h,
            source_width=int(native_w),
            source_height=int(native_h),
            faces=faces,
        )

    detector_rgb, full_w, full_h = _read_detector_rgb(path)
    det_h, det_w = detector_rgb.shape[:2]
    geometries = ENGINE.detect_geometry(detector_rgb)
    if not geometries:
        return ImageRecord(
            path=str(path),
            name=path.name,
            width=int(full_w),
            height=int(full_h),
            source_width=int(full_w),
            source_height=int(full_h),
            faces=[],
        )

    sx = float(full_w) / float(max(1, det_w))
    sy = float(full_h) / float(max(1, det_h))
    mapped: List[DetectedFaceGeometry] = []
    for geometry in geometries:
        bx1, by1, bx2, by2 = geometry.bbox
        mapped.append(
            DetectedFaceGeometry(
                bbox=(bx1 * sx, by1 * sy, bx2 * sx, by2 * sy),
                kps=[[point[0] * sx, point[1] * sy] for point in geometry.kps],
            )
        )

    # ArcFace needs only a small aligned face. For JPEG ask libjpeg for the
    # smallest native downsample that still leaves the smallest detected face
    # around RECOGNITION_MIN_FACE_PIXELS. PNG/TIFF/PSD may decode natively, but
    # they still never become a full-frame NumPy/BGR array.
    smallest_face = min(
        max(1.0, max(item.bbox[2] - item.bbox[0], item.bbox[3] - item.bbox[1]))
        for item in mapped
    )
    recognition_scale = min(1.0, float(RECOGNITION_MIN_FACE_PIXELS) / float(smallest_face))
    source, source_full_w, source_full_h = _open_region_source(path, recognition_scale)
    recognition_w, recognition_h = int(source.width), int(source.height)
    try:
        # The two readers should describe the same oriented document. If a rare
        # metadata path disagrees, remap the already detected geometry rather
        # than silently shifting faces.
        if (int(source_full_w), int(source_full_h)) != (int(full_w), int(full_h)):
            LOGGER.warning(
                "[INDEX] Geometry size mismatch for %s: detector=%dx%d region=%dx%d",
                path.name, full_w, full_h, source_full_w, source_full_h,
            )
            adjust_x = float(source_full_w) / float(max(1, full_w))
            adjust_y = float(source_full_h) / float(max(1, full_h))
            remapped: List[DetectedFaceGeometry] = []
            for geometry in mapped:
                bx1, by1, bx2, by2 = geometry.bbox
                remapped.append(DetectedFaceGeometry(
                    bbox=(bx1 * adjust_x, by1 * adjust_y, bx2 * adjust_x, by2 * adjust_y),
                    kps=[[point[0] * adjust_x, point[1] * adjust_y] for point in geometry.kps],
                ))
            mapped = remapped
            full_w, full_h = int(source_full_w), int(source_full_h)

        faces: List[FaceRecord] = []
        for geometry in mapped:
            try:
                crop_rgb, local_kps = _recognition_crop_from_pil(
                    source, geometry.bbox, geometry.kps, int(full_w), int(full_h)
                )
                embedding = ENGINE.recognize(crop_rgb, local_kps)
                if not embedding:
                    continue
                preview = _build_face_preview_jpeg_from_pil(
                    source, geometry.bbox, int(full_w), int(full_h), FACE_CACHE_SIZE
                )
                faces.append(
                    FaceRecord(
                        bbox=geometry.bbox,
                        kps=[[float(point[0]), float(point[1])] for point in geometry.kps[:5]],
                        embedding=embedding,
                        preview_jpeg=preview,
                    )
                )
            except Exception:
                LOGGER.exception("[INDEX] Could not recognize/cache face for %s", path.name)
    finally:
        try:
            source.close()
        except Exception:
            pass

    LOGGER.info(
        "[INDEX] %s detector-frame=%dx%d native=%dx%d recognition-source=%dx%d",
        path.name, det_w, det_h, full_w, full_h,
        recognition_w, recognition_h,
    )
    return ImageRecord(
        path=str(path),
        name=path.name,
        width=int(full_w),
        height=int(full_h),
        source_width=int(full_w),
        source_height=int(full_h),
        faces=faces,
    )


def _group_change_stats(anchor_faces: List[FaceRecord], candidate_faces: List[FaceRecord]) -> Dict[str, Any]:
    anchor_count = len(anchor_faces)
    candidate_count = len(candidate_faces)
    if anchor_count <= 0:
        return {"matched": 0, "missing": 0, "new": candidate_count, "changed": candidate_count, "fraction": 1.0 if candidate_count else 0.0, "boundary": False, "strong": False}
    pairs: List[Tuple[float, int, int]] = []
    threshold = GROUP_IDENTITY_THRESHOLD
    for ai, anchor in enumerate(anchor_faces):
        for ci, candidate in enumerate(candidate_faces):
            similarity = _cosine(anchor.embedding, candidate.embedding)
            if similarity >= threshold:
                pairs.append((similarity, ai, ci))
    pairs.sort(reverse=True, key=lambda value: value[0])
    used_a = set()
    used_c = set()
    for similarity, ai, ci in pairs:
        if ai in used_a or ci in used_c:
            continue
        used_a.add(ai)
        used_c.add(ci)
    matched = len(used_a)
    missing = max(0, anchor_count - matched)
    new = max(0, candidate_count - matched)
    changed = max(missing, new)
    denom = max(1, anchor_count, candidate_count)
    fraction = float(changed) / float(denom)
    required = max(GROUP_CHANGE_MIN_PEOPLE, int(math.ceil(float(denom) * GROUP_CHANGE_THRESHOLD)))
    strong_required = max(GROUP_STRONG_CHANGE_MIN_PEOPLE, int(math.ceil(float(denom) * GROUP_STRONG_CHANGE_THRESHOLD)))
    return {
        "matched": matched,
        "missing": missing,
        "new": new,
        "changed": changed,
        "fraction": fraction,
        "boundary": changed >= required and fraction + 1e-9 >= GROUP_CHANGE_THRESHOLD,
        "strong": changed >= strong_required and fraction + 1e-9 >= GROUP_STRONG_CHANGE_THRESHOLD,
    }


def _best_face_similarity(reference: Optional[FaceRecord], faces: List[FaceRecord]) -> float:
    if reference is None or not faces:
        return -1.0
    return max((_cosine(reference.embedding, face.embedding) for face in faces), default=-1.0)


def _boundary_reference_stats(reference_sets: List[List[FaceRecord]], candidate_faces: List[FaceRecord]) -> Dict[str, Any]:
    stats_list = [_group_change_stats(reference_faces, candidate_faces) for reference_faces in reference_sets if reference_faces]
    if not stats_list:
        return {"boundary": False, "strong": False, "changed": 0, "fraction": 0.0, "matched": 0, "missing": 0, "new": len(candidate_faces)}
    # The frame is considered a roster boundary only when it differs from every
    # recent reference frame. This makes transient detection misses much less
    # likely to terminate the current group.
    boundary = all(bool(item.get("boundary")) for item in stats_list)
    strong = all(bool(item.get("strong")) for item in stats_list)
    # Log/report the most conservative (smallest-change) comparison.
    representative = min(stats_list, key=lambda item: (float(item.get("fraction", 0.0)), int(item.get("changed", 0))))
    result = dict(representative)
    result["boundary"] = boundary
    result["strong"] = strong
    return result


def _reference_face_for_group_scan(source_record: ImageRecord, source_path: Path, selection: Dict[str, int], doc_width: int, doc_height: int) -> Optional[FaceRecord]:
    local_selection = dict(selection)
    if source_record.width != doc_width or source_record.height != doc_height:
        if _is_raw_path(source_path):
            sx = float(source_record.width) / float(max(1, doc_width))
            sy = float(source_record.height) / float(max(1, doc_height))
            local_selection = _scale_selection(selection, sx, sy)
        else:
            return None
    return _find_reference_in_image(source_record, local_selection)


def _build_group_index(folder: Path, source_path: Path, selection: Dict[str, int], doc_width: int, doc_height: int, job_id: Optional[str] = None) -> GroupIndex:
    files = _scan_files(folder)
    if not files:
        raise UserVisibleError("No supported image files were found in: %s" % folder)
    source_norm = _norm_path(str(source_path))
    ordered_norm = [_norm_path(str(path)) for path in files]
    try:
        source_pos = ordered_norm.index(source_norm)
    except ValueError:
        raise UserVisibleError("The active Photoshop file is not among the supported images in its folder.")

    cached = _find_cached_group(source_path, files)
    if cached is not None:
        if job_id:
            _update_job(job_id, progress=0.72, status="running", text="Кэш этой группы актуален.")
        return cached

    # The previous group's heavy face/thumbnail index is no longer needed in RAM.
    # Keep only the lightweight disk cache while discovering the new group.
    _set_active_group_index(None)

    if not _group_boundary_search():
        LOGGER.info("[GROUP] Boundary search disabled; treating all %d supported files as one group.", len(files))
        if job_id:
            _update_job(job_id, progress=0.03, status="running", text="Анализ всей папки: 0/%d" % len(files))

        records: List[ImageRecord] = []
        total_files = max(1, len(files))
        threads = max(1, min(_scan_threads(), len(files)))

        if threads <= 1:
            for completed, path in enumerate(files, start=1):
                try:
                    record = _analyze_image_record(path)
                    records.append(record)
                except Exception as exc:
                    LOGGER.exception("[GROUP] Failed to analyze: %s", path)
                    LOGGER.warning("[GROUP] Skipping %s: %s", path.name, exc)
                if job_id:
                    _update_job(job_id, progress=0.03 + (completed / float(total_files)) * 0.69, status="running", text="Анализ всей папки %d/%d: %s" % (completed, len(files), path.name))
        else:
            completed = 0
            with ThreadPoolExecutor(max_workers=threads, thread_name_prefix="FolderScan") as pool:
                future_map = {pool.submit(_analyze_image_record, path): path for path in files}
                for future in as_completed(future_map):
                    path = future_map[future]
                    completed += 1
                    try:
                        records.append(future.result())
                    except Exception as exc:
                        LOGGER.exception("[GROUP] Failed to analyze: %s", path)
                        LOGGER.warning("[GROUP] Skipping %s: %s", path.name, exc)
                    if job_id:
                        _update_job(job_id, progress=0.03 + (completed / float(total_files)) * 0.69, status="running", text="Анализ всей папки %d/%d: %s" % (completed, len(files), path.name))

        records.sort(key=lambda item: item.name.casefold())
        if not records:
            raise UserVisibleError("No images in the folder could be analyzed.")
        members = [str(path) for path in files]
        fingerprint = _group_fingerprint(folder, members, "", "")
        cache_id = _group_cache_id(folder, members)
        index = GroupIndex(
            folder=str(folder),
            fingerprint=fingerprint,
            images=records,
            members=members,
            left_probe="",
            right_probe="",
            cache_id=cache_id,
        )
        _set_active_group_index(index)
        try:
            _save_group_index(index)
        except Exception as exc:
            _set_active_group_index(None)
            LOGGER.exception("[CACHE] Failed to save folder-as-group index.")
            raise UserVisibleError("Could not save the group cache and face previews: %s" % exc) from exc
        LOGGER.info("[CACHE] Whole-folder group cache saved: %d files, %d analyzed", len(members), len(records))
        if job_id:
            _update_job(job_id, progress=0.72, status="running", text="Вся папка принята за одну группу: %d кадров" % len(members))
        return index

    LOGGER.info("[GROUP] Detecting group around: %s", source_path.name)
    LOGGER.info("[GROUP] Boundary: >=%.0f%% and >=%d people; %d-frame confirmation; identity threshold %.2f", GROUP_CHANGE_THRESHOLD * 100.0, GROUP_CHANGE_MIN_PEOPLE, GROUP_BOUNDARY_CONFIRM_FRAMES, GROUP_IDENTITY_THRESHOLD)
    if job_id:
        _update_job(job_id, progress=0.03, status="running", text="Анализ опорного кадра: %s" % source_path.name)
    try:
        source_record = _analyze_image_record(source_path)
    except Exception as exc:
        raise UserVisibleError("Could not analyze the active group image %s: %s" % (source_path.name, exc)) from exc

    anchor_faces = list(source_record.faces)
    selected_reference = _reference_face_for_group_scan(source_record, source_path, selection, doc_width, doc_height)
    roster_enabled = len(anchor_faces) >= GROUP_CHANGE_MIN_PEOPLE
    if not roster_enabled:
        LOGGER.warning("[GROUP] Only %d faces detected in the anchor frame; roster-change evidence is limited. Target-presence fallback remains enabled.", len(anchor_faces))
    if selected_reference is None:
        LOGGER.warning("[GROUP] Could not identify the selected reference face in the anchor frame for boundary detection.")

    progress_lock = threading.RLock()
    processed = [1]
    total = max(1, len(files))

    def mark_progress(path: Path, side: str) -> None:
        with progress_lock:
            processed[0] += 1
            value = 0.03 + min(1.0, float(processed[0]) / float(total)) * 0.69
        if job_id:
            _update_job(job_id, progress=value, status="running", text="Поиск границ группы (%s): %s" % (side, path.name))

    def scan_direction(indices: Iterable[int], side: str) -> Dict[str, Any]:
        accepted_records: List[Tuple[int, ImageRecord]] = []
        accepted_indices: List[int] = []
        pending_boundaries: List[Tuple[int, ImageRecord, Dict[str, Any]]] = []
        unresolved: List[int] = []
        boundary_probe = ""
        recent_face_sets: List[List[FaceRecord]] = [anchor_faces] if anchor_faces else []
        consecutive_target_misses = 0

        for position in indices:
            path = files[position]
            try:
                record = _analyze_image_record(path)
            except Exception as exc:
                LOGGER.exception("[GROUP] Failed to analyze probe: %s", path)
                LOGGER.warning("[GROUP] Could not classify %s; waiting for the next reliable frame: %s", path.name, exc)
                unresolved.append(position)
                mark_progress(path, side)
                continue

            mark_progress(path, side)
            reference_sets = recent_face_sets[-(GROUP_RECENT_REFERENCE_FRAMES + 1):]
            stats = _boundary_reference_stats(reference_sets, record.faces) if roster_enabled else {"boundary": False, "strong": False, "changed": 0, "fraction": 0.0, "matched": 0, "missing": 0, "new": 0}
            target_similarity = _best_face_similarity(selected_reference, record.faces)
            target_present = selected_reference is not None and target_similarity >= GROUP_TARGET_PRESENCE_THRESHOLD
            if selected_reference is not None:
                consecutive_target_misses = 0 if target_present else consecutive_target_misses + 1

            roster_boundary = bool(stats.get("boundary"))
            strong_boundary = bool(stats.get("strong"))
            target_fallback_boundary = (
                selected_reference is not None
                and consecutive_target_misses >= GROUP_TARGET_MISS_STOP_FRAMES
                and (
                    (roster_enabled and float(stats.get("fraction", 0.0)) >= max(0.10, GROUP_CHANGE_THRESHOLD * 0.5))
                    or (not roster_enabled and len(record.faces) >= GROUP_CHANGE_MIN_PEOPLE)
                )
            )
            candidate_boundary = roster_boundary
            immediate_boundary = strong_boundary

            LOGGER.info(
                "[GROUP] %-6s %-40s faces=%d matched=%d changed=%d (%.1f%%) target=%.3f misses=%d%s",
                side, path.name, len(record.faces), int(stats.get("matched", 0)), int(stats.get("changed", 0)),
                float(stats.get("fraction", 0.0)) * 100.0, target_similarity, consecutive_target_misses,
                " BOUNDARY" if candidate_boundary or target_fallback_boundary else "",
            )

            if candidate_boundary or target_fallback_boundary:
                pending_boundaries.append((position, record, stats))
                if immediate_boundary or target_fallback_boundary or len(pending_boundaries) >= GROUP_BOUNDARY_CONFIRM_FRAMES:
                    boundary_probe = str(files[pending_boundaries[0][0]])
                    LOGGER.info("[GROUP] %s boundary confirmed at %s; stopping this direction.", side, Path(boundary_probe).name)
                    break
                continue

            # A reliable same-group frame after one suspicious frame means the
            # suspicious frame was most likely a transient detector miss. Keep it.
            if pending_boundaries:
                for pending_pos, pending_record, _ in pending_boundaries:
                    accepted_indices.append(pending_pos)
                    accepted_records.append((pending_pos, pending_record))
                    if pending_record.faces:
                        recent_face_sets.append(list(pending_record.faces))
                pending_boundaries = []
            if unresolved:
                accepted_indices.extend(unresolved)
                unresolved = []
            accepted_indices.append(position)
            accepted_records.append((position, record))
            if record.faces:
                recent_face_sets.append(list(record.faces))
                if len(recent_face_sets) > GROUP_RECENT_REFERENCE_FRAMES + 1:
                    # Keep the anchor plus a short rolling window of accepted frames.
                    recent_face_sets = [anchor_faces] + recent_face_sets[-GROUP_RECENT_REFERENCE_FRAMES:]

        if not boundary_probe:
            # At folder edge a single non-strong suspicious frame is not enough
            # evidence to throw it away; keep it in the current group.
            for pending_pos, pending_record, _ in pending_boundaries:
                accepted_indices.append(pending_pos)
                accepted_records.append((pending_pos, pending_record))
            accepted_indices.extend(unresolved)
        return {"records": accepted_records, "indices": accepted_indices, "probe": boundary_probe}

    left_indices = range(source_pos - 1, -1, -1)
    right_indices = range(source_pos + 1, len(files))
    # Only two ordered directions may be processed concurrently. This preserves
    # early stopping and avoids decoding batches deep inside neighboring groups.
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="GroupEdge") as pool:
        left_future = pool.submit(scan_direction, left_indices, "назад")
        right_future = pool.submit(scan_direction, right_indices, "вперёд")
        left = left_future.result()
        right = right_future.result()

    member_indices = set([source_pos] + list(left["indices"]) + list(right["indices"]))
    if not member_indices:
        member_indices = {source_pos}
    first_pos = min(member_indices)
    last_pos = max(member_indices)
    # The group is a contiguous file range. Any unreadable file between accepted
    # endpoints is still a member, even though it has no ImageRecord.
    members = [str(path) for path in files[first_pos:last_pos + 1]]
    records_by_pos: Dict[int, ImageRecord] = {source_pos: source_record}
    for pos, record in list(left["records"]) + list(right["records"]):
        if first_pos <= pos <= last_pos:
            records_by_pos[pos] = record
    images = [records_by_pos[pos] for pos in sorted(records_by_pos) if first_pos <= pos <= last_pos]

    left_probe = str(files[first_pos - 1]) if first_pos > 0 else ""
    right_probe = str(files[last_pos + 1]) if last_pos + 1 < len(files) else ""
    # Prefer the actual confirmed probe when available; adjacency should match.
    if left.get("probe"):
        left_probe = str(left["probe"])
    if right.get("probe"):
        right_probe = str(right["probe"])

    fingerprint = _group_fingerprint(folder, members, left_probe, right_probe)
    cache_id = _group_cache_id(folder, members)
    index = GroupIndex(
        folder=str(folder),
        fingerprint=fingerprint,
        images=images,
        members=members,
        left_probe=left_probe,
        right_probe=right_probe,
        cache_id=cache_id,
    )
    _set_active_group_index(index)
    try:
        _save_group_index(index)
    except Exception as exc:
        _set_active_group_index(None)
        LOGGER.exception("[CACHE] Failed to save group index.")
        raise UserVisibleError("Could not save the group cache and face previews: %s" % exc) from exc
    LOGGER.info("[CACHE] Group cache saved: %s .. %s (%d files, %d analyzed)", Path(members[0]).name, Path(members[-1]).name, len(members), len(images))
    if job_id:
        _update_job(job_id, progress=0.72, status="running", text="Группа определена: %d кадров" % len(members))
    return index

def _overlap_area(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> float:
    left = max(a[0], b[0])
    top = max(a[1], b[1])
    right = min(a[2], b[2])
    bottom = min(a[3], b[3])
    return max(0.0, right - left) * max(0.0, bottom - top)


def _find_reference_in_image(image: ImageRecord, selection: Dict[str, int]) -> Optional[FaceRecord]:
    rect = (float(selection["left"]), float(selection["top"]), float(selection["right"]), float(selection["bottom"]))
    sx = (rect[0] + rect[2]) * 0.5
    sy = (rect[1] + rect[3]) * 0.5
    sw = max(1.0, rect[2] - rect[0])
    sh = max(1.0, rect[3] - rect[1])
    best = None
    best_score = -1e9
    for face in image.faces:
        x1, y1, x2, y2 = face.bbox
        cx = (x1 + x2) * 0.5
        cy = (y1 + y2) * 0.5
        area = max(1.0, (x2 - x1) * (y2 - y1))
        overlap = _overlap_area(face.bbox, rect) / area
        inside = 1.0 if rect[0] <= cx <= rect[2] and rect[1] <= cy <= rect[3] else 0.0
        dist = math.sqrt(((cx - sx) / sw) ** 2 + ((cy - sy) / sh) ** 2)
        score = 4.0 * inside + 2.0 * overlap - dist
        if score > best_score:
            best = face
            best_score = score
    if best is None:
        return None
    if _overlap_area(best.bbox, rect) <= 0:
        return None
    return best


def _detect_reference_targeted(path: Path, selection: Dict[str, int]) -> Optional[FaceRecord]:
    """Rare fallback: analyze only the selected neighborhood, never a full NumPy frame."""
    import numpy as np

    source, _, _ = _open_region_source(path, 1.0)
    try:
        h, w = int(source.height), int(source.width)
        left, top, right, bottom = [selection[k] for k in ("left", "top", "right", "bottom")]
        sel_w = max(1, right - left)
        sel_h = max(1, bottom - top)
        pad_x = int(round(sel_w * 0.75))
        pad_y = int(round(sel_h * 0.75))
        x1 = max(0, left - pad_x)
        y1 = max(0, top - pad_y)
        x2 = min(w, right + pad_x)
        y2 = min(h, bottom + pad_y)
        if x2 <= x1 or y2 <= y1:
            return None
        piece = source.crop((x1, y1, x2, y2))
        try:
            if piece.mode != "RGB":
                converted = piece.convert("RGB")
            else:
                converted = piece
            try:
                rgb = np.array(converted, dtype=np.uint8, copy=True)
            finally:
                if converted is not piece:
                    converted.close()

            geometries = ENGINE.detect_geometry(rgb)
            if not geometries:
                return None
            mapped: List[FaceRecord] = []
            for geometry in geometries:
                crop_rgb, local_kps = _recognition_crop_from_pil(
                    piece, geometry.bbox, geometry.kps, int(piece.width), int(piece.height)
                )
                embedding = ENGINE.recognize(crop_rgb, local_kps)
                if not embedding:
                    continue
                bx1, by1, bx2, by2 = geometry.bbox
                mapped.append(
                    FaceRecord(
                        bbox=(bx1 + x1, by1 + y1, bx2 + x1, by2 + y1),
                        kps=[
                            [float(point[0] + x1), float(point[1] + y1)]
                            for point in geometry.kps[:5]
                        ],
                        embedding=embedding,
                    )
                )
        finally:
            piece.close()
    finally:
        try:
            source.close()
        except Exception:
            pass

    temp_image = ImageRecord(
        path=str(path),
        name=path.name,
        width=int(w),
        height=int(h),
        source_width=int(w),
        source_height=int(h),
        faces=mapped,
    )
    return _find_reference_in_image(temp_image, selection)


def _cosine(a: List[float], b: List[float]) -> float:
    if not a or not b or len(a) != len(b):
        return -1.0
    return float(sum(x * y for x, y in zip(a, b)))



def _face_scale_dimensions(face: FaceRecord, sx: float = 1.0, sy: float = 1.0) -> Optional[Tuple[float, float]]:
    """Return two stable face-only dimensions for uniform scale matching.

    Two independent facial dimensions are used: eye-to-eye width and
    eye-line-to-mouth-line height. Only ratios of the same person's measurements
    are used, so no body geometry or framing contributes to the scale.
    """
    if not face or len(face.kps) < 5:
        return None
    try:
        eye0 = (float(face.kps[0][0]) * sx, float(face.kps[0][1]) * sy)
        eye1 = (float(face.kps[1][0]) * sx, float(face.kps[1][1]) * sy)
        mouth0 = (float(face.kps[3][0]) * sx, float(face.kps[3][1]) * sy)
        mouth1 = (float(face.kps[4][0]) * sx, float(face.kps[4][1]) * sy)
        eye_width = math.hypot(eye1[0] - eye0[0], eye1[1] - eye0[1])
        eye_mid = ((eye0[0] + eye1[0]) * 0.5, (eye0[1] + eye1[1]) * 0.5)
        mouth_mid = ((mouth0[0] + mouth1[0]) * 0.5, (mouth0[1] + mouth1[1]) * 0.5)
        face_height = math.hypot(mouth_mid[0] - eye_mid[0], mouth_mid[1] - eye_mid[1])
        if eye_width < 2.0 or face_height < 2.0:
            return None
        return eye_width, face_height
    except Exception:
        return None


def _aligned_crop(
    candidate: FaceRecord,
    candidate_image: ImageRecord,
    reference: FaceRecord,
    reference_image: ImageRecord,
    selection: Dict[str, int],
    target_doc_width: int,
    target_doc_height: int,
) -> Optional[Tuple[int, int, int, int]]:
    """Compute the translation-only eye-aligned crop in source pixels.

    Face-scale matching is intentionally not part of candidate discovery. Its
    current setting is read only when a preview is inserted, so changing the
    option applies immediately to an already-open preview set.
    """
    target_width = selection["right"] - selection["left"]
    target_height = selection["bottom"] - selection["top"]
    if target_width <= 0 or target_height <= 0:
        return None

    ref_sx = float(target_doc_width) / float(max(1, reference_image.width))
    ref_sy = float(target_doc_height) / float(max(1, reference_image.height))
    reference_eyes_doc = [
        [reference.kps[0][0] * ref_sx, reference.kps[0][1] * ref_sy],
        [reference.kps[1][0] * ref_sx, reference.kps[1][1] * ref_sy],
    ]
    target_offsets = [
        [reference_eyes_doc[0][0] - selection["left"], reference_eyes_doc[0][1] - selection["top"]],
        [reference_eyes_doc[1][0] - selection["left"], reference_eyes_doc[1][1] - selection["top"]],
    ]

    cand_sx = float(candidate_image.source_width) / float(max(1, candidate_image.width))
    cand_sy = float(candidate_image.source_height) / float(max(1, candidate_image.height))
    candidate_eyes_source = [
        [candidate.kps[0][0] * cand_sx, candidate.kps[0][1] * cand_sy],
        [candidate.kps[1][0] * cand_sx, candidate.kps[1][1] * cand_sy],
    ]

    crop_width = int(target_width)
    crop_height = int(target_height)

    left = int(round(((candidate_eyes_source[0][0] - target_offsets[0][0]) +
                      (candidate_eyes_source[1][0] - target_offsets[1][0])) * 0.5))
    top = int(round(((candidate_eyes_source[0][1] - target_offsets[0][1]) +
                     (candidate_eyes_source[1][1] - target_offsets[1][1])) * 0.5))
    right = left + crop_width
    bottom = top + crop_height

    if _is_raw_path(Path(candidate_image.path)):
        # Camera Raw may open the donor at dimensions different from rawpy's
        # native-size metadata. The JSX recalculates this rectangle from
        # normalized eyes after the real document has opened, so do not reject
        # a RAW candidate based on provisional native bounds here.
        return left, top, right, bottom

    if left < 0 or top < 0 or right > candidate_image.source_width or bottom > candidate_image.source_height:
        return None
    return left, top, right, bottom


def _choose_reference(index: GroupIndex, source_path: Path, selection: Dict[str, int], doc_width: int, doc_height: int) -> Tuple[ImageRecord, FaceRecord]:
    source_norm = _norm_path(str(source_path))
    record = next((item for item in index.images if _norm_path(item.path) == source_norm), None)
    if record is None:
        raise UserVisibleError("The active Photoshop file is not among the supported images in its folder.")
    local_selection = dict(selection)
    if record.width != doc_width or record.height != doc_height:
        if _is_raw_path(source_path):
            sx = float(record.width) / float(max(1, doc_width))
            sy = float(record.height) / float(max(1, doc_height))
            local_selection = _scale_selection(selection, sx, sy)
            LOGGER.info("[RAW] Source selection scaled from Photoshop %dx%d to embedded preview %dx%d for %s", doc_width, doc_height, record.width, record.height, source_path.name)
        else:
            raise UserVisibleError(
                "The Photoshop document dimensions (%dx%d) do not match the source file (%dx%d). "
                "Pixel-accurate face transfer is disabled to avoid scaling." % (doc_width, doc_height, record.width, record.height)
            )
    face = _find_reference_in_image(record, local_selection)
    if face is None:
        LOGGER.info("[MATCH] No indexed face overlaps the selection; trying targeted detection.")
        face = _detect_reference_targeted(source_path, local_selection)
    if face is None:
        raise UserVisibleError("No face was found inside the Photoshop selection.")
    return record, face


def _render_previews(candidates: List[QueryCandidate], job_id: Optional[str] = None) -> Dict[str, Any]:
    from PIL import Image, ImageOps

    count = len(candidates)
    if count <= 0:
        raise UserVisibleError("No matching child was found in other images in this group.")

    thumb = _preview_size()
    if count <= 12:
        columns = min(6, count)
    elif count <= 24:
        columns = min(7, count)
    elif count <= 40:
        columns = min(8, count)
    elif count <= 60:
        columns = min(10, count)
        thumb = max(72, min(thumb, 120))
    else:
        columns = min(12, count)
        thumb = max(64, min(thumb, 104))

    workers = max(1, min(_preview_threads(), count))
    LOGGER.info("[PREVIEW] Preparing %d cached previews with %d worker(s), size=%d px", count, workers, thumb)

    def prepare_one(index: int, candidate: QueryCandidate) -> Tuple[int, Dict[str, Any]]:
        path = _preview_variant_path(candidate.face, thumb)
        if not path.is_file():
            master = Path(candidate.face.preview_master_path)
            with Image.open(master) as source:
                preview = ImageOps.fit(source.convert("RGB"), (thumb, thumb), method=Image.Resampling.LANCZOS)
                temp = path.with_suffix(path.suffix + ".tmp")
                # UI variants are small cached files. Low compression is much
                # faster and has no visual penalty; disk-size difference is tiny.
                preview.save(temp, format="PNG", compress_level=1)
                os.replace(str(temp), str(path))
        return index, {
            "path": str(path),
            "name": candidate.name,
            "width": int(thumb),
            "height": int(thumb),
        }

    previews: List[Optional[Dict[str, Any]]] = [None] * count
    completed = 0
    if workers == 1:
        for index, candidate in enumerate(candidates):
            result_index, item = prepare_one(index, candidate)
            previews[result_index] = item
            completed += 1
            if job_id:
                _update_job(job_id, progress=0.90 + (completed / float(max(1, count))) * 0.09,
                            status="running", text="Подготовка превью %d/%d" % (completed, count))
    else:
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="Preview") as pool:
            future_map = {pool.submit(prepare_one, index, candidate): index for index, candidate in enumerate(candidates)}
            for future in as_completed(future_map):
                result_index, item = future.result()
                previews[result_index] = item
                completed += 1
                if job_id:
                    _update_job(job_id, progress=0.90 + (completed / float(max(1, count))) * 0.09,
                                status="running", text="Подготовка превью %d/%d" % (completed, count))

    result_items = [item for item in previews if item is not None]
    if len(result_items) != count:
        raise UserVisibleError("Preview generation returned an incomplete result.")
    return {
        "items": result_items,
        "thumb_width": int(thumb),
        "thumb_height": int(thumb),
        "columns": int(columns),
        "count": int(count),
    }


def _select_child(payload: Dict[str, Any], job_id: Optional[str] = None) -> Dict[str, Any]:
    source_path = Path(str(payload.get("source_path") or "")).resolve()
    if not source_path.is_file():
        raise UserVisibleError("The active Photoshop document has no readable source file on disk.")
    folder = source_path.parent
    selection_raw = payload.get("selection") or {}
    selection = {
        key: int(round(float(selection_raw.get(key, 0))))
        for key in ("left", "top", "right", "bottom")
    }
    if selection["right"] <= selection["left"] or selection["bottom"] <= selection["top"]:
        raise UserVisibleError("The Photoshop selection is empty.")
    doc_width = int(round(float(payload.get("doc_width") or 0)))
    doc_height = int(round(float(payload.get("doc_height") or 0)))
    if doc_width <= 0 or doc_height <= 0:
        raise UserVisibleError("Could not read Photoshop document dimensions.")

    index = _build_group_index(folder, source_path, selection, doc_width, doc_height, job_id=job_id)
    if _is_raw_path(source_path):
        cloned_xmp = _clone_source_xmp_to_group(source_path, index.members, str(payload.get("source_xmp") or ""))
        if cloned_xmp and job_id:
            _update_job(job_id, progress=0.74, status="running", text="Подготовлены XMP для RAW этой группы: %d" % cloned_xmp)
    if job_id:
        _update_job(job_id, progress=0.78, status="running", text="Поиск выбранного лица...")
    reference_image, reference = _choose_reference(index, source_path, selection, doc_width, doc_height)
    ref_emb = reference.embedding
    source_norm = _norm_path(str(source_path))
    candidates: List[QueryCandidate] = []
    below_threshold = 0
    outside_frame = 0

    # Include the active source in the preview list as a visual reference. It is
    # marked non-insertable in JSX, so the target document is never used as its
    # own donor.
    active_crop = _aligned_crop(reference, reference_image, reference, reference_image, selection, doc_width, doc_height)
    if active_crop is None:
        active_crop = (selection["left"], selection["top"], selection["right"], selection["bottom"])
    candidates.append(
        QueryCandidate(
            source_path=reference_image.path,
            name=reference_image.name,
            width=reference_image.source_width,
            height=reference_image.source_height,
            analysis_width=reference_image.width,
            analysis_height=reference_image.height,
            face=reference,
            similarity=1.0,
            crop=active_crop,
            is_active=True,
        )
    )

    match_images = [image for image in index.images if _norm_path(image.path) != source_norm]
    match_total = max(1, len(match_images))
    for match_pos, image in enumerate(match_images, start=1):
        if job_id:
            _update_job(
                job_id,
                progress=0.80 + ((match_pos - 1) / float(match_total)) * 0.08,
                status="running",
                text="Поиск совпадений %d/%d: %s" % (match_pos, match_total, image.name),
            )
        best_face = None
        best_similarity = -1.0
        for face in image.faces:
            similarity = _cosine(ref_emb, face.embedding)
            if similarity > best_similarity:
                best_similarity = similarity
                best_face = face
        if best_face is None or best_similarity < _match_threshold():
            below_threshold += 1
            continue
        # Candidate discovery is always translation-only. Optional face-scale
        # matching is evaluated later, at insertion time, from the live setting.
        crop = _aligned_crop(
            best_face, image, reference, reference_image, selection, doc_width, doc_height
        )
        if crop is None:
            outside_frame += 1
            LOGGER.info(
                "[MATCH] %s matched %.3f but the aligned crop would leave the frame; skipped.",
                image.name, best_similarity,
            )
            continue
        candidates.append(
            QueryCandidate(
                source_path=image.path,
                name=image.name,
                width=image.source_width,
                height=image.source_height,
                analysis_width=image.width,
                analysis_height=image.height,
                face=best_face,
                similarity=best_similarity,
                crop=crop,
            )
        )
        LOGGER.info(
            "[MATCH] %-40s similarity=%.3f crop=%s",
            image.name, best_similarity, crop,
        )

    candidates.sort(key=lambda item: (0 if item.is_active else 1, item.name.casefold()))
    if len(candidates) <= 1:
        raise UserVisibleError(
            "The selected child was not found in other images of the detected group with sufficient confidence. "
            "Try a tighter face selection or lower the face-match threshold in Photoshop settings."
        )

    ref_sx = float(doc_width) / float(max(1, reference_image.width))
    ref_sy = float(doc_height) / float(max(1, reference_image.height))
    reference_eyes_doc = [
        [reference.kps[0][0] * ref_sx, reference.kps[0][1] * ref_sy],
        [reference.kps[1][0] * ref_sx, reference.kps[1][1] * ref_sy],
    ]
    target_eye_offsets = [
        [reference_eyes_doc[0][0] - selection["left"], reference_eyes_doc[0][1] - selection["top"]],
        [reference_eyes_doc[1][0] - selection["left"], reference_eyes_doc[1][1] - selection["top"]],
    ]
    target_face_dims = _face_scale_dimensions(reference, ref_sx, ref_sy) or (0.0, 0.0)
    query_id = uuid.uuid4().hex
    context = QueryContext(
        created_at=time.time(),
        target_eye_offsets=target_eye_offsets,
        target_face_width=float(target_face_dims[0]),
        target_face_height=float(target_face_dims[1]),
        candidates=candidates,
    )
    with QUERY_LOCK:
        QUERIES[query_id] = context
    if job_id:
        _update_job(job_id, progress=0.90, status="running", text="Подготовка превью 0/%d..." % len(candidates))
    previews = _render_previews(candidates, job_id=job_id)
    return {
        "query_id": query_id,
        "previews": previews,
        "matches": [
            {
                "name": item.name,
                "source_path": item.source_path,
                "similarity": float(item.similarity),
                "is_active": bool(item.is_active),
            }
            for item in candidates
        ],
        "skipped_low_similarity": below_threshold,
        "skipped_outside_frame": outside_frame,
        "threshold": _match_threshold(),
        "provider": ENGINE.provider_name(),
    }


def _prepare_crop(payload: Dict[str, Any]) -> Dict[str, Any]:
    query_id = str(payload.get("query_id") or "")
    index = int(payload.get("index", -1))
    with QUERY_LOCK:
        context = QUERIES.get(query_id)
    if context is None:
        raise UserVisibleError("This preview set has expired. Select the face again and run the JSX script.")
    if index < 0 or index >= len(context.candidates):
        raise UserVisibleError("Invalid preview index.")
    candidate = context.candidates[index]
    if candidate.is_active:
        raise UserVisibleError("The active Photoshop file is shown only as a reference preview and cannot be inserted into itself.")
    live_scale_match = (
        _face_scale_match()
        and context.target_face_width > 1.0
        and context.target_face_height > 1.0
        and len(candidate.face.kps) >= 5
    )
    LOGGER.info(
        "[INSERT] Selected %s, similarity %.3f, crop=%s, face-scale-match=%s",
        candidate.name, candidate.similarity, candidate.crop, live_scale_match,
    )
    return {
        "source_path": candidate.source_path,
        "source_width": candidate.width,
        "source_height": candidate.height,
        "analysis_width": candidate.analysis_width,
        "analysis_height": candidate.analysis_height,
        "is_raw": _is_raw_path(Path(candidate.source_path)),
        "candidate_kps_normalized": [
            [point[0] / float(max(1, candidate.analysis_width)), point[1] / float(max(1, candidate.analysis_height))]
            for point in candidate.face.kps[:5]
        ],
        "target_eye_offsets": context.target_eye_offsets,
        "face_scale_match": bool(live_scale_match),
        "target_face_width": float(context.target_face_width),
        "target_face_height": float(context.target_face_height),
        "crop": {
            "left": candidate.crop[0],
            "top": candidate.crop[1],
            "right": candidate.crop[2],
            "bottom": candidate.crop[3],
        },
        "name": candidate.name,
    }


def _start_select_job(payload: Dict[str, Any]) -> Dict[str, Any]:
    source = Path(str(payload.get("source_path") or ""))
    if not source.is_file():
        raise UserVisibleError("The active Photoshop document has no readable source file on disk.")

    # Selection is always processed as a background job. Even when the folder
    # index is already current, matching the selected child and preparing cached face thumbnails can still
    # take noticeable time on very large groups. Returning a
    # job immediately lets Photoshop keep a visible native progress bar instead
    # of looking frozen while it waits on the socket.
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "created_at": time.time(),
            "updated_at": time.time(),
            "status": "running",
            "progress": 0.01,
            "text": "Проверка кэша группы...",
            "result": None,
            "error": "",
        }

    def worker() -> None:
        try:
            result = _select_child(payload, job_id=job_id)
            _update_job(job_id, status="done", progress=1.0, text="Превью готовы", result=result)
        except Exception as exc:
            LOGGER.exception("Selection job failed")
            _update_job(job_id, status="error", progress=1.0, text="Ошибка", error=str(exc))

    threading.Thread(target=worker, name="selection-" + job_id[:6], daemon=True).start()
    return _json_response("job", {"job_id": job_id})


def _job_status(payload: Dict[str, Any]) -> Dict[str, Any]:
    job_id = str(payload.get("job_id") or "")
    with JOBS_LOCK:
        job = dict(JOBS.get(job_id) or {})
        if job and job.get("status") in ("done", "error"):
            JOBS.pop(job_id, None)
    if not job:
        raise UserVisibleError("Analysis job not found.")
    return _json_response("answer", {
        "status": job.get("status"),
        "progress": float(job.get("progress") or 0.0),
        "text": str(job.get("text") or ""),
        "result": job.get("result"),
        "error": str(job.get("error") or ""),
    })


def _cleanup_old_state() -> None:
    _cleanup_disk_cache()
    now = time.time()
    with JOBS_LOCK:
        for key in list(JOBS):
            if now - float(JOBS[key].get("updated_at") or 0) > JOB_TTL_SECONDS:
                JOBS.pop(key, None)
    with QUERY_LOCK:
        for key in list(QUERIES):
            if now - QUERIES[key].created_at > QUERY_TTL_SECONDS:
                QUERIES.pop(key, None)


def _apply_settings(payload: Dict[str, Any], job_id: Optional[str] = None) -> Dict[str, Any]:
    new_settings = _config_with_defaults(dict(payload.get("settings") or {}))
    current = _get_runtime_config()
    LOGGER.info("[SETTINGS] Requested: compute_mode=%s analysis_quality=%s det_size=%d",                new_settings.get("compute_mode"), new_settings.get("analysis_quality"),                int(ANALYSIS_DET_SIZES.get(new_settings.get("analysis_quality"), ANALYSIS_DET_SIZES[DEFAULT_ANALYSIS_QUALITY])))
    restart_fields: List[str] = []
    if new_settings.get("server_host") != current.get("server_host"):
        restart_fields.append("server_host")
    if int(new_settings.get("server_port")) != int(current.get("server_port")):
        restart_fields.append("server_port")
    requested_det_size = int(ANALYSIS_DET_SIZES.get(
        new_settings.get("analysis_quality"),
        ANALYSIS_DET_SIZES[DEFAULT_ANALYSIS_QUALITY],
    ))
    engine_state_before = ENGINE.current_state()
    # Reconfigure not only when the config value changes, but also when the live
    # engine has drifted from the persisted configuration.
    engine_changed = (
        new_settings.get("compute_mode") != current.get("compute_mode")
        or new_settings.get("analysis_quality") != current.get("analysis_quality")
        or str(engine_state_before.get("mode") or "") != str(new_settings.get("compute_mode") or "")
        or int(engine_state_before.get("det_size") or 0) != requested_det_size
    )
    if job_id:
        _update_job(job_id, progress=0.10, status="running", text="Проверка настроек...")

    # Engine-dependent options are applied first. If the requested GPU/provider
    # cannot be initialized, the server keeps the previous valid configuration
    # instead of persisting settings that cannot actually be used.
    if engine_changed:
        if job_id:
            _update_job(job_id, progress=0.20, status="running", text="Применение режима распознавания...")
        try:
            state_after = ENGINE.reconfigure(str(new_settings.get("compute_mode")), requested_det_size)
        except Exception:
            LOGGER.exception("[SETTINGS] Engine reconfiguration rejected; previous settings stay active.")
            raise
        if int(state_after.get("det_size") or 0) != requested_det_size:
            raise UserVisibleError(
                "Face engine did not accept detector size %d (active: %s)."
                % (requested_det_size, state_after.get("det_size"))
            )
        if job_id:
            _update_job(job_id, progress=0.82, status="running", text="Модель распознавания готова.")

    saved = _save_runtime_config(new_settings)
    # Final consistency check: persisted quality and live engine must describe
    # the same detector size before the server reports success to Photoshop.
    final_state = ENGINE.current_state()
    saved_det_size = int(ANALYSIS_DET_SIZES.get(saved.get("analysis_quality"), ANALYSIS_DET_SIZES[DEFAULT_ANALYSIS_QUALITY]))
    if int(final_state.get("det_size") or 0) != saved_det_size:
        raise UserVisibleError(
            "Settings were saved, but the live detector is %s instead of %d."
            % (final_state.get("det_size"), saved_det_size)
        )
    if saved.get("cache_ttl_hours") != current.get("cache_ttl_hours"):
        _cleanup_disk_cache(force=True)
    try:
        settings_revision = int(CONFIG_FILE.stat().st_mtime_ns)
    except OSError:
        settings_revision = int(time.time() * 1000000000)
    result = {
        "settings": saved,
        "settings_revision": settings_revision,
        "restart_required": bool(restart_fields),
        "restart_fields": restart_fields,
        "engine": final_state,
        "applied_now": ["preview_size", "cache_ttl_hours", "match_threshold", "scan_threads", "preview_threads", "compute_mode", "analysis_quality", "group_boundary_search", "face_scale_match"],
    }
    if job_id:
        _update_job(job_id, progress=0.95, status="running", text="Настройки сохранены.")
    return result


def _start_settings_job(payload: Dict[str, Any]) -> Dict[str, Any]:
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "created_at": time.time(),
            "updated_at": time.time(),
            "status": "running",
            "progress": 0.02,
            "text": "Применение настроек...",
            "result": None,
            "error": "",
        }

    def worker() -> None:
        try:
            result = _apply_settings(payload, job_id=job_id)
            _update_job(job_id, status="done", progress=1.0, text="Настройки применены", result=result)
        except Exception as exc:
            LOGGER.exception("Settings job failed")
            _update_job(job_id, status="error", progress=1.0, text="Ошибка настроек", error=str(exc))

    threading.Thread(target=worker, name="settings-" + job_id[:6], daemon=True).start()
    return _json_response("job", {"job_id": job_id})


def _handle_command(payload: Dict[str, Any]) -> Dict[str, Any]:
    _cleanup_old_state()
    command = str(payload.get("command") or "")
    if command == "ping":
        return _json_response("answer", {
            "version": VERSION,
            "settings_schema": SETTINGS_SCHEMA_VERSION,
            "instance_id": SERVER_INSTANCE_ID,
            "provider": ENGINE.provider_name(),
            "settings": _get_runtime_config(),
            "engine": ENGINE.current_state(),
            "server_root": str(ROOT),
            "run_server_path": str(ROOT / "run_server.bat"),
        })
    if command == "get_settings":
        try:
            settings_revision = int(CONFIG_FILE.stat().st_mtime_ns)
        except OSError:
            settings_revision = 0
        return _json_response("answer", {
            "version": VERSION,
            "settings_schema": SETTINGS_SCHEMA_VERSION,
            "instance_id": SERVER_INSTANCE_ID,
            "settings_revision": settings_revision,
            "settings": _get_runtime_config(),
            "engine": ENGINE.current_state(),
            "server_root": str(ROOT),
            "run_server_path": str(ROOT / "run_server.bat"),
        })
    if command == "set_settings":
        return _start_settings_job(payload)
    if command == "select":
        return _start_select_job(payload)
    if command == "job_status":
        return _job_status(payload)
    if command == "prepare_crop":
        return _json_response("answer", _prepare_crop(payload))
    if command == "release_query":
        query_id = str(payload.get("query_id") or "")
        with QUERY_LOCK:
            QUERIES.pop(query_id, None)
        return _json_response("answer", True)
    raise UserVisibleError("Unknown command: %s" % command)


def _send_callback(host: str, port: int, result: Dict[str, Any]) -> None:
    data = (json.dumps(result, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
    with socket.create_connection((str(host), int(port)), timeout=10.0) as client:
        client.sendall(data)


class JsonLineHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        payload: Dict[str, Any] = {}
        try:
            raw = self.rfile.readline(32 * 1024 * 1024)
            if not raw:
                return
            payload = json.loads(raw.decode("utf-8"))
            result = _handle_command(payload)
        except UserVisibleError as exc:
            result = _json_response("error", str(exc))
            LOGGER.warning("Request error: %s", exc)
        except Exception as exc:
            result = _json_response("error", str(exc))
            LOGGER.error("Unhandled request error:\n%s", traceback.format_exc())
        if isinstance(payload, dict) and bool(payload.get("no_reply")):
            return
        reply_port = int(payload.get("reply_port") or 0) if isinstance(payload, dict) else 0
        if reply_port:
            try:
                _send_callback(self.client_address[0], reply_port, result)
            except Exception:
                LOGGER.exception("Could not send response to JSX callback port %d", reply_port)
            return
        data = (json.dumps(result, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
        self.wfile.write(data)
        self.wfile.flush()


class ThreadedServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    parser = argparse.ArgumentParser(description=APP_NAME + " local face server")
    current_config = _get_runtime_config()
    parser.add_argument("--host", default=current_config.get("server_host", DEFAULT_SERVER_HOST))
    parser.add_argument("--port", type=int, default=int(current_config.get("server_port", DEFAULT_SERVER_PORT)))
    args = parser.parse_args()

    print("=" * 64)
    print("%s server v%s" % (APP_NAME, VERSION))
    print("The server is started manually and does not use system Python.")
    print("Log: %s" % LOG_FILE)
    print("=" * 64)
    try:
        _cleanup_disk_cache(force=True)
        LOGGER.info("Group-analysis cache TTL: %d hours since last use.", _get_runtime_config().get("cache_ttl_hours", DEFAULT_CACHE_TTL_HOURS))
        LOGGER.info("Loading InsightFace buffalo_l... mode=%s, quality=%s, det-size=%d, scan threads=%d", _compute_mode(), _analysis_quality(), _det_size(), _scan_threads())
        ENGINE.prepare()
        LOGGER.info("Supported source formats: %s", ", ".join(sorted(SUPPORTED_EXTENSIONS)))
        with ThreadedServer((args.host, args.port), JsonLineHandler) as server:
            LOGGER.info("Server ready: %s:%d", args.host, args.port)
            LOGGER.info("Keep this window open while using the Photoshop JSX script. Ctrl+C stops the server.")
            try:
                server.serve_forever(poll_interval=0.25)
            except KeyboardInterrupt:
                LOGGER.info("Server stopped by user.")
    except OSError as exc:
        LOGGER.error("Cannot start server on %s:%d: %s", args.host, args.port, exc)
        return 2
    except Exception as exc:
        LOGGER.error("Server startup failed: %s", exc)
        LOGGER.debug(traceback.format_exc())
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
