from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUFFALO = ROOT / "models" / "insightface" / "models" / "buffalo_l"
PREFERENCE = ROOT / "models" / "portrait_preference"
BUFFALO_FILES = (
    "det_10g.onnx",
    "w600k_r50.onnx",
    "2d106det.onnx",
    "1k3d68.onnx",
    "genderage.onnx",
)


def main() -> int:
    try:
        import cv2
        import numpy as np
        import onnxruntime as ort
    except Exception as exc:
        print(f"Dependency import self-test failed: {exc}", file=sys.stderr)
        return 10

    try:
        for name in BUFFALO_FILES:
            path = BUFFALO / name
            if not path.is_file() or path.stat().st_size < 100_000:
                raise RuntimeError(f"missing/incomplete {name}")
            # Session construction validates the ONNX graph and file integrity.
            session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
            if not session.get_inputs() or not session.get_outputs():
                raise RuntimeError(f"invalid ONNX I/O metadata: {name}")
            del session
        print("InsightFace buffalo_l self-test: OK")
    except Exception as exc:
        print(f"InsightFace buffalo_l self-test failed: {exc}", file=sys.stderr)
        return 20

    try:
        model = PREFERENCE / "beauty_resnet.caffemodel"
        proto = PREFERENCE / "beauty_resnet.prototxt"
        if not model.is_file() or model.stat().st_size <= 40_000_000:
            raise RuntimeError("beauty_resnet.caffemodel is missing/incomplete")
        if not proto.is_file() or proto.stat().st_size <= 10_000:
            raise RuntimeError("beauty_resnet.prototxt is missing/incomplete")
        net = cv2.dnn.readNetFromCaffe(str(proto), str(model))
        sample = np.full((224, 224, 3), 128, dtype=np.uint8)
        blob = cv2.dnn.blobFromImage(
            sample,
            scalefactor=1.0 / 255.0,
            size=(224, 224),
            mean=(104.0, 117.0, 123.0),
            swapRB=False,
            crop=False,
        )
        net.setInput(blob)
        output = np.asarray(net.forward()).reshape(-1)
        if output.size < 1 or not np.isfinite(output[0]):
            raise RuntimeError("FBP returned invalid output")
        print(f"Public FBP self-test: OK (raw={float(output[0]):.4f})")
    except Exception as exc:
        print(f"Public FBP self-test failed: {exc}", file=sys.stderr)
        return 30

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
