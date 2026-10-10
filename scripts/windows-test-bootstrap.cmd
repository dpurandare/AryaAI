@echo off
rem Step 1 of docs/Window_test_deploy.md. Run this FIRST on the Windows test machine.
rem It installs Git and the GitHub CLI, signs in to GitHub (the repo is private) and clones
rem the design_change branch. It does not need the repo, so copy this one file to the machine.
rem Usage:  open a terminal in the folder where the clone should go, then run
rem         windows-test-bootstrap.cmd [target-folder]     (default: .\AryaAI in the current folder)
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

echo Step 1: checking Git and the GitHub CLI
call :ensure git Git.Git
if errorlevel 1 goto :fail
call :ensure gh GitHub.cli
if errorlevel 1 goto :fail

rem A fresh install is not on this window's PATH yet.
set "PATH=%ProgramFiles%\Git\cmd;%ProgramFiles%\GitHub CLI;%PATH%"

rem Prove both are usable now, and show the versions.
git --version
if errorlevel 1 (
  echo Git is still not available after the install. Close this window, open a new one and run this again.
  goto :fail
)
gh --version | findstr /b "gh version"
if errorlevel 1 (
  echo The GitHub CLI is still not available after the install. Close this window, open a new one and run this again.
  goto :fail
)

gh auth status >nul 2>&1
if errorlevel 1 (
  echo.
  echo Signing in to GitHub: choose "Login with a web browser" and enter the code it shows.
  gh auth login --hostname github.com --git-protocol https --web
  if errorlevel 1 goto :fail
)
gh auth setup-git

if exist "%TARGET%\.git" (
  echo.
  echo %TARGET% is already a clone - updating it.
) else (
  echo.
  echo Cloning into %TARGET% ...
  git clone "%REPO%" "%TARGET%"
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
echo   1. Open a NEW terminal ^(so the new tools are on PATH^).
echo   2. cd /d "%TARGET%"
echo   3. scripts\windows-test-prepare.cmd   ^(Python, Node, Ollama, embedding model^)
echo   4. Open another NEW terminal, cd to the same folder, then
echo      scripts\windows-test-run.cmd       ^(build and start the app^)
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

:fail
echo.
echo Stopped because of the error above.
pause
exit /b 1
