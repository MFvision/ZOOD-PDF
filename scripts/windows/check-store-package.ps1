# Tries the Store package on this machine as a person would get it
# (docs/store.md): installs a test-signed package (make-store-package.ps1
# -TestSign), starts the app through its command-line name on a PDF, asks
# Windows for the right-click menu's entries the way Explorer does, picks the
# PDF entry, and removes the package again. Needs an administrator (the test
# certificate goes in the machine's trusted people).
#
#   ./scripts/windows/check-store-package.ps1 -Package out/ZOOD-PDF-0.5.0-store.msix `
#     -Probe apps/desktop/src-tauri/shell-ext/target/release/examples/probe.exe -Sample tests/fixtures/layers/layers.pdf
param(
  [Parameter(Mandatory)] [string] $Package,
  [Parameter(Mandatory)] [string] $Probe,
  [Parameter(Mandatory)] [string] $Sample,
  [string] $Out = 'store-check'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory $Out -Force | Out-Null
$Sample = (Resolve-Path $Sample).Path
$log = Join-Path $Out 'store-check.log'
function Say([string] $text) { Write-Output $text; Add-Content $log $text }
function App { Get-Process warraq-desktop -ErrorAction SilentlyContinue }
function StopApp { App | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 2 }
$failed = @()

Import-Certificate -FilePath "$Package.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
Add-AppxPackage -Path $Package
$installed = Get-AppxPackage | Where-Object { $_.InstallLocation -and (Test-Path (Join-Path $_.InstallLocation 'zood_shell_ext.dll')) } | Select-Object -First 1
if (-not $installed) { throw 'the package did not install' }
Say "installed $($installed.PackageFullName) in $($installed.InstallLocation)"

# 1. The command-line name, as the menu starts the app.
$alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\zoodpdf.exe'
if (Test-Path $alias) { Say "alias: $alias" } else { $failed += 'the zoodpdf alias is missing' }

# 2. The app starts as the package on a PDF and stays open.
StopApp
Start-Process $alias -ArgumentList "`"$Sample`""
Start-Sleep 30
$running = App
if ($running) {
  $paths = ($running | ForEach-Object { $_.Path }) -join ', '
  Say "the app is running from $paths"
  if ($paths -notlike '*WindowsApps*') { $failed += 'the app did not run from the package' }
} else {
  $failed += 'the app quit within 30 s of starting'
}
StopApp

# 3. The menu's entries, as Explorer asks for them, and the PDF entry picked
#    on the sample, which must start the app's quick window.
$output = & $Probe 2>&1
$code = $LASTEXITCODE
$output | ForEach-Object { Say "probe: $_" }
if ($code -ne 0) { $failed += "the menu's entries could not be read (exit $code)" }

$output = & $Probe $Sample 2>&1
$code = $LASTEXITCODE
$output | ForEach-Object { Say "probe: $_" }
if ($code -ne 0) {
  $failed += "the PDF entry could not be picked (exit $code)"
} else {
  Start-Sleep 20
  if (App) { Say 'the PDF entry started the app' } else { $failed += 'the PDF entry did not start the app' }
}
StopApp

# 4. Removing it takes everything away.
Remove-AppxPackage -Package $installed.PackageFullName
if (Test-Path $alias) { $failed += 'the alias stayed after removing the package' }
Say 'removed the package'

if ($failed.Count -gt 0) {
  $failed | ForEach-Object { Write-Output "::error::$_"; Add-Content $log "FAILED: $_" }
  exit 1
}
Say 'the Store package works'
