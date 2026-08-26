@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title Group Face Picker server
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

echo [Group Face Picker] Starting local face server...
if not exist "runtime\venv\Scripts\python.exe" goto :not_installed
if not exist "setup\repair_venv.ps1" goto :not_installed

set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if defined PROCESSOR_ARCHITEW6432 if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "POWERSHELL_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" set "POWERSHELL_EXE=powershell.exe"

"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\repair_venv.ps1"
if errorlevel 1 goto :broken

"runtime\venv\Scripts\python.exe" group_face_server.py
set "RC=%ERRORLEVEL%"
echo.
echo Server stopped with code %RC%.
pause
exit /b %RC%

:not_installed
echo.
echo Private Python environment is not installed.
echo Run install.bat once. System Python is not required or used.
pause
exit /b 1

:broken
echo.
echo The private environment could not be validated or repaired.
echo Run install.bat once.
pause
exit /b 1
