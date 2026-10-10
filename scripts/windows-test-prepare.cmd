@echo off
rem Steps 1 (rest) and 3 of docs/Window_test_deploy.md. Run from the cloned repo.
rem Installs Python (x64 build, also on an ARM64 PC), Ollama with the nomic-embed-text model and
rem Node 24 (asks for administrator rights), then recreates the embedding model with the
rem repo's Modelfile (models\ModelFileNomicEmbed, num_ctx 2048).
setlocal
cd /d "%~dp0.."

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-prerequisites.ps1" -Ollama -Node -Yes
if errorlevel 1 (
  echo.
  echo install-prerequisites reported a problem - read the summary above, fix it, run this again.
  goto :fail
)

rem Ollama may have just been installed, so this window may not have it on PATH.
set "OLLAMA=ollama"
where ollama >nul 2>&1
if errorlevel 1 set "OLLAMA=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

echo.
echo Creating the embedding model from models\ModelFileNomicEmbed ...
"%OLLAMA%" create nomic-embed-text -f models\ModelFileNomicEmbed
if errorlevel 1 (
  echo ollama create failed. Is Ollama running? Start it from the Start menu and run this again.
  goto :fail
)
"%OLLAMA%" show nomic-embed-text --parameters

echo.
echo Done. Open a NEW terminal (so PATH picks up Node and Python), then run
echo   scripts\windows-test-run.cmd
pause
exit /b 0

:fail
pause
exit /b 1
