@echo off
setlocal
set "ORBIT_PACKAGE_DIR=win-unpacked"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ORBIT_PACKAGE_DIR=win-arm64-unpacked"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ORBIT_PACKAGE_DIR=win-arm64-unpacked"
if exist "%~dp0apps\desktop\release\preview\%ORBIT_PACKAGE_DIR%\Orbit Remote.exe" (
  start "" "%~dp0apps\desktop\release\preview\%ORBIT_PACKAGE_DIR%\Orbit Remote.exe"
) else (
  powershell.exe -NoProfile -File "%~dp0scripts\start-dev.ps1" -SkipInstall
)
