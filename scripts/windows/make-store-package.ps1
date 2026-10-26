# Makes the Microsoft Store package (.msix) of ZOOD PDF from a finished
# Windows build (docs/store.md). Run on Windows, from anywhere, after the app
# and the right-click menu's add-on are built:
#
#   pnpm --dir apps/desktop exec tauri build --no-bundle
#   cargo build --release --manifest-path apps/desktop/src-tauri/shell-ext/Cargo.toml
#   ./scripts/windows/make-store-package.ps1 -Version 0.5.0 -Out out/ZOOD-PDF-0.5.0-store.msix `
#     -Name <Package/Identity/Name> -Publisher <Package/Identity/Publisher> -PublisherDisplayName <...>
#
# The three identity values are on Partner Center, Product management >
# Product identity. Without them the package gets test values: good for
# trying it on this machine with -TestSign (check-store-package.ps1), not for
# the Store. A Store upload stays unsigned; the Store signs it.
param(
  [Parameter(Mandatory)] [string] $Version,
  [Parameter(Mandatory)] [string] $Out,
  [string] $Name = 'ZoodPDF.Test',
  [string] $Publisher = 'CN=ZOOD PDF Test',
  [string] $PublisherDisplayName = 'ZOOD PDF',
  [string] $DisplayName = 'ZOOD PDF',
  # Signs with a certificate made here, and writes it beside the package
  # (.cer), so this machine can install the package.
  [switch] $TestSign
)
$ErrorActionPreference = 'Stop'

function Run($exe, [string[]] $arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$(Split-Path $exe -Leaf) failed (exit $LASTEXITCODE)" }
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "version must look like 0.5.0, not '$Version'" }
$root = (Resolve-Path "$PSScriptRoot/../..").Path
$tauri = "$root/apps/desktop/src-tauri"
$release = "$tauri/target/release"
$dll = "$tauri/shell-ext/target/release/zood_shell_ext.dll"
foreach ($file in "$release/warraq-desktop.exe", $dll) {
  if (-not (Test-Path $file)) { throw "missing ${file}: build the app and the add-on first" }
}

# The Windows SDK's packaging tools, newest first.
$kits = 'C:\Program Files (x86)\Windows Kits\10\bin'
$sdk = Get-ChildItem $kits -Directory |
  Where-Object { $_.Name -match '^10\.' -and (Test-Path "$($_.FullName)\x64\makeappx.exe") } |
  Sort-Object { [version]$_.Name } | Select-Object -Last 1
if (-not $sdk) { throw "no Windows SDK with makeappx.exe under $kits" }
$tools = "$($sdk.FullName)\x64"
Write-Output "Windows SDK $($sdk.Name)"

# The package's files: what the installer installs (the program and the
# resources tauri.windows.conf.json lists), the add-on, and the pictures.
$work = Join-Path ([IO.Path]::GetTempPath()) "zood-store-$PID"
$layout = "$work/layout"
New-Item -ItemType Directory $layout -Force | Out-Null
Copy-Item "$release/warraq-desktop.exe", $dll $layout
$config = Get-Content "$tauri/tauri.windows.conf.json" -Raw | ConvertFrom-Json
foreach ($pattern in $config.bundle.resources) {
  foreach ($file in Get-ChildItem (Join-Path $tauri $pattern) -File) {
    $relative = $file.FullName.Substring((Resolve-Path $tauri).Path.Length + 1)
    $target = Join-Path $layout $relative
    New-Item -ItemType Directory (Split-Path $target) -Force | Out-Null
    Copy-Item $file.FullName $target
  }
}
Copy-Item "$tauri/windows/store/Assets" "$layout/Assets" -Recurse

# The manifest, with this package's identity and version (the Store wants
# the fourth number 0).
function Xml([string] $text) { [Security.SecurityElement]::Escape($text) }
$manifest = Get-Content "$tauri/windows/store/AppxManifest.xml" -Raw -Encoding UTF8
$manifest = $manifest.Replace('$NAME$', (Xml $Name))
$manifest = $manifest.Replace('$PUBLISHER_DISPLAY_NAME$', (Xml $PublisherDisplayName))
$manifest = $manifest.Replace('$PUBLISHER$', (Xml $Publisher))
$manifest = $manifest.Replace('$DISPLAY_NAME$', (Xml $DisplayName))
$manifest = $manifest.Replace('$VERSION$', "$Version.0")
if ($manifest -match '\$[A-Z_]+\$') { throw "manifest value left unfilled: $($Matches[0])" }
[IO.File]::WriteAllText("$layout/AppxManifest.xml", $manifest, (New-Object Text.UTF8Encoding $false))

# The resource index: picks the right picture size for each place.
Run "$tools\makepri.exe" @('createconfig', '/cf', "$work\priconfig.xml", '/dq', 'en-US', '/pv', '10.0.0', '/o')
Run "$tools\makepri.exe" @('new', '/pr', $layout, '/cf', "$work\priconfig.xml", '/mn', "$layout\AppxManifest.xml", '/of', "$layout\resources.pri", '/o')

$Out = [IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory (Split-Path $Out) -Force | Out-Null
Run "$tools\makeappx.exe" @('pack', '/d', $layout, '/p', $Out, '/o')

if ($TestSign) {
  $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature `
    -FriendlyName 'ZOOD PDF test package' -CertStoreLocation 'Cert:\CurrentUser\My' `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
  $secret = [Guid]::NewGuid().ToString('N')
  $pfx = "$work\test.pfx"
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString $secret -AsPlainText -Force) | Out-Null
  Run "$tools\signtool.exe" @('sign', '/fd', 'SHA256', '/f', $pfx, '/p', $secret, $Out)
  Export-Certificate -Cert $cert -FilePath "$Out.cer" | Out-Null
  Remove-Item $pfx
}

Remove-Item $work -Recurse -Force
Write-Output "made $Out ($([math]::Round((Get-Item $Out).Length / 1MB, 1)) MB)"
