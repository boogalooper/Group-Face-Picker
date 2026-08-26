@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PIP_DISABLE_PIP_VERSION_CHECK=1"
set "GFP_PIP_INSECURE_PYPI=0"

if exist "config\ca-bundle.pem" (
  set "PIP_CERT=%CD%\config\ca-bundle.pem"
  set "REQUESTS_CA_BUNDLE=%CD%\config\ca-bundle.pem"
  set "SSL_CERT_FILE=%CD%\config\ca-bundle.pem"
)

echo ============================================================
echo Group Face Picker - installation
echo Private CPython 3.11.16 x64 via uv
echo System Python is NOT used.
echo ============================================================
echo.
echo Python package connection mode:
echo   [1] Normal secure mode (recommended)
echo   [2] Kaspersky compatibility mode for official PyPI hosts
echo   [3] Cancel
choice /C 123 /N /M "Choose 1, 2 or 3: "
if errorlevel 3 goto :failed
if errorlevel 2 (
  set "GFP_PIP_INSECURE_PYPI=1"
  echo WARNING: PyPI certificate verification bypass is enabled only for this install.
)

set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if defined PROCESSOR_ARCHITEW6432 if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "POWERSHELL_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" set "POWERSHELL_EXE=powershell.exe"

if not exist "setup\install_managed_python.ps1" goto :failed
if not exist "setup\install_windows.ps1" goto :failed
if not exist "setup\install_runtime.py" goto :failed
if not exist "setup\repair_venv.ps1" goto :failed

echo.
echo [1/4] Preparing private Python...
"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\install_managed_python.ps1"
if errorlevel 1 goto :failed

set "PY=runtime\venv\Scripts\python.exe"
if not exist "%PY%" goto :failed

echo.
echo [2/4] Bootstrapping pip...
"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\install_windows.ps1" -Action bootstrap-pip -Python "%CD%\%PY%"
if errorlevel 1 goto :failed

:install_dependencies
echo.
echo [3/4] Installing Python dependencies...
if "%GFP_PIP_INSECURE_PYPI%"=="1" (
  "%PY%" -m pip install --index-url https://pypi.org/simple --trusted-host pypi.org --trusted-host files.pythonhosted.org -r requirements.txt
) else (
  "%PY%" -m pip install -r requirements.txt
)
if errorlevel 1 goto :pip_failed

"%PY%" setup\install_runtime.py
if errorlevel 1 goto :runtime_failed

goto :download_models

:pip_failed
if "%GFP_PIP_INSECURE_PYPI%"=="1" goto :failed
echo.
echo Package installation failed. If this is CERTIFICATE_VERIFY_FAILED because of HTTPS inspection:
echo   [1] Retry in Kaspersky compatibility mode
echo   [2] Cancel
choice /C 12 /N /M "Choose 1 or 2: "
if errorlevel 2 goto :failed
set "GFP_PIP_INSECURE_PYPI=1"
goto :install_dependencies

:runtime_failed
if "%GFP_PIP_INSECURE_PYPI%"=="1" goto :failed
echo.
echo ONNX Runtime installation failed.
echo   [1] Retry in Kaspersky compatibility mode
echo   [2] Cancel
choice /C 12 /N /M "Choose 1 or 2: "
if errorlevel 2 goto :failed
set "GFP_PIP_INSECURE_PYPI=1"
"%PY%" setup\install_runtime.py
if errorlevel 1 goto :failed

:download_models
echo.
echo [4/4] Downloading/verifying InsightFace buffalo_l...
"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\install_windows.ps1" -Action download-insightface
if errorlevel 1 goto :failed

"%PY%" -m py_compile group_face_server.py
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo Installation complete.
echo Start run_server.bat manually before using Group Face Picker.jsx.
echo Keep the server console open while working in Photoshop.
echo ============================================================
pause
exit /b 0

:failed
echo.
echo ============================================================
echo Installation failed or was cancelled.
echo Review the messages above.
echo ============================================================
pause
exit /b 1
