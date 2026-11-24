@echo off
rem Launches StudyFlow without the confusing npm wrapper.
rem Prefers the packaged build; falls back to running from source.

cd /d "%~dp0"

if exist "release\win-unpacked\StudyFlow.exe" (
    start "" "release\win-unpacked\StudyFlow.exe"
    exit /b 0
)

where npm.cmd >nul 2>nul
if %errorlevel% equ 0 (
    start "" cmd /c "npm.cmd start"
    exit /b 0
)

echo Could not find StudyFlow.
echo Build it first with:  npm.cmd run dist
pause