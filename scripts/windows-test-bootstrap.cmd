@echo off
rem Step 1 of docs/Window_test_deploy.md. Run this FIRST on the Windows test machine.
rem It installs Git and clones the design_change branch of the (public) repo. It does not need the
rem repo, so it can be downloaded on its own:
rem   curl.exe -L -O https://raw.githubusercontent.com/dpurandare/AryaAI/design_change/scripts/windows-test-bootstrap.cmd
rem Usage:  open a terminal in the folder where the clone should go, then run
rem         windows-test-bootstrap.cmd [target-folder]     (default: .\AryaAI in the current folder)
rem If the repo is ever made private again, the clone is refused and the script falls back to
rem installing the GitHub CLI and signing in.
setlocal
set "TARGET=%CD%\AryaAI"
if not "%~1"=="" set "TARGET=%~1"
set "REPO=https://github.com/dpurandare/AryaAI.git"
set "BRANCH=design_change"

where winget >nul 2>&1
if errorlevel 1 (
  echo winget was not found. Install "App Installer" from the Microsoft Store, then run this again.
  goto :fail
)

echo Step 1: checking Git
call :ensure git Git.Git
if errorlevel 1 goto :fail

rem A fresh install is not on this window's PATH yet.
set "PATH=%ProgramFiles%\Git\cmd;%PATH%"

git --version
if errorlevel 1 (
  echo Git is still not available after the install. Close this window, open a new one and run this again.
  goto :fail
)

if exist "%TARGET%\.git" (
  echo.
  echo %TARGET% is already a clone - updating it.
) else (
  echo.
  echo Cloning into %TARGET% ...
  git clone "%REPO%" "%TARGET%"
  if errorlevel 1 call :signin_and_clone
  if errorlevel 1 goto :fail
)

rem Whatever was cloned or found, end up on the latest design_change.
git -C "%TARGET%" fetch origin
if errorlevel 1 goto :fail
git -C "%TARGET%" checkout -B %BRANCH% origin/%BRANCH%
if errorlevel 1 (
  echo Could not switch to %BRANCH%. If files in %TARGET% were changed by hand, undo that or delete the folder and run this again.
  goto :fail
)
echo.
echo Branch now:
git -C "%TARGET%" branch --show-current
git -C "%TARGET%" log -1 --format="Latest commit: %%h %%s"

echo.
echo ==============================================================
echo  Cloned to %TARGET%
echo.
echo  Next steps:
echo   1. Open a NEW terminal.
echo   2. cd /d "%TARGET%"
echo   3. scripts\windows-test-run.cmd   ^(installs what is missing, builds and starts the app^)
echo  Details: docs\Window_test_deploy.md
echo ==============================================================
pause
exit /b 0

:ensure
where %1 >nul 2>&1
if not errorlevel 1 (
  echo %1 is already installed.
  exit /b 0
)
echo %1 is not installed - installing it with winget ...
winget install --id %2 -e --silent --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo winget could not install %1 ^(exit code %errorlevel%^).
  exit /b 1
)
exit /b 0

:signin_and_clone
echo.
echo The clone was refused. If the repository is private, sign in to GitHub and try again.
call :ensure gh GitHub.cli
if errorlevel 1 exit /b 1
set "PATH=%ProgramFiles%\GitHub CLI;%PATH%"
gh auth status >nul 2>&1
if errorlevel 1 (
  echo Choose "Login with a web browser" and enter the code it shows.
  gh auth login --hostname github.com --git-protocol https --web
  if errorlevel 1 exit /b 1
)
gh auth setup-git
git clone "%REPO%" "%TARGET%"
exit /b %errorlevel%

:fail
echo.
echo Stopped because of the error above.
pause
exit /b 1
