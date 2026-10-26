# How heavy the app is on a real Windows desktop (CI): starts the built app,
# and every second writes down the CPU and memory of the app and of all its
# WebView2 helper processes, and of the whole machine:
#   1. for the first 60 seconds after launch, untouched;
#   2. for 40 seconds after Ctrl+, opens Settings;
#   3. for 20 seconds after Escape closes it again.
# Each phase's average and peak go to $Out/perf.txt (and every sample to
# perf.csv); a screenshot is taken at the end of each phase. Exits non-zero
# when the app, sitting still, keeps a CPU core busy — the "whole computer
# lags" that people saw.
param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out,
  # Average CPU of the app's whole tree, in % of ONE core, allowed while idle.
  [double]$IdleLimit = 15
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Keys2 {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Tap(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
  public static void Chord(byte mod, byte vk) {
    keybd_event(mod, 0, 0, UIntPtr.Zero); Tap(vk); keybd_event(mod, 0, 2, UIntPtr.Zero);
  }
}
'@
[Keys2]::SetProcessDPIAware() | Out-Null

function Shot($name) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size)
  $bitmap.Save((Join-Path $Out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}

$cores = [Environment]::ProcessorCount
# Set up as people run it: the ring and drop zone on and kept in the
# background, Ask ZOOD's keys and taps on, and the ZOOD bubble on screen.
$data = Join-Path $env:APPDATA 'app.warraq.desktop'
New-Item -ItemType Directory -Force -Path $data | Out-Null
'{"ring":true,"background":true,"scale":1,"shortcut":"Ctrl+Alt+Z","dragKey":"any","dropZone":true}' |
  Set-Content -Encoding utf8 (Join-Path $data 'quick-tools.json')
'{"enabled":true,"shortcut":"","sees":false,"taps":true,"tap_key":"right-main","tap_to_type":true,"tap_speaks":true,"glow":true}' |
  Set-Content -Encoding utf8 (Join-Path $data 'ask.json')
'{"bubble":true,"lang":"en"}' | Set-Content -Encoding utf8 (Join-Path $data 'presence.json')
Remove-Item (Join-Path $env:APPDATA 'app.warraq.desktop\stall.log') -ErrorAction SilentlyContinue
# A run left over from an earlier check would take this launch over (one
# app at a time), and the numbers would be of nothing.
Get-Process warraq-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process -FilePath $App | Out-Null
Start-Sleep -Milliseconds 500
$root = (Get-Process warraq-desktop -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1).Id
if (-not $root) { throw 'the app did not start' }

# The app and everything it started (WebView2 browser, renderers, GPU ...).
function Tree {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $ids = New-Object System.Collections.Generic.HashSet[int]
  [void]$ids.Add($root)
  do {
    $grew = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
        [void]$ids.Add([int]$p.ProcessId); $grew = $true
      }
    }
  } while ($grew)
  foreach ($id in $ids) { Get-Process -Id $id -ErrorAction SilentlyContinue }
}

$samples = New-Object System.Collections.Generic.List[object]
$last = @{}
$lastAt = Get-Date
function Sample($phase, $seconds) {
  foreach ($n in 1..$seconds) {
    Start-Sleep -Seconds 1
    $now = Get-Date
    $span = ($now - $script:lastAt).TotalSeconds
    $script:lastAt = $now
    $cpu = 0.0; $ram = 0; $private = 0; $count = 0; $views = 0
    $seen = @{}
    foreach ($p in Tree) {
      $count++
      if ($p.ProcessName -like 'msedgewebview2*') { $views++ }
      $t = $p.TotalProcessorTime.TotalSeconds
      $before = if ($script:last.ContainsKey($p.Id)) { $script:last[$p.Id] } else { $t }
      $cpu += ($t - $before)
      $seen[$p.Id] = $t
      $ram += $p.WorkingSet64
      $private += $p.PrivateMemorySize64
    }
    $script:last = $seen
    $machine = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $samples.Add([pscustomobject]@{
      phase = $phase; second = $n
      appCpuOfOneCore = [math]::Round(100 * $cpu / $span, 1)
      machineCpu = $machine
      workingSetMB = [math]::Round($ram / 1MB)
      privateMB = [math]::Round($private / 1MB)
      processes = $count; webviewProcesses = $views
    })
  }
}

Sample 'launch' 60
Shot 'perf-1-launch.png'

# Ctrl+, opens Settings in the focused editor window.
$main = Get-Process -Id $root -ErrorAction SilentlyContinue
if ($main -and $main.MainWindowHandle -ne [IntPtr]::Zero) {
  [Keys2]::Tap(0x12)
  [Keys2]::SetForegroundWindow($main.MainWindowHandle) | Out-Null
}
Start-Sleep -Milliseconds 500
[Keys2]::Chord(0x11, 0xBC)
Sample 'settings' 40
Shot 'perf-2-settings.png'

[Keys2]::Tap(0x1B)
Sample 'after' 20
Shot 'perf-3-after.png'

$samples | Export-Csv -NoTypeInformation (Join-Path $Out 'perf.csv')
$report = foreach ($phase in 'launch', 'settings', 'after') {
  $s = $samples | Where-Object phase -eq $phase
  # The first 15 seconds of launch are the app starting; "idle" is the rest.
  $idle = if ($phase -eq 'launch') { $s | Where-Object second -gt 15 } else { $s | Where-Object second -gt 10 }
  [pscustomobject]@{
    phase = $phase
    cpuAvg = [math]::Round(($s | Measure-Object appCpuOfOneCore -Average).Average, 1)
    cpuPeak = ($s | Measure-Object appCpuOfOneCore -Maximum).Maximum
    cpuSettled = [math]::Round(($idle | Measure-Object appCpuOfOneCore -Average).Average, 1)
    machineAvg = [math]::Round(($s | Measure-Object machineCpu -Average).Average, 1)
    ramPeakMB = ($s | Measure-Object workingSetMB -Maximum).Maximum
    ramEndMB = ($s | Select-Object -Last 1).workingSetMB
    processes = ($s | Select-Object -Last 1).processes
    webviews = ($s | Select-Object -Last 1).webviewProcesses
  }
}
$text = "cores: $cores (CPU in % of one core; 100 = one core fully busy)`n" + ($report | Format-Table -AutoSize | Out-String)
$text += "`nper-process at the end:`n" + (Tree | Sort-Object WorkingSet64 -Descending |
  Format-Table Id, ProcessName, @{n='cpuSec';e={[math]::Round($_.TotalProcessorTime.TotalSeconds,1)}}, @{n='MB';e={[math]::Round($_.WorkingSet64/1MB)}} -AutoSize | Out-String)
$stalls = Join-Path $env:APPDATA 'app.warraq.desktop\stall.log'
if (Test-Path $stalls) {
  Copy-Item $stalls (Join-Path $Out 'stall.log')
  $text += "`nstall.log (what held the main thread up):`n" + (Get-Content $stalls -Raw)
}
$text | Set-Content (Join-Path $Out 'perf.txt')
Write-Host $text

Stop-Process -Id $root -Force -ErrorAction SilentlyContinue
Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$settled = ($report | Where-Object phase -in 'launch', 'after' | Measure-Object cpuSettled -Maximum).Maximum
if ($settled -gt $IdleLimit) {
  Write-Host "FAILED: sitting still the app used $settled% of a core (limit $IdleLimit%)"
  exit 1
}
