@echo off
rem Step 4 of docs/Window_test_deploy.md: install dependencies if needed, build and start Sachivji.
rem Usage:  windows-test-run.cmd           build and start (installs dependencies the first time)
rem         windows-test-run.cmd update    git pull the branch and reinstall dependencies first
rem         windows-test-run.cmd fresh     reinstall dependencies without a git pull (use after a wrong-architecture install)
setlocal
cd /d "%~dp0.."

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found on PATH. Open a NEW terminal after windows-test-prepare.cmd, or run it first.
  goto :fail
)
for /f %%v in ('node --version') do echo Node %%v
for /f %%a in ('node -p "process.arch"') do set "NODE_ARCH=%%a"
echo Node architecture: %NODE_ARCH%
if /i not "%NODE_ARCH%"=="x64" (
  echo.
  echo This Node is %NODE_ARCH%. The app needs the x64 build, even on an ARM64 PC: sqlite-vec and numpy have no
  echo Windows ARM64 build, so an ARM64 Electron fails with "Unsupported platform for sqlite-vec".
  echo Fix: run  nvm install 24 64  then  nvm use 24 64  in an ADMIN terminal ^(or reinstall Node x64^), open a new
  echo terminal and run  scripts\windows-test-run.cmd fresh
  goto :fail
)
rem Make Electron and native modules download for x64 whatever the PC reports.
set "npm_config_arch=x64"
set "npm_config_target_arch=x64"

if /i "%~1"=="update" (
  git pull --ff-only
  if errorlevel 1 goto :fail
)
if /i "%~1"=="update" set "REINSTALL=1"
if /i "%~1"=="fresh" set "REINSTALL=1"
if defined REINSTALL if exist node_modules rmdir /s /q node_modules

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
