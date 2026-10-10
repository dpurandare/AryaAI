@echo off
rem Step 2 of docs/Window_test_deploy.md: install what is missing, then build and start Sachivji.
rem It runs windows-test-prepare.cmd first (Python x64, Node 24 x64, Ollama, the embedding model;
rem every step checks what is there and skips it, so re-running is quick), then npm, build, start.
rem Usage:  windows-test-run.cmd           install what is missing, build and start
rem         windows-test-run.cmd update    git pull the branch and reinstall the npm packages first
rem         windows-test-run.cmd fresh     reinstall the npm packages without a git pull
rem         windows-test-run.cmd quick     skip the prerequisite check (everything is known to be installed)
setlocal
cd /d "%~dp0.."

rem The pull may replace this very file, so pull first and start a fresh copy of the script.
if /i "%~1"=="update" (
  git pull --ff-only
  if errorlevel 1 goto :fail
  call "%~f0" fresh
  exit /b %errorlevel%
)

rem A fresh install changes PATH for new windows only: re-read it so this window sees Node, Python, Git, Ollama.
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%p"

if /i not "%~1"=="quick" (
  call "%~dp0windows-test-prepare.cmd" quiet
  if errorlevel 1 goto :fail
  rem The installers changed PATH: read it again.
  for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%p"
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. windows-test-prepare.cmd should have installed it - read its summary above.
  goto :fail
)
for /f %%v in ('node --version') do echo Node %%v
for /f %%a in ('node -p "process.arch"') do set "NODE_ARCH=%%a"
echo Node architecture: %NODE_ARCH%
if /i not "%NODE_ARCH%"=="x64" (
  echo.
  echo This Node is %NODE_ARCH%. The app needs the x64 build, even on an ARM64 PC: sqlite-vec and numpy have no
  echo Windows ARM64 build, so an ARM64 Electron fails with "Unsupported platform for sqlite-vec".
  echo The prerequisite step should have installed the x64 Node. Read its summary above; then run
  echo   scripts\windows-test-run.cmd fresh
  goto :fail
)
rem Make Electron and native modules download for x64 whatever the PC reports.
set "npm_config_arch=x64"
set "npm_config_target_arch=x64"

if /i "%~1"=="fresh" if exist node_modules rmdir /s /q node_modules

if not exist node_modules (
  echo Installing dependencies ...
  call npm ci
  if errorlevel 1 goto :fail
)

echo Building ...
call npm run build
if errorlevel 1 goto :fail

echo Starting Sachivji ...
call npm start
exit /b 0

:fail
echo.
echo Stopped because of the error above.
pause
exit /b 1
