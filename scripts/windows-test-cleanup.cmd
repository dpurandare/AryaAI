@echo off
rem Removes everything the build created so the next windows-test-run.cmd starts from scratch:
rem node_modules, the build output, the packaged-app output and the cached Electron download
rem (which may be the wrong architecture). It does NOT touch your settings, sessions, the
rem Sachivji Workspace folder or any installed program.
setlocal
cd /d "%~dp0.."

echo Cleaning build files in %CD% ...
if exist node_modules rmdir /s /q node_modules
if exist out rmdir /s /q out
if exist release rmdir /s /q release
if exist "%LOCALAPPDATA%\electron\Cache" rmdir /s /q "%LOCALAPPDATA%\electron\Cache"
echo Removed node_modules, out, release and the Electron download cache.
echo.
echo Next: scripts\windows-test-run.cmd
pause
