@echo off
rem Installs Sachivji prerequisites on Windows 11 (see ..\docs\prerequisites.md).
rem Usage:  install-prerequisites.cmd            (Python only)
rem         install-prerequisites.cmd -All       (everything optional too)
rem         install-prerequisites.cmd -Git -Ollama
rem Extra arguments are passed straight to install-prerequisites.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-prerequisites.ps1" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
