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

rem An install that stopped halfway leaves node_modules behind without Electron's binary (path.txt): do it again.
set "NEED_INSTALL="
if not exist node_modules set "NEED_INSTALL=1"
if not exist node_modules\electron\path.txt set "NEED_INSTALL=1"
if defined NEED_INSTALL (
  if exist node_modules rmdir /s /q node_modules
  echo Checking that GitHub is reachable ^(Electron's binary is downloaded from there^) ...
  curl.exe -sS -I -m 20 -o NUL https://github.com
  if errorlevel 1 (
    echo.
    echo Cannot reach github.com from this machine. Fix the network first ^(DNS, proxy, VPN or the VM's network mode^),
    echo see "If something fails" in docs\Window_test_deploy.md, then run this script again.
    goto :fail
  )
  echo Installing dependencies ...
  call npm ci
  if errorlevel 1 goto :fail
)
if not exist node_modules\electron\path.txt (
  echo Electron's binary was not downloaded. Check the network ^(see docs\Window_test_deploy.md^) and run this script again.
  goto :fail
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
