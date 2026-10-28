# Tries the right-click quick tools on a real Windows desktop (CI) the way
# File Explorer runs them, with the app already in the tray:
#   1. starts the built app with --background (as at sign-in: no window);
#   2. runs `warraq-desktop.exe --quick --tool=word sample.pdf`, as the
#      right-click menu does: sample.docx appears beside the PDF, and the
#      quick window closes by itself once it is done;
#   3. the same with --tool=compress: a compressed PDF, window gone;
#   4. a file that is not a PDF inside (broken.pdf): no result, and the
#      window stays open, so the person sees which file failed and why.
# Each step is checked in the folder, by the window's title, and in ring.log
# (which says the second launch was handed over and what the window did);
# the log and screenshots go to $Out for ci-logs.
param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Sample,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
# A full path: Start-Process with arguments does not find a relative one.
$App = (Resolve-Path $App).Path
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
}
'@

$failures = @()
function Check($ok, $what) {
  if ($ok) { Write-Host "ok: $what" } else { Write-Host "FAILED: $what"; $script:failures += $what }
}
function Shot($name) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save((Join-Path $Out "$name.png"))
  $graphics.Dispose(); $bitmap.Dispose()
}

$log = Join-Path $env:APPDATA 'app.warraq.desktop\ring.log'
Remove-Item $log -ErrorAction SilentlyContinue
function Log { if (Test-Path $log) { Get-Content $log -Raw } else { '' } }

$titles = @('أدوات PDF السريعة — محرر زود PDF', 'Quick PDF tools — ZOOD PDF')
function QuickWindow {
  foreach ($title in $titles) {
    $found = [Win]::FindWindow([NullString]::Value, $title)
    if ($found -ne [IntPtr]::Zero) { return $found }
  }
  return [IntPtr]::Zero
}
function WaitFor([scriptblock]$test, $seconds) {
  foreach ($try in 1..($seconds * 2)) {
    if (& $test) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$folder = Join-Path $env:RUNNER_TEMP 'quick-check'
New-Item -ItemType Directory -Force -Path $folder | Out-Null
Copy-Item $Sample (Join-Path $folder 'sample.pdf')
[System.IO.File]::WriteAllText((Join-Path $folder 'broken.pdf'), 'this is not a PDF')

$app = Start-Process -FilePath $App -ArgumentList '--background' -PassThru
try {
  Start-Sleep -Seconds 10
  Check (-not $app.HasExited) 'the app keeps running in the background'

  # 2. Right-click › Word, with the app in the tray.
  $pdf = Join-Path $folder 'sample.pdf'
  Start-Process -FilePath $App -ArgumentList @('--quick', '--tool=word', "`"$pdf`"") | Out-Null
  $made = WaitFor { Get-ChildItem $folder -Filter 'sample*.docx' } 30
  Shot 'word-after'
  Check $made 'right-click Word makes sample.docx beside the PDF'
  Check (WaitFor { (QuickWindow) -eq [IntPtr]::Zero } 8) 'the quick window closes by itself after Word'
  Check ((Log) -match 'second launch: a quick tool') 'ring.log: the second launch was handed to the running copy'
  Check ((Log) -match 'word: 1 done, 0 failed') 'ring.log: the window says Word went well'

  # 3. Right-click › Compress.
  Start-Process -FilePath $App -ArgumentList @('--quick', '--tool=compress', "`"$pdf`"") | Out-Null
  $made = WaitFor { Get-ChildItem $folder -Filter 'sample*compressed*.pdf' } 30
  Check $made 'right-click Compress makes a compressed PDF'
  Check (WaitFor { (QuickWindow) -eq [IntPtr]::Zero } 8) 'the quick window closes by itself after Compress'

  # 4. A file that fails: the window stays, with it marked.
  $broken = Join-Path $folder 'broken.pdf'
  Start-Process -FilePath $App -ArgumentList @('--quick', '--tool=word', "`"$broken`"") | Out-Null
  Check (WaitFor { (Log) -match 'word: 0 done, 1 failed' } 30) 'ring.log: the window says the broken file failed'
  Start-Sleep -Seconds 4
  Shot 'failed-stays'
  $window = QuickWindow
  Check ($window -ne [IntPtr]::Zero) 'the quick window stays open when a file fails'
  Check (-not (Get-ChildItem $folder -Filter 'broken*.docx')) 'nothing is made from the broken file'
  if ($window -ne [IntPtr]::Zero) { [Win]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }

  Start-Sleep -Seconds 2
} catch {
  Check $false "the check itself: $($_.Exception.Message)"
} finally {
  # What the app logged and what the folder holds, whatever happened.
  Set-Content (Join-Path $Out 'ring.log') (Log)
  Get-ChildItem $folder | Format-Table Name, Length | Out-String | Set-Content (Join-Path $Out 'folder.txt')
  Get-Process -Name warraq-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq $app.Id } | Stop-Process -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) { throw "quick check failed: $($failures -join '; ')" }
Write-Host 'quick check passed'
