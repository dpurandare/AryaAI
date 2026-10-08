<#
.SYNOPSIS
  Installs and verifies the prerequisites for Sachivji on Windows 11 (see docs/prerequisites.md).

.DESCRIPTION
  Windows 11 only, on x64 (AMD64) or ARM64; anything else exits with an error.
  Uses winget (built into Windows 11). Every step first checks what is already there and only
  fixes what is missing or too old. Safe to re-run.

  Core (always):
    Python 3.10 to 3.13 (64-bit x64, with venv/ensurepip); installs 3.12 only if none is found. On an ARM64 PC the x64 build is
    installed on purpose: the app's pinned numpy has no Windows ARM64 wheel.
  Optional groups, chosen by switches:
    -Git          Git for Windows
    -GitHubCli    GitHub CLI (gh); reports whether you are signed in
    -Ollama       Ollama; makes sure the server is running and nomic-embed-text is pulled
    -CloudCli     AWS CLI, Azure CLI, Google Cloud CLI
    -Node         Node.js 24 via nvm-windows (made the default), plus uv. Needs administrator
                  rights; the script re-launches itself elevated when needed.
    -All          Everything above
  Other switches:
    -Yes          Answer yes to confirmation prompts (uninstalling an old standalone Node,
                  setting PY_PYTHON3). Without it the script asks, or skips when not interactive.

  Run it through install-prerequisites.cmd (handles the execution policy), or:
    powershell -ExecutionPolicy Bypass -File scripts\install-prerequisites.ps1 -All

  Sign-ins (gh auth login, aws configure, az login, gcloud auth login) and provider API keys
  are NOT handled here.
#>
[CmdletBinding()]
param(
  [switch]$Git,
  [switch]$GitHubCli,
  [switch]$Ollama,
  [switch]$CloudCli,
  [switch]$Node,
  [switch]$All,
  [switch]$Yes,
  [switch]$Elevated
)

$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

if ($All) { $Git = $GitHubCli = $Ollama = $CloudCli = $Node = $true }

$NODE_MAJOR = 24
$PYTHON_OK_MINORS = @(10, 11, 12, 13)   # app floor is 3.10 (MIN_PYTHON); pinned numpy 2.2.6 has no cp314 wheel, so 3.14 is out (checked on PyPI)
$PYTHON_INSTALL_ID = 'Python.Python.3.12'
$EMBED_MODEL = 'nomic-embed-text'
# Native OS architecture. The env vars lie inside an x64-emulated or 32-bit PowerShell on an ARM64 PC,
# RuntimeInformation does not (.NET Framework 4.7.1+, present on every Windows 11).
$OsArch = ''
try { $OsArch = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch { }
if (-not $OsArch) {
  if (($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') -or ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64')) { $OsArch = 'Arm64' }
  elseif (($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') -or ($env:PROCESSOR_ARCHITEW6432 -eq 'AMD64')) { $OsArch = 'X64' }
  else { $OsArch = $env:PROCESSOR_ARCHITECTURE }
}
$IsArmHost = ($OsArch -eq 'Arm64')

$results = New-Object System.Collections.Generic.List[object]

function Add-Result([string]$name, [string]$status, [string]$level = 'ok') {
  $results.Add([pscustomobject]@{ Name = $name; Status = $status; Level = $level })
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Update-SessionEnv {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
  foreach ($v in @('NVM_HOME', 'NVM_SYMLINK', 'PY_PYTHON3')) {
    $val = [Environment]::GetEnvironmentVariable($v, 'User')
    if (-not $val) { $val = [Environment]::GetEnvironmentVariable($v, 'Machine') }
    if ($val) { Set-Item -Path "Env:$v" -Value $val }
  }
}

function Test-Command([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Confirm-Action([string]$question) {
  if ($Yes) { return $true }
  if (-not [Environment]::UserInteractive) { return $false }
  try {
    $a = Read-Host "$question [y/N]"
    return ($a -match '^(y|yes)$')
  } catch { return $false }
}

function Test-Url([string]$url) {
  try {
    Invoke-WebRequest -Uri $url -Method Head -TimeoutSec 8 -UseBasicParsing | Out-Null
    return $true
  } catch {
    # Any HTTP answer (401, 403, 405...) still proves the host is reachable.
    return [bool]$_.Exception.Response
  }
}

# --- winget ------------------------------------------------------------------
# 0x8A15002B (update not applicable) and 0x8A150061 (already installed) both mean "nothing to do".
$WINGET_OK = @(0, -1978335189, -1978335135)

function Install-WingetPackage([string]$label, [string]$id, [string]$arch = '') {
  Write-Host "Installing $label ($id) ..." -ForegroundColor Cyan
  $wargs = @('install', '--id', $id, '-e', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements')
  if ($arch) { $wargs += @('--architecture', $arch) }
  & winget @wargs | Out-Host   # Out-Host keeps winget's text out of this function's return value
  $code = $LASTEXITCODE
  Update-SessionEnv
  return ($WINGET_OK -contains $code), $code
}

function Install-Simple([string]$label, [string]$id, [string]$probe) {
  if (Test-Command $probe) {
    $v = ''
    try { $v = (& $probe --version 2>$null | Select-Object -First 1) } catch { }
    Add-Result $label ("already installed $v".Trim())
    return
  }
  $ok, $code = Install-WingetPackage $label $id
  if (-not $ok) { Add-Result $label "FAILED (winget exit $code)" 'fail'; return }
  if (Test-Command $probe) { Add-Result $label 'installed' }
  else { Add-Result $label 'installed - open a NEW terminal to use it' 'warn' }
}

# --- Python ------------------------------------------------------------------
# Returns @{ Major; Minor; Patch; Machine; Exe } or $null. Also proves venv and ensurepip import.
function Get-PythonInfo([string]$cmd, [string[]]$cargs) {
  if (-not (Test-Command $cmd)) { return $null }
  try {
    $code = 'import sys, platform, venv, ensurepip; print(sys.version_info[0], sys.version_info[1], sys.version_info[2], platform.machine(), sys.executable)'
    $out = & $cmd @cargs -c $code 2>$null | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    $p = ([string]$out) -split ' ', 5
    if ($p.Count -lt 5) { return $null }
    return @{ Major = [int]$p[0]; Minor = [int]$p[1]; Patch = [int]$p[2]; Machine = $p[3]; Exe = $p[4] }
  } catch { return $null }
}

function Test-PythonAcceptable($info) {
  if (-not $info) { return $false }
  if ($info.Major -ne 3 -or ($PYTHON_OK_MINORS -notcontains $info.Minor)) { return $false }
  if ($IsArmHost -and $info.Machine -ne 'AMD64') { return $false }
  return $true
}

function Find-GoodPython {
  foreach ($c in @(@('py', '-3.13'), @('py', '-3.12'), @('py', '-3.11'), @('py', '-3.10'), @('python'), @('python3'))) {
    $cargs = @()
    if ($c.Count -gt 1) { $cargs = @($c[1]) }
    $info = Get-PythonInfo $c[0] $cargs
    if (Test-PythonAcceptable $info) { return $info }
  }
  return $null
}

function Ensure-Python {
  $good = Find-GoodPython
  if (-not $good) {
    # Say why, in the cases where something exists but is unsuitable.
    $any = Get-PythonInfo 'py' @('-3')
    if (-not $any) { $any = Get-PythonInfo 'python' @() }
    if ($any) {
      Write-Host ("Found Python {0}.{1}.{2} ({3}) but it is not usable: need 3.10 to 3.13{4}, with venv/ensurepip." -f $any.Major, $any.Minor, $any.Patch, $any.Machine, $(if ($IsArmHost) { ' in the x64 build' } else { '' })) -ForegroundColor Yellow
    }
    $arch = ''
    if ($IsArmHost) { $arch = 'x64' }
    $ok, $code = Install-WingetPackage 'Python 3.12' $PYTHON_INSTALL_ID $arch
    if (-not $ok) { Add-Result 'Python 3.10-3.13' "FAILED (winget exit $code)" 'fail'; return }
    $good = Find-GoodPython
    if (-not $good) {
      Add-Result 'Python 3.10-3.13' 'installed but not detected - open a NEW terminal and run: py -3.12 --version' 'warn'
      return
    }
    Add-Result 'Python 3.10-3.13' ("installed {0}.{1}.{2} ({3})" -f $good.Major, $good.Minor, $good.Patch, $good.Machine)
  } else {
    Add-Result 'Python 3.10-3.13' ("already installed {0}.{1}.{2} ({3})" -f $good.Major, $good.Minor, $good.Patch, $good.Machine)
  }

  # The app starts its probe with `py -3`, which means the HIGHEST installed Python 3.
  $first = Get-PythonInfo 'py' @('-3')
  if ($first -and -not (Test-PythonAcceptable $first)) {
    $want = "{0}.{1}" -f $good.Major, $good.Minor
    $msg = "`n  The app asks the py launcher for 'py -3', which currently gives Python {0}.{1} ({2}), not a supported one." -f $first.Major, $first.Minor, $first.Machine
    Write-Host $msg -ForegroundColor Yellow
    if (Confirm-Action "  Set the user variable PY_PYTHON3=$want so 'py -3' means Python $want?") {
      [Environment]::SetEnvironmentVariable('PY_PYTHON3', $want, 'User')
      $env:PY_PYTHON3 = $want
      Add-Result "py -3 default" "now Python $want (PY_PYTHON3; restart Sachivji and sign out/in if it still picks the old one)"
    } else {
      Add-Result "py -3 default" "resolves to $($first.Major).$($first.Minor) - the app may use it. Remove it or set PY_PYTHON3=$want" 'warn'
    }
  }
}

# --- Ollama ------------------------------------------------------------------
function Find-OllamaExe {
  $c = Get-Command ollama -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Get-OllamaBase {
  $h = $env:OLLAMA_HOST
  if (-not $h) { return 'http://127.0.0.1:11434' }
  if ($h -notmatch '^https?://') { $h = "http://$h" }
  $h = $h -replace '://0\.0\.0\.0', '://127.0.0.1'
  if ($h -notmatch ':\d+$') { $h = "${h}:11434" }
  return $h.TrimEnd('/')
}

function Get-OllamaModels([string]$base) {
  try {
    $r = Invoke-RestMethod -Uri "$base/api/tags" -TimeoutSec 4
    return @($r.models | ForEach-Object { $_.name })
  } catch { return $null }
}

function Ensure-Ollama {
  $exe = Find-OllamaExe
  if ($exe) {
    $v = ''
    try { $v = (& $exe --version 2>$null | Select-Object -First 1) } catch { }
    Add-Result 'Ollama' ("already installed $v".Trim())
  } else {
    $ok, $code = Install-WingetPackage 'Ollama' 'Ollama.Ollama'
    if (-not $ok) { Add-Result 'Ollama' "FAILED (winget exit $code)" 'fail'; return }
    $exe = Find-OllamaExe
    if (-not $exe) { Add-Result 'Ollama' 'installed - open a NEW terminal, start Ollama, then: ollama pull nomic-embed-text' 'warn'; return }
    Add-Result 'Ollama' 'installed'
  }

  $base = Get-OllamaBase
  $isLocal = ($base -match '://(127\.0\.0\.1|localhost|\[::1\])')
  if ($isLocal -and -not (Test-Url 'https://registry.ollama.ai/v2/')) {
    Add-Result "$EMBED_MODEL model" 'registry.ollama.ai is not reachable (offline or proxy) - pull it later: ollama pull nomic-embed-text' 'warn'
    return
  }

  $models = Get-OllamaModels $base
  if ($null -eq $models -and $isLocal) {
    Write-Host 'Ollama server is not running - starting it ...' -ForegroundColor Cyan
    $app = Join-Path (Split-Path $exe) 'ollama app.exe'
    if (Test-Path $app) { Start-Process -FilePath $app -WindowStyle Hidden }
    else { Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden }
    for ($i = 0; $i -lt 30 -and $null -eq $models; $i++) {
      Start-Sleep -Seconds 1
      $models = Get-OllamaModels $base
    }
  }
  if ($null -eq $models) {
    Add-Result "$EMBED_MODEL model" "Ollama server not reachable at $base - start Ollama, then: ollama pull $EMBED_MODEL" 'warn'
    return
  }
  Add-Result 'Ollama server' "running at $base"

  if ($models | Where-Object { $_ -match "^$([regex]::Escape($EMBED_MODEL))(:|$)" }) {
    Add-Result "$EMBED_MODEL model" 'already pulled'
  } else {
    Write-Host "Pulling embedding model $EMBED_MODEL (about 275 MB) ..." -ForegroundColor Cyan
    & $exe pull $EMBED_MODEL
    $after = Get-OllamaModels $base
    if ($after | Where-Object { $_ -match "^$([regex]::Escape($EMBED_MODEL))(:|$)" }) { Add-Result "$EMBED_MODEL model" 'pulled' }
    else { Add-Result "$EMBED_MODEL model" "FAILED - run manually: ollama pull $EMBED_MODEL" 'fail' }
  }

  $chat = @($models | Where-Object { $_ -notmatch 'embed' })
  if ($chat.Count -eq 0) {
    Add-Result 'Ollama chat models' 'none pulled - only needed if you chat with a local model (e.g. ollama pull qwen3:8b); see README for the num_ctx note' 'warn'
  } else {
    Add-Result 'Ollama chat models' ($chat -join ', ')
  }
}

# --- Node (via nvm-windows) --------------------------------------------------
function Get-NodeVersion {
  # Prefer the nvm symlink location when it exists, so a stale PATH order cannot hide it.
  $candidates = @()
  if ($env:NVM_SYMLINK -and (Test-Path (Join-Path $env:NVM_SYMLINK 'node.exe'))) { $candidates += (Join-Path $env:NVM_SYMLINK 'node.exe') }
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { $candidates += $c.Source }
  foreach ($exe in $candidates) {
    try {
      $v = & $exe --version 2>$null | Select-Object -First 1
      if ($v -match '^v(\d+)\.(\d+)\.(\d+)') { return @{ Major = [int]$Matches[1]; Version = $v; Exe = $exe } }
    } catch { }
  }
  return $null
}

function Resolve-Node24 {
  try {
    $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 15
    $hit = $idx | Where-Object { $_.version -like "v$NODE_MAJOR.*" } | Select-Object -First 1
    if ($hit) { return $hit.version.TrimStart('v') }
  } catch { }
  return "$NODE_MAJOR"
}

function Ensure-Node {
  $cur = Get-NodeVersion
  if ($cur -and $cur.Major -ge $NODE_MAJOR) {
    Add-Result "Node.js $NODE_MAJOR+" "already installed $($cur.Version)"
    return
  }
  if ($cur) { Write-Host "Found Node $($cur.Version) - older than the $NODE_MAJOR you want." -ForegroundColor Yellow }

  # Leave other version managers alone.
  $curPath = ''
  if ($cur) { $curPath = $cur.Exe }
  if ($curPath -match '\\\.volta\\|\\fnm|\\n\\bin|\\nodist\\') {
    Add-Result "Node.js $NODE_MAJOR+" "managed by another tool ($curPath) - upgrade it with that tool (e.g. fnm install $NODE_MAJOR / volta install node@$NODE_MAJOR)" 'warn'
    return
  }

  $managed = $false
  if ($cur -and $env:NVM_SYMLINK -and $curPath.StartsWith($env:NVM_SYMLINK, [StringComparison]::OrdinalIgnoreCase)) { $managed = $true }
  if ($cur -and $env:NVM_HOME -and $curPath.StartsWith($env:NVM_HOME, [StringComparison]::OrdinalIgnoreCase)) { $managed = $true }

  if (-not (Test-Command 'nvm')) {
    # A standalone Node (MSI/winget) owns the folder nvm-windows wants for its symlink: remove it first.
    if ($cur -and -not $managed) {
      Write-Host "Existing standalone Node at $curPath must be removed before nvm-windows can manage Node." -ForegroundColor Yellow
      Write-Host '  Global npm packages (npm -g) are not carried over; reinstall any you need afterwards.' -ForegroundColor Yellow
      if (-not (Confirm-Action '  Uninstall the existing Node.js now?')) {
        Add-Result "Node.js $NODE_MAJOR+" "skipped - old Node $($cur.Version) kept. Uninstall it (Apps & features), then re-run with -Node" 'warn'
        return
      }
      $removed = $false
      foreach ($id in @('OpenJS.NodeJS.LTS', 'OpenJS.NodeJS')) {
        & winget list --id $id -e 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
          & winget uninstall --id $id -e --silent
          if ($LASTEXITCODE -eq 0) { $removed = $true; break }
        }
      }
      Update-SessionEnv
      $left = Get-Command node -ErrorAction SilentlyContinue
      if (-not $removed -and $left) {
        Add-Result "Node.js $NODE_MAJOR+" "could not uninstall old Node automatically - remove it in Apps & features, then re-run with -Node" 'fail'
        return
      }
    }
    $ok, $code = Install-WingetPackage 'nvm-windows' 'CoreyButler.NVMforWindows'
    if (-not $ok) { Add-Result 'nvm-windows' "FAILED (winget exit $code)" 'fail'; return }
    if (-not (Test-Command 'nvm')) {
      Add-Result 'nvm-windows' 'installed - open a NEW terminal and re-run with -Node' 'warn'
      return
    }
    Add-Result 'nvm-windows' 'installed'
  } else {
    Add-Result 'nvm-windows' 'already installed'
  }

  $target = Resolve-Node24
  Write-Host "Installing Node $target with nvm ..." -ForegroundColor Cyan
  # ARM64 PCs: ask for the x64 build, like Python, so npx-launched MCP servers find prebuilt native modules.
  $nvmArch = @()
  if ($IsArmHost) { $nvmArch = @('64') }
  & nvm install $target @nvmArch
  & nvm use $target @nvmArch
  Update-SessionEnv
  $now = Get-NodeVersion
  if ($now -and $now.Major -ge $NODE_MAJOR) {
    Add-Result "Node.js $NODE_MAJOR+" "installed $($now.Version) and set as default via nvm"
  } else {
    $seen = 'none'
    if ($now) { $seen = $now.Version }
    Add-Result "Node.js $NODE_MAJOR+" "nvm ran but node reports $seen - run in an ADMIN terminal: nvm install $target $($nvmArch -join ' '); nvm use $target $($nvmArch -join ' ')" 'fail'
  }
  if (-not (Test-Command 'npm') -and -not ($env:NVM_SYMLINK -and (Test-Path (Join-Path $env:NVM_SYMLINK 'npm.cmd')))) {
    Add-Result 'npm' 'not found next to node' 'warn'
  }
}

# --- Platform gate: Windows 11 only, x64 or ARM64 -------------------------------
if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
  Write-Host 'This script is for Windows 11 only.' -ForegroundColor Red
  exit 1
}
$build = [Environment]::OSVersion.Version.Build
if ($build -lt 22000) {
  Write-Host "Windows 11 is required (build 22000 or newer); this is build $build. Sachivji supports Windows 11 only." -ForegroundColor Red
  exit 1
}
if ($OsArch -notin @('X64', 'Arm64')) {
  Write-Host "Unsupported CPU architecture '$OsArch'. Windows 11 on x64 (AMD64) or ARM64 is required." -ForegroundColor Red
  exit 1
}

function Get-RelaunchArgs([bool]$withElevated) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($withElevated) { $a += '-Elevated' }
  foreach ($k in @('Git', 'GitHubCli', 'Ollama', 'CloudCli', 'Node', 'Yes')) {
    if ((Get-Variable $k).Value) { $a += "-$k" }
  }
  return $a
}

# A 32-bit PowerShell on 64-bit Windows sees redirected folders and registry views: hop to the 64-bit one.
if ([IntPtr]::Size -eq 4 -and (Test-Path "$env:windir\sysnative\WindowsPowerShell\v1.0\powershell.exe")) {
  $p = Start-Process -FilePath "$env:windir\sysnative\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList (Get-RelaunchArgs $Elevated.IsPresent) -Wait -PassThru -NoNewWindow
  exit $p.ExitCode
}

# --- Elevation (only the Node group needs it) ---------------------------------
if ($Node -and -not (Test-Admin)) {
  Write-Host 'Node via nvm-windows needs administrator rights - asking Windows for elevation ...' -ForegroundColor Yellow
  $relaunch = Get-RelaunchArgs $true
  try {
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $relaunch -Verb RunAs -Wait -PassThru
    exit $p.ExitCode
  } catch {
    Write-Host 'Elevation was declined. Re-run, or run without -Node.' -ForegroundColor Red
    exit 1
  }
}

# --- Preconditions -----------------------------------------------------------
if (-not (Test-Command 'winget')) {
  Write-Host 'winget was not found. Install "App Installer" from the Microsoft Store, then re-run.' -ForegroundColor Red
  exit 1
}
if ($IsArmHost) {
  Add-Result 'CPU' 'ARM64 PC - x64 Python and x64 Node are used on purpose (matching wheels / native modules); the Sachivji installer is x64 and runs under emulation' 'warn'
} else {
  Add-Result 'CPU' 'x64 (AMD64)'
}
try {
  $sysDrive = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))
  $freeGb = [math]::Round($sysDrive.Free / 1GB, 1)
  if ($freeGb -lt 3) { Add-Result 'Free disk space' "$freeGb GB on $env:SystemDrive - at least 3 GB advised" 'warn' }
} catch { }
if (-not (Test-Url 'https://pypi.org/simple/')) {
  Add-Result 'Network: pypi.org' 'not reachable - the app cannot create its Python environment until it is (proxy / allow-list?)' 'warn'
}

# --- Run ---------------------------------------------------------------------
Update-SessionEnv
Ensure-Python

if ($Git)       { Install-Simple 'Git for Windows' 'Git.Git' 'git' }
if ($GitHubCli) {
  Install-Simple 'GitHub CLI' 'GitHub.cli' 'gh'
  if (Test-Command 'gh') {
    & gh auth status 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Add-Result 'GitHub CLI sign-in' 'signed in' }
    else { Add-Result 'GitHub CLI sign-in' 'not signed in - run: gh auth login' 'warn' }
  }
}
if ($Ollama)    { Ensure-Ollama }
if ($CloudCli) {
  Install-Simple 'AWS CLI'          'Amazon.AWSCLI'      'aws'
  Install-Simple 'Azure CLI'        'Microsoft.AzureCLI' 'az'
  Install-Simple 'Google Cloud CLI' 'Google.CloudSDK'    'gcloud'
}
if ($Node) {
  Ensure-Node
  Install-Simple 'uv' 'astral-sh.uv' 'uv'
}

# --- Summary -----------------------------------------------------------------
Write-Host ''
Write-Host '=== Summary ===' -ForegroundColor Green
foreach ($r in $results) {
  $color = 'White'
  if ($r.Level -eq 'warn') { $color = 'Yellow' }
  if ($r.Level -eq 'fail') { $color = 'Red' }
  Write-Host ('{0,-26} {1}' -f $r.Name, $r.Status) -ForegroundColor $color
}
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Green
Write-Host '  - Open a NEW terminal so PATH changes apply (then: py -3.12 --version, node --version).'
Write-Host '  - Install Sachivji from the .exe on the GitHub Releases page (SmartScreen: More info > Run anyway).'
Write-Host '  - Sign in where you use them: gh auth login, aws configure, az login, gcloud auth login.'
Write-Host '  - In Sachivji: add a provider key in Settings, then check Settings > Runtime for Python.'

$failed = @($results | Where-Object { $_.Level -eq 'fail' }).Count
if ($Elevated) { Read-Host 'Press Enter to close this window' | Out-Null }
if ($failed -gt 0) { exit 2 } else { exit 0 }
