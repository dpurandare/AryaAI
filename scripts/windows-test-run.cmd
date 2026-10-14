@echo off
rem Step 2 of docs/Window_test_deploy.md: install what is missing, then build and start Sachivji.
rem First it installs the prerequisites (Python x64, Node 24 x64, Ollama, and the embedding model made from
rem models\ModelFileNomicEmbed; every step checks what is there and skips it, so re-running is quick),
rem then runs npm, the build and the app.
rem Usage:  windows-test-run.cmd           install what is missing, build and start
rem         windows-test-run.cmd update    git pull the branch and reinstall the npm packages first
rem         windows-test-run.cmd fresh     delete node_modules, out and the Electron download cache and reinstall (no git pull)
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
  call :prereqs
  if errorlevel 1 goto :fail
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. The prerequisite step should have installed it - read its summary above.
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

if /i "%~1"=="fresh" (
  if exist node_modules rmdir /s /q node_modules
  if exist out rmdir /s /q out
  if exist "%LOCALAPPDATA%\electron\Cache" rmdir /s /q "%LOCALAPPDATA%\electron\Cache"
)

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
  if errorlevel 1 call :electron_fallback
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

rem npm's own download of Electron's binary can fail here ("fetch failed") even though curl reaches GitHub.
rem Download the zip with curl instead, unpack it where Electron's installer would, then finish npm's postinstall.
:electron_fallback
if not exist node_modules\electron\package.json (
  echo npm ci failed before Electron was installed - read the error above.
  exit /b 1
)
for /f "usebackq" %%v in (`node -p "require('./node_modules/electron/package.json').version"`) do set "EV=%%v"
set "EZIP=%TEMP%\electron-v%EV%-win32-x64.zip"
echo.
echo npm could not download Electron. Downloading v%EV% with curl instead ...
curl.exe -L --fail --retry 3 -o "%EZIP%" "https://github.com/electron/electron/releases/download/v%EV%/electron-v%EV%-win32-x64.zip"
if errorlevel 1 (
  echo The curl download failed too - the network blocks the download.
  exit /b 1
)
powershell -NoProfile -Command "Expand-Archive -LiteralPath '%EZIP%' -DestinationPath 'node_modules\electron\dist' -Force; [IO.File]::WriteAllText('node_modules\electron\path.txt','electron.exe')"
if errorlevel 1 (
  echo Could not unpack the Electron zip.
  exit /b 1
)
del "%EZIP%" >nul 2>&1
echo Electron v%EV% installed from the curl download. Finishing the install ...
call npm run postinstall
exit /b %errorlevel%

rem Python x64, Node 24 x64 (nvm-windows), Ollama with nomic-embed-text: install-prerequisites.ps1 checks each and installs what
rem is missing (Node asks for administrator rights). Then the embedding model is recreated from the repo's Modelfile.
:prereqs
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-prerequisites.ps1" -Ollama -Node -Yes
if errorlevel 1 (
  echo.
  echo install-prerequisites reported a problem - read the summary above, fix it, run this again.
  exit /b 1
)
rem The installers changed PATH: read it again.
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%p"
set "OLLAMA=ollama"
where ollama >nul 2>&1
if errorlevel 1 set "OLLAMA=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
echo.
echo Creating the embedding model from models\ModelFileNomicEmbed ...
"%OLLAMA%" create nomic-embed-text -f models\ModelFileNomicEmbed
if errorlevel 1 (
  echo ollama create failed. Is Ollama running? Start it from the Start menu and run this again.
  exit /b 1
)
exit /b 0
