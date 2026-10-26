# Tries Ask ZOOD's island on a real Windows desktop (CI), as a person would:
# turns the tap key on (as Settings would, in ask.json), starts the built
# app, taps right Ctrl once — the typing island, since this machine has no
# microphone — and checks the island is on the screen and drawn. Then it
# closes it with Escape and taps again, as a second ask. The app's own log,
# the island's window as Windows has it, and screenshots go to $Out.
param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AskInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; public uint pad1, pad2; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT m; [FieldOffset(0)] public KEYBDINPUT k; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  public static int Width { get { return GetSystemMetrics(0); } }
  public static int Height { get { return GetSystemMetrics(1); } }
  // Right Ctrl is the extended Ctrl key.
  public static void Key(ushort vk, bool up, bool extended) {
    var i = new INPUT { type = 1 };
    i.u.k.vk = vk; i.u.k.flags = (up ? 2u : 0u) | (extended ? 1u : 0u);
    SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
[AskInput]::SetProcessDPIAware() | Out-Null

function Screen {
  $bitmap = New-Object System.Drawing.Bitmap ([AskInput]::Width), ([AskInput]::Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size)
  $graphics.Dispose()
  return $bitmap
}

function Shot($name) {
  $bitmap = Screen
  $bitmap.Save((Join-Path $Out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

$failures = @()
function Check($ok, $what) {
  if ($ok) { Write-Host "ok: $what" } else { Write-Host "FAILED: $what"; $script:failures += $what }
}

# How much of the island's place looks different from the screen before the
# first tap: a window drawn empty (transparent) leaves the desktop showing.
function Drawn($rect) {
  $now = Screen
  $changed = 0; $all = 0
  $left = [Math]::Max(0, $rect.Left); $top = [Math]::Max(0, $rect.Top)
  $right = [Math]::Min($now.Width, $rect.Right); $bottom = [Math]::Min($now.Height, $rect.Bottom)
  for ($x = $left; $x -lt $right; $x += 4) {
    for ($y = $top; $y -lt $bottom; $y += 4) {
      $a = $now.GetPixel($x, $y); $b = $script:before.GetPixel($x, $y); $all++
      if ([Math]::Abs($a.R - $b.R) + [Math]::Abs($a.G - $b.G) + [Math]::Abs($a.B - $b.B) -gt 40) { $changed++ }
    }
  }
  $now.Dispose()
  return [Math]::Round($changed / [Math]::Max(1, $all), 2)
}

function Tap {
  [AskInput]::Key(0xA3, $false, $true); Start-Sleep -Milliseconds 90
  [AskInput]::Key(0xA3, $true, $true)
}

function Island($when) {
  $hwnd = [AskInput]::FindWindow([NullString]::Value, 'Ask ZOOD')
  if ($hwnd -eq [IntPtr]::Zero) { Write-Host "${when}: no island window"; return $null }
  $rect = New-Object AskInput+RECT
  [AskInput]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $visible = [AskInput]::IsWindowVisible($hwnd)
  $drawn = Drawn $rect
  Write-Host "${when}: island visible=$visible at $($rect.Left),$($rect.Top) to $($rect.Right),$($rect.Bottom), drawn=$drawn"
  return @{ Visible = $visible; Rect = $rect; Drawn = $drawn }
}

# Ask ZOOD on, with the tap key, as Settings › AI leaves it. No model is
# here, so one tap opens the box to type in.
$data = Join-Path $env:APPDATA 'app.warraq.desktop'
New-Item -ItemType Directory -Force -Path $data | Out-Null
'{"enabled":false,"shortcut":"","sees":false,"taps":true,"tap_key":"right-main","tap_to_type":true,"tap_speaks":true,"glow":true}' |
  Set-Content -Encoding ascii (Join-Path $data 'ask.json')

$env:WARRAQ_DEBUG = '1'
$app = Start-Process -FilePath $App -PassThru `
  -RedirectStandardOutput (Join-Path $Out 'app.log') -RedirectStandardError (Join-Path $Out 'app-err.log')
Start-Sleep -Seconds 12
Shot 'ask-0-started.png'
$before = Screen

# 1. The first tap: the island's window is made now.
Tap
Start-Sleep -Seconds 4
Shot 'ask-1-first-tap.png'
$first = Island 'first tap'
Check ($first -and $first.Visible) 'the first tap shows the island window'
Check ($first -and $first.Drawn -ge 0.2) 'the first tap draws the island'

# 2. Gone with Escape (it has the keyboard to type in), then a second tap.
[AskInput]::Key(0x1B, $false, $false); Start-Sleep -Milliseconds 80; [AskInput]::Key(0x1B, $true, $false)
Start-Sleep -Seconds 2
Shot 'ask-2-closed.png'
$closed = Island 'after Escape'
Check (-not $closed -or -not $closed.Visible -or $closed.Rect.Left -lt -1000 -or $closed.Drawn -lt 0.2) 'Escape puts the island away'
Tap
Start-Sleep -Seconds 4
Shot 'ask-3-second-tap.png'
$second = Island 'second tap'
Check ($second -and $second.Visible) 'the second tap shows the island window'
Check ($second -and $second.Drawn -ge 0.2) 'the second tap draws the island'

Get-Process -Name warraq-desktop -ErrorAction SilentlyContinue | Stop-Process -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
if ($failures.Count -gt 0) { throw "ask check failed: $($failures -join '; ')" }
