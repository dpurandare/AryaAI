@echo off
rem Removes everything the build created so the next windows-test-run.cmd starts from scratch:
rem node_modules, the build output, the packaged-app output and the cached Electron download
rem (which may be the wrong architecture). It does NOT touch your settings, sessions or the
rem Sachivji Workspace folder.
rem Usage:  windows-test-cleanup.cmd           clean the build files
rem         windows-test-cleanup.cmd node      clean, then install or switch to the x64 Node 24 (with nvm-windows)
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
echo Installing or switching to the x64 build of Node 24 ^(asks for administrator rights, opens a second window^) ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-prerequisites.ps1" -Node -Yes
echo.
echo Open a NEW terminal and check:  node -p "process.arch"   ^(must print x64^)
echo Then run:  scripts\windows-test-run.cmd
pause
exit /b 0
