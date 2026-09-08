@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PIP_DISABLE_PIP_VERSION_CHECK=1"
set "TORCH_HOME=%CD%\models\torch"

if exist "config\ca-bundle.pem" (
  set "PIP_CERT=%CD%\config\ca-bundle.pem"
  set "REQUESTS_CA_BUNDLE=%CD%\config\ca-bundle.pem"
  set "SSL_CERT_FILE=%CD%\config\ca-bundle.pem"
)

if not exist "runtime\venv\Scripts\python.exe" goto :not_installed
if not exist "setup\repair_venv.ps1" goto :broken
if not exist "train_personal_model.py" goto :broken
if not exist "training_requirements.txt" goto :broken

set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if defined PROCESSOR_ARCHITEW6432 if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "POWERSHELL_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" set "POWERSHELL_EXE=powershell.exe"

"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\repair_venv.ps1"
if errorlevel 1 goto :not_installed

set "BASEPY=runtime\venv\Scripts\python.exe"
set "TRAINDIR=runtime\training_venv"
set "TRAINPY=%TRAINDIR%\Scripts\python.exe"
set "READY=%TRAINDIR%\.gfp_training_ready_064"

echo ============================================================
echo Group Face Picker - personal model training
echo ============================================================
echo.
echo [1/4] Checking training_data before installing training tools...
"%BASEPY%" train_personal_model.py --check-data %*
if errorlevel 1 goto :data_failed

if exist "%TRAINPY%" (
  "%TRAINPY%" -c "import sys; assert sys.version_info[:2] == (3, 11)" >nul 2>&1
  if errorlevel 1 (
    echo Existing training environment is invalid. Recreating it...
    rmdir /s /q "%TRAINDIR%" >nul 2>&1
  )
)

if not exist "%TRAINPY%" (
  echo.
  echo [2/4] Creating separate training environment...
  "%BASEPY%" -m venv "%TRAINDIR%"
  if errorlevel 1 goto :failed
) else (
  echo.
  echo [2/4] Training environment already exists.
)

if exist "%READY%" (
  "%TRAINPY%" -c "import torch, torchvision, onnx, onnxruntime, numpy, PIL" >nul 2>&1
  if errorlevel 1 del /q "%READY%" >nul 2>&1
)

if not exist "%READY%" (
  echo.
  echo [3/4] Installing training dependencies...
  echo This is a one-time step and downloads CPU PyTorch / torchvision.
  "%TRAINPY%" -m pip install --upgrade pip
  if errorlevel 1 goto :failed
  "%TRAINPY%" -m pip install -r training_requirements.txt
  if errorlevel 1 goto :failed
  "%TRAINPY%" -c "import torch, torchvision, onnx, onnxruntime, numpy, PIL; print('Training runtime OK:', torch.__version__, torchvision.__version__)"
  if errorlevel 1 goto :failed
  >"%READY%" echo ready
) else (
  echo.
  echo [3/4] Training dependencies already prepared.
)

echo.
echo [4/4] Training personal preference model...
"%TRAINPY%" train_personal_model.py %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :train_failed

echo.
echo ============================================================
echo Training completed successfully.
echo Result: personal_model\personal_preference.onnx
echo Report: personal_model\training_report.md
echo ============================================================
pause
exit /b 0

:data_failed
echo.
echo Dataset is not ready for training yet.
echo Continue collecting/merging statistics, then run this BAT again.
pause
exit /b 2

:not_installed
echo.
echo Group Face Picker private Python is not installed.
echo Run install.bat first.
pause
exit /b 1

:broken
echo.
echo Training files are incomplete. Re-extract the Group Face Picker archive.
pause
exit /b 1

:train_failed
echo.
echo ============================================================
echo Training failed with code %RC%.
echo Read the error above and the personal model training section in README.md.
echo ============================================================
pause
exit /b %RC%

:failed
echo.
echo ============================================================
echo Could not prepare the training environment.
echo Internet access is required on the first successful training run.
echo ============================================================
pause
exit /b 1
