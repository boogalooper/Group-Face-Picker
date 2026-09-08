@echo off
setlocal
cd /d "%~dp0"
set "PYTHON=%~dp0runtime\venv\Scripts\python.exe"
if not exist "%PYTHON%" (
  echo Group Face Picker Python environment was not found.
  echo Run install.bat first.
  pause
  exit /b 1
)
if "%~1"=="" (
  echo Usage:
  echo   merge_training_data.bat "D:\PC1\training_data" "E:\PC2\training_data"
  echo.
  echo You can also pass Group Face Picker project folders; their training_data subfolder will be used.
  pause
  exit /b 1
)
"%PYTHON%" "%~dp0merge_training_data.py" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo Merge failed with error code %RC%.
pause
exit /b %RC%
