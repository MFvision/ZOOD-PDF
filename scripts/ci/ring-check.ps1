# Tries the ring on a real Windows desktop (CI): starts the built app, opens
# File Explorer on a folder with one file, and drags that file with Ctrl held,
# by sending the same mouse and key input a person makes. Passes when the
# app writes "ring shown" to its ring.log. Leaves the log and a screenshot
# taken mid-drag in the folder given, for the ci-logs branch.
param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Input {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; public uint pad1, pad2; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT m; [FieldOffset(0)] public KEYBDINPUT k; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  public static void Mouse(int x, int y, uint flags) {
    var i = new INPUT { type = 0 };
    i.u.m.dx = x * 65535 / (GetSystemMetrics(0) - 1);
    i.u.m.dy = y * 65535 / (GetSystemMetrics(1) - 1);
    i.u.m.flags = flags | 0x8001; // ABSOLUTE | MOVE
    Send(i);
  }
  public static void Key(ushort vk, bool up) {
    var i = new INPUT { type = 1 };
    i.u.k.vk = vk; i.u.k.flags = up ? 2u : 0u;
    Send(i);
  }
}
'@

function Shot($name) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save((Join-Path $Out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}

$log = Join-Path $env:APPDATA 'app.warraq.desktop\ring.log'
Remove-Item $log -ErrorAction SilentlyContinue

$folder = Join-Path $env:RUNNER_TEMP 'ring-check'
New-Item -ItemType Directory -Force -Path $folder | Out-Null
Set-Content -Path (Join-Path $folder 'sample.pdf') -Value '%PDF-1.4'

$app = Start-Process -FilePath $App -PassThru
Start-Sleep -Seconds 8
Start-Process explorer.exe $folder
Start-Sleep -Seconds 6

$root = [System.Windows.Automation.AutomationElement]::RootElement
$named = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty), 'sample.pdf'
$item = $null
foreach ($try in 1..10) {
  $item = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $named)
  if ($item) { break }
  Start-Sleep -Seconds 1
}
if (-not $item) { Shot 'ring-no-file.png'; throw 'File Explorer did not show the file' }
$box = $item.Current.BoundingRectangle
$x = [int]($box.X + $box.Width / 2); $y = [int]($box.Y + $box.Height / 2)
Write-Host "file at $x,$y"

[Input]::Mouse($x, $y, 0); Start-Sleep -Milliseconds 300
[Input]::Key(0x11, $false); Start-Sleep -Milliseconds 200   # Ctrl down
[Input]::Mouse($x, $y, 0x0002); Start-Sleep -Milliseconds 200  # left down
foreach ($step in 1..20) { [Input]::Mouse($x + $step * 8, $y + $step * 4, 0); Start-Sleep -Milliseconds 40 }
Start-Sleep -Seconds 2
Shot 'ring-mid-drag.png'
[Input]::Mouse($x + 160, $y + 80, 0x0004)  # left up, away from the ring's tools
[Input]::Key(0x11, $true)
Start-Sleep -Seconds 2

if (Test-Path $log) { Copy-Item $log (Join-Path $Out 'ring.log') } else { Set-Content (Join-Path $Out 'ring.log') 'no ring.log was written' }
Stop-Process -Id $app.Id -ErrorAction SilentlyContinue
$text = Get-Content (Join-Path $Out 'ring.log') -Raw
Write-Host $text
if ($text -notmatch 'ring shown') { throw 'the ring did not open' }
Write-Host 'the ring opened'
