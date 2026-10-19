# Tries the ring on a real Windows desktop (CI) the way a person uses it, by
# sending the same mouse and key input: starts the built app, opens File
# Explorer on a folder with one PDF, and
#   1. Ctrl+drags the file onto the ring's top tool (Compress) and lets go:
#      it runs on the ring, and sample-compressed.pdf appears beside it;
#   2. Shift+drags it into the ring's middle, lets go, then clicks the bottom
#      tool (Rotate): sample-rotated.pdf;
#   3. with Explorer pushed into the screen's bottom-right corner, Ctrl+drags
#      again and checks the ring is whole on the screen;
#   5. selects the file and presses Ctrl+Alt+Z: the ring opens holding it,
#      and a click on Compress runs it;
#   4. (a control) drags the file plainly onto the app's main window.
# Each step is checked in the app's ring.log and in the folder, and by where
# the app says it put the ring; screenshots go to $Out for ci-logs.
param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Sample,
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
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  public static int Width { get { return GetSystemMetrics(0); } }
  public static int Height { get { return GetSystemMetrics(1); } }
  public static void Mouse(int x, int y, uint flags) {
    var i = new INPUT { type = 0 };
    i.u.m.dx = x * 65535 / (Width - 1);
    i.u.m.dy = y * 65535 / (Height - 1);
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
[Input]::SetProcessDPIAware() | Out-Null

function Shot($name) {
  $bitmap = New-Object System.Drawing.Bitmap ([Input]::Width), ([Input]::Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size)
  $bitmap.Save((Join-Path $Out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}

$failures = @()
$shots = 0
function Check($ok, $what) {
  if ($ok) { Write-Host "ok: $what" } else { Write-Host "FAILED: $what"; $script:failures += $what }
}

$log = Join-Path $env:APPDATA 'app.warraq.desktop\ring.log'
Remove-Item $log -ErrorAction SilentlyContinue
function Log { if (Test-Path $log) { Get-Content $log -Raw } else { '' } }

$folder = Join-Path $env:RUNNER_TEMP 'ring-check'
New-Item -ItemType Directory -Force -Path $folder | Out-Null
Copy-Item $Sample (Join-Path $folder 'sample.pdf')

$app = Start-Process -FilePath $App -PassThru
Start-Sleep -Seconds 8
Start-Process explorer.exe $folder
Start-Sleep -Seconds 6

# File Explorer in front: the app, still loading, can come up over it.
function ExplorerToFront {
  $explorer = [Input]::FindWindow('CabinetWClass', [NullString]::Value)
  if ($explorer -ne [IntPtr]::Zero) {
    # A tap of Alt lets this process hand the foreground over.
    [Input]::Key(0x12, $false); [Input]::Key(0x12, $true)
    [Input]::SetForegroundWindow($explorer) | Out-Null
    Start-Sleep -Milliseconds 500
  }
}

function FileItem {
  ExplorerToFront
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  # Explorer hides known extensions, so the item may be named either way.
  $name = [System.Windows.Automation.AutomationElement]::NameProperty
  $named = New-Object System.Windows.Automation.OrCondition `
    (New-Object System.Windows.Automation.PropertyCondition $name, 'sample.pdf'),
    (New-Object System.Windows.Automation.PropertyCondition $name, 'sample')
  foreach ($try in 1..10) {
    $item = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $named)
    if ($item) {
      $box = $item.Current.BoundingRectangle
      return @([int]($box.X + 30), [int]($box.Y + $box.Height / 2))
    }
    Start-Sleep -Seconds 1
  }
  Shot 'ring-no-file.png'
  throw 'File Explorer did not show the file'
}

# Presses on the file with the key held and drags until the ring shows;
# returns the ring's rectangle (still dragging).
function StartDrag($key) {
  $at = FileItem
  $x = $at[0]; $y = $at[1]
  [Input]::Mouse($x, $y, 0); Start-Sleep -Milliseconds 300
  [Input]::Key($key, $false); Start-Sleep -Milliseconds 200
  [Input]::Mouse($x, $y, 0x0002); Start-Sleep -Milliseconds 200   # left down
  foreach ($step in 1..6) { [Input]::Mouse($x + $step * 4, $y + $step * 2, 0); Start-Sleep -Milliseconds 40 }
  # The ring takes the drag only once the pointer moves over it.
  foreach ($step in 1..10) { [Input]::Mouse($x + 24 + $step, $y + 12, 0); Start-Sleep -Milliseconds 60 }
  Start-Sleep -Milliseconds 600
  $script:shots++
  Shot "ring-drag-$($script:shots).png"
  # Where the app says it put the ring (the last line of its log).
  $found = [regex]::Matches((Log), 'ring window at (-?\d+),(-?\d+) size (\d+)x(\d+)')
  $rect = New-Object Input+RECT
  if ($found.Count -gt 0) {
    $m = $found[$found.Count - 1]
    $rect.Left = [int]$m.Groups[1].Value; $rect.Top = [int]$m.Groups[2].Value
    $rect.Right = $rect.Left + [int]$m.Groups[3].Value; $rect.Bottom = $rect.Top + [int]$m.Groups[4].Value
  }
  return $rect
}

# Moves the dragged files to a point in small steps, so the drop target follows.
function DragTo($x, $y) {
  foreach ($step in 1..12) { [Input]::Mouse($x + 12 - $step, $y, 0); Start-Sleep -Milliseconds 50 }
  Start-Sleep -Milliseconds 500
}

# The quick window a picked tool opens: there, then closed so the next step
# can reach Explorer.
$quickTitle = 'أدوات PDF السريعة — محرر PDF'
function QuickWindowOpened {
  foreach ($try in 1..10) {
    $quick = [Input]::FindWindow([NullString]::Value, $quickTitle)
    if ($quick -ne [IntPtr]::Zero) {
      Start-Sleep -Seconds 2
      return $quick
    }
    Start-Sleep -Milliseconds 500
  }
  return [IntPtr]::Zero
}
# A result beside the sample, waited for (a tool on the ring writes it when done).
function ResultAppears($name) {
  foreach ($try in 1..40) {
    if (Test-Path (Join-Path $folder $name)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function CloseQuick($quick) {
  if ($quick -ne [IntPtr]::Zero) { [Input]::PostMessage($quick, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
  Start-Sleep -Seconds 2
}

# 1. Ctrl+drag onto Compress, the top tool.
$ring = StartDrag 0x11
$side = $ring.Right - $ring.Left
Check ($side -gt 0) "the ring opened for a Ctrl+drag (ring $($ring.Left),$($ring.Top) side $side)"
if ($side -gt 0) {
  $cx = $ring.Left + $side / 2; $cy = $ring.Top + $side / 2
  $middle = $side * 97 / 300   # between the hub and the outer edge
  DragTo $cx ($cy - $middle)
  Shot 'ring-1-over-compress.png'
  [Input]::Mouse($cx, $cy - $middle, 0x0004); [Input]::Key(0x11, $true)
  Start-Sleep -Seconds 3
  Shot 'ring-1-running.png'
  Check (ResultAppears 'sample-compressed.pdf') 'letting go on Compress makes sample-compressed.pdf at once'
  Start-Sleep -Seconds 3
  Check ((Log) -match 'done: 1 made, 0 failed') 'the ring says Compress is done'
  Shot 'ring-1-after.png'
} else {
  [Input]::Mouse(10, 10, 0x0004); [Input]::Key(0x11, $true)
}
Start-Sleep -Seconds 2

# 2. Shift+drag into the middle, let go, then click Rotate, the bottom tool.
$ring = StartDrag 0x10
$side = $ring.Right - $ring.Left
Check ($side -gt 0) 'the ring opened for a Shift+drag'
if ($side -gt 0) {
  $cx = $ring.Left + $side / 2; $cy = $ring.Top + $side / 2
  $middle = $side * 97 / 300
  DragTo $cx $cy
  [Input]::Mouse($cx, $cy, 0x0004); [Input]::Key(0x10, $true)
  Start-Sleep -Seconds 1
  Shot 'ring-2-holding.png'
  $lines = (Log) -split "`n" | Where-Object { $_ -match 'let go on the ring|picked|running a tool' }
  Check ($lines.Count -gt 0 -and $lines[-1] -match '1 files let go on the ring') 'letting go in the middle keeps the ring, holding the file'
  [Input]::Mouse($cx, $cy + $middle, 0); Start-Sleep -Milliseconds 300
  [Input]::Mouse($cx, $cy + $middle, 0x0002); Start-Sleep -Milliseconds 80
  [Input]::Mouse($cx, $cy + $middle, 0x0004)
  Start-Sleep -Seconds 3
  Check (ResultAppears 'sample-rotated.pdf') 'clicking Rotate makes sample-rotated.pdf'
  Shot 'ring-2-after.png'
  Start-Sleep -Seconds 3
} else {
  [Input]::Mouse(10, 10, 0x0004); [Input]::Key(0x10, $true)
}
Start-Sleep -Seconds 2

# 3. Explorer in the bottom-right corner: the ring must stay whole on the screen.
$explorer = [Input]::FindWindow('CabinetWClass', [NullString]::Value)
[Input]::MoveWindow($explorer, [Input]::Width - 330, [Input]::Height - 260, 900, 600, $true) | Out-Null
Start-Sleep -Seconds 2
$ring = StartDrag 0x11
$side = $ring.Right - $ring.Left
Shot 'ring-3-corner.png'
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
Check ($side -gt 0 -and $ring.Left -ge 0 -and $ring.Top -ge 0 -and $ring.Right -le $area.Right -and $ring.Bottom -le $area.Bottom) `
  "near the corner the ring is whole on the screen (ring $($ring.Left),$($ring.Top)-$($ring.Right),$($ring.Bottom); work area $($area.Right)x$($area.Bottom))"
[Input]::Mouse(20, 20, 0); Start-Sleep -Milliseconds 300
[Input]::Mouse(20, 20, 0x0004); [Input]::Key(0x11, $true)
Start-Sleep -Seconds 2

# 5. The keyboard shortcut: select the file, Ctrl+Alt+Z, click Compress.
$at = FileItem
[Input]::Mouse($at[0], $at[1], 0); Start-Sleep -Milliseconds 300
[Input]::Mouse($at[0], $at[1], 0x0002); Start-Sleep -Milliseconds 80
[Input]::Mouse($at[0], $at[1], 0x0004); Start-Sleep -Seconds 1
$before = ([regex]::Matches((Log), 'done: \d+ made')).Count
[Input]::Key(0x11, $false); [Input]::Key(0x12, $false); [Input]::Key(0x5A, $false)
Start-Sleep -Milliseconds 100
[Input]::Key(0x5A, $true); [Input]::Key(0x12, $true); [Input]::Key(0x11, $true)
Start-Sleep -Seconds 4
Shot 'ring-5-shortcut.png'
Check ((Log) -match 'shortcut: 1 files selected') 'Ctrl+Alt+Z takes the file selected in Explorer'
$found = [regex]::Matches((Log), 'ring window at (-?\d+),(-?\d+) size (\d+)x(\d+)')
if ($found.Count -gt 0) {
  $m = $found[$found.Count - 1]
  $side = [int]$m.Groups[3].Value
  $cx = [int]$m.Groups[1].Value + $side / 2; $cy = [int]$m.Groups[2].Value + $side / 2
  $middle = $side * 97 / 300
  [Input]::Mouse($cx, $cy - $middle, 0); Start-Sleep -Milliseconds 300
  [Input]::Mouse($cx, $cy - $middle, 0x0002); Start-Sleep -Milliseconds 80
  [Input]::Mouse($cx, $cy - $middle, 0x0004)
  $made = $false
  foreach ($try in 1..40) {
    if (([regex]::Matches((Log), 'done: 1 made')).Count -gt $before) { $made = $true; break }
    Start-Sleep -Milliseconds 500
  }
  Shot 'ring-5-after.png'
  Check $made 'after Ctrl+Alt+Z, clicking Compress runs it on the selected file'
}
Start-Sleep -Seconds 2

# 4. Control: a plain drag (no key) onto the app's main window. If this does
# not reach the app either, the test's synthetic drag never became a real
# Windows drag, and steps 1-2 say nothing about the ring itself.
$at = FileItem
[Input]::Mouse($at[0], $at[1], 0); Start-Sleep -Milliseconds 300
[Input]::Mouse($at[0], $at[1], 0x0002); Start-Sleep -Milliseconds 200
foreach ($step in 1..20) {
  [Input]::Mouse($at[0] - $step * ($at[0] - 400) / 20, $at[1] - $step * ($at[1] - 300) / 20, 0)
  Start-Sleep -Milliseconds 50
}
Start-Sleep -Milliseconds 600
Shot 'ring-4-plain-drag.png'
[Input]::Mouse(400, 300, 0x0004)
Start-Sleep -Seconds 2
Check ((Log) -match 'files dragged over the main window') 'control: a plain drag reaches the main window'

Set-Content (Join-Path $Out 'ring.log') (Log)
Stop-Process -Id $app.Id -ErrorAction SilentlyContinue
Write-Host (Log)
if ($failures.Count -gt 0) { throw "ring check failed: $($failures -join '; ')" }
Write-Host 'the ring works: it opens, its tools take a drop and a click, and it stays on the screen'
