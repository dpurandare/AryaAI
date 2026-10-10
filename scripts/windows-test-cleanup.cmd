@echo off
rem Removes everything the build created so the next windows-test-run.cmd starts from scratch:
rem node_modules, the build output, the packaged-app output and the cached Electron download
rem (which may be the wrong architecture). It does NOT touch your settings, sessions or the
rem Sachivji Workspace folder.
rem Usage:  windows-test-cleanup.cmd           clean the build files
rem         windows-test-cleanup.cmd node      clean, then switch Node to the x64 build with nvm
rem                                            (run from an ADMINISTRATOR terminal)
setlocal
cd /d "%~dp0.."

echo Cleaning build files in %CD% ...
if exist node_modules rmdir /s /q node_modules
if exist out rmdir /s /q out
if exist release rmdir /s /q release
if exist "%LOCALAPPDATA%\electron\Cache" rmdir /s /q "%LOCALAPPDATA%\electron\Cache"
echo Removed node_modules, out, release and the Electron download cache.

if /i "%~1"=="node" goto :node

echo.
echo Next: scripts\windows-test-run.cmd
pause
exit /b 0

:node
echo.
net session >nul 2>&1
if errorlevel 1 (
  echo Switching Node needs an ADMINISTRATOR terminal. Right-click the terminal, run as administrator, then run this again.
  goto :fail
)
where nvm >nul 2>&1
if errorlevel 1 (
  echo nvm was not found. Run scripts\windows-test-prepare.cmd first.
  goto :fail
)
echo Node versions installed under nvm:
nvm list
echo.
echo Installing the x64 build of Node 24 and making it the active one ...
nvm install 24 64
nvm use 24 64
echo.
echo Open a NEW terminal and check:  node -p "process.arch"   ^(must print x64^)
echo Then run:  scripts\windows-test-run.cmd
pause
exit /b 0

:fail
pause
exit /b 1
