@echo off
setlocal
if exist "%~dp0apps\desktop\release\preview\win-unpacked\Orbit Remote.exe" (
  start "" "%~dp0apps\desktop\release\preview\win-unpacked\Orbit Remote.exe"
) else (
  powershell.exe -NoProfile -File "%~dp0scripts\start-dev.ps1" -SkipInstall
)
