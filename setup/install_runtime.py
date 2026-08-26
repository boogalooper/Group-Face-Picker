from __future__ import annotations

import os
import shutil
import subprocess
import sys


def pip_install(*args: str) -> int:
    """Install packages using the TLS mode selected in install.bat."""
    cmd = [sys.executable, "-m", "pip", "install"]
    if os.environ.get("GFP_PIP_INSECURE_PYPI") == "1":
        cmd += [
            "--index-url", "https://pypi.org/simple",
            "--trusted-host", "pypi.org",
            "--trusted-host", "files.pythonhosted.org",
        ]
    cmd.extend(args)
    return subprocess.call(cmd)


def has_nvidia() -> bool:
    return shutil.which("nvidia-smi") is not None


def install_ort() -> int:
    # CPU/GPU ORT distributions export the same Python module. Always keep one
    # clean runtime. For RTX 50xx/Blackwell we pin the complete CUDA 12.8
    # runtime family instead of letting ORT extras mix whichever CUDA 12.x
    # component versions are newest on the day of installation. cuDNN 9.24
    # officially supports Blackwell with CUDA >=12.8.
    subprocess.call([sys.executable, "-m", "pip", "uninstall", "-y", "onnxruntime", "onnxruntime-gpu"])
    if has_nvidia():
        print("NVIDIA GPU detected. Installing pinned CUDA 12.8 runtime for ONNX Runtime 1.26.0...")
        gpu_packages = (
            "onnxruntime-gpu==1.26.0",
            "nvidia-cuda-runtime-cu12==12.8.90",
            "nvidia-cuda-nvrtc-cu12==12.8.93",
            "nvidia-nvjitlink-cu12==12.8.93",
            "nvidia-cublas-cu12==12.8.5.5",
            "nvidia-cufft-cu12==11.3.3.83",
            "nvidia-curand-cu12==10.3.9.90",
            "nvidia-cudnn-cu12==9.24.0.43",
        )
        rc = pip_install(*gpu_packages)
        if rc == 0:
            return 0
        print("GPU runtime installation failed; falling back to CPU ONNX Runtime 1.26.0.")
    return pip_install("onnxruntime==1.26.0")


def main() -> int:
    rc = install_ort()
    if rc != 0:
        return rc

    # InsightFace itself is installed without dependencies so pip cannot replace
    # our deliberately selected ONNX Runtime distribution.
    print("Installing InsightFace Python library (without replacing ONNX Runtime)...")
    return pip_install("--no-deps", "insightface==1.0.1")


if __name__ == "__main__":
    raise SystemExit(main())
