@echo off
rem Steps 1 (rest) and 3 of docs/Window_test_deploy.md. Run from the cloned repo.
rem Installs Python (x64 build, also on an ARM64 PC), Ollama with the nomic-embed-text model and
rem Node 24 (asks for administrator rights), then recreates the embedding model with the
rem repo's Modelfile (models\ModelFileNomicEmbed, num_ctx 2048).
rem With the argument "quiet" it does not pause (windows-test-run.cmd calls it that way).
setlocal
cd /d "%~dp0.."

rem A fresh install changes PATH for new windows only: re-read it so this window sees Node, Python, Git, Ollama.
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%p"

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
echo Prerequisites are in place.
if /i not "%~1"=="quiet" (
  echo Next: scripts\windows-test-run.cmd
  pause
)
exit /b 0

:fail
if /i not "%~1"=="quiet" pause
exit /b 1
