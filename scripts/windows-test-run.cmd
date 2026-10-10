@echo off
rem Step 4 of docs/Window_test_deploy.md: install dependencies if needed, build and start Sachivji.
rem Usage:  windows-test-run.cmd           build and start (installs dependencies the first time)
rem         windows-test-run.cmd update    git pull the branch and reinstall dependencies first
setlocal
cd /d "%~dp0.."

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found on PATH. Open a NEW terminal after windows-test-prepare.cmd, or run it first.
  goto :fail
)
for /f %%v in ('node --version') do echo Node %%v
for /f %%a in ('node -p "process.arch"') do echo Node architecture: %%a

if /i "%~1"=="update" (
  git pull --ff-only
  if errorlevel 1 goto :fail
  if exist node_modules rmdir /s /q node_modules
)

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
