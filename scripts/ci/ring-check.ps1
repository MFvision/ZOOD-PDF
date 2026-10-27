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
#   4. (a control) drags the file plainly onto the app's main window;
#   6. drags a shortcut to the file plainly to the top of the screen and lets
#      go on the drop zone there: it takes the shortcut as the PDF;
#   7. drags two copied shortcuts to Arabic-named PDFs there at once: the
#      shelf takes both PDFs;
#   8. drags the PDF itself up and lets go on a tile: what it makes lands
#      beside the original;
#   9. drags a shortcut whose PDF was since tidied into a folder (as Put away
#      does): it is found there and taken; then one whose PDF was deleted:
#      the zone names the missing file.
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

function FileItem($called = 'sample') {
  ExplorerToFront
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  # Explorer hides known extensions, so the item may be named either way.
  $name = [System.Windows.Automation.AutomationElement]::NameProperty
  $named = New-Object System.Windows.Automation.OrCondition `
    (New-Object System.Windows.Automation.PropertyCondition $name, "$called.pdf"),
    (New-Object System.Windows.Automation.PropertyCondition $name, $called)
  foreach ($try in 1..10) {
    $item = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $named)
    if ($item) {
      # A long folder hides items below the fold: bring it into view first.
      try {
        $item.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView()
        Start-Sleep -Milliseconds 500
      } catch { }
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
$quickTitle = 'أدوات PDF السريعة — محرر زود PDF'
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
# Named either way: "sample-compressed.pdf", or "sample (compressed).pdf" by
# Settings › Quick tools' default pattern.
function ResultAppears($word) {
  foreach ($try in 1..40) {
    if ((Test-Path (Join-Path $folder "sample-$word.pdf")) -or (Test-Path (Join-Path $folder "sample ($word).pdf"))) { return $true }
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
  $middle = $side * 97 / 420   # between the hub and the outer edge
  DragTo $cx ($cy - $middle)
  Shot 'ring-1-over-compress.png'
  [Input]::Mouse($cx, $cy - $middle, 0x0004); [Input]::Key(0x11, $true)
  Start-Sleep -Seconds 3
  Shot 'ring-1-running.png'
  Check (ResultAppears 'compressed') 'letting go on Compress makes the compressed file at once'
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
  $middle = $side * 97 / 420
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
  Check (ResultAppears 'rotated') 'clicking Rotate makes the rotated file'
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
# The file is still selected from the drags; a click on it now would start a rename.
ExplorerToFront
$before = ([regex]::Matches((Log), 'done: \d+ made')).Count
[Input]::Key(0x11, $false); [Input]::Key(0x12, $false); [Input]::Key(0x5A, $false)
Start-Sleep -Milliseconds 100
[Input]::Key(0x5A, $true); [Input]::Key(0x12, $true); [Input]::Key(0x11, $true)
# Reading Explorer's selection starts PowerShell, slow on a fresh runner.
foreach ($try in 1..30) {
  if ((Log) -match 'shortcut: \d+ files selected') { break }
  Start-Sleep -Milliseconds 500
}
Start-Sleep -Seconds 2
Shot 'ring-5-shortcut.png'
Check ((Log) -match 'shortcut: 1 files selected') 'Ctrl+Alt+Z takes the file selected in Explorer'
$found = [regex]::Matches((Log), 'ring window at (-?\d+),(-?\d+) size (\d+)x(\d+)')
if ($found.Count -gt 0) {
  $m = $found[$found.Count - 1]
  $side = [int]$m.Groups[3].Value
  $cx = [int]$m.Groups[1].Value + $side / 2; $cy = [int]$m.Groups[2].Value + $side / 2
  $middle = $side * 97 / 420
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

# 6. The drop zone: a plain drag of a shortcut to the PDF (as on a desktop)
# to the top middle of the screen, let go on "Drop here to sort".
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $folder 'sample-link.lnk'))
$link.TargetPath = (Join-Path $folder 'sample.pdf')
$link.Save()
# Explorer back on the screen (step 3 pushed it into the corner), lower
# down, so the drag starts on the shortcut and has room to reach the top.
$explorer = [Input]::FindWindow('CabinetWClass', [NullString]::Value)
[Input]::MoveWindow($explorer, 200, 300, 760, 400, $true) | Out-Null
Start-Sleep -Seconds 2
$at = FileItem 'sample-link'
$zx = [int]([Input]::Width / 2); $zy = 70
[Input]::Mouse($at[0], $at[1], 0); Start-Sleep -Milliseconds 300
[Input]::Mouse($at[0], $at[1], 0x0002); Start-Sleep -Milliseconds 200
foreach ($step in 1..30) {
  [Input]::Mouse($at[0] + $step * ($zx - $at[0]) / 30, $at[1] + $step * ($zy - $at[1]) / 30, 0)
  Start-Sleep -Milliseconds 50
}
# A few small moves over the zone, so its drop target follows.
foreach ($step in 1..10) { [Input]::Mouse($zx + 10 - $step, $zy, 0); Start-Sleep -Milliseconds 60 }
Start-Sleep -Milliseconds 600
Shot 'zone-6-over.png'
[Input]::Mouse($zx, $zy, 0x0004)
Start-Sleep -Seconds 3
Shot 'zone-6-after.png'
Check ((Log) -match 'the drop zone peeks') 'a plain drag to the top brings the drop zone'
Check ((Log) -match '1 files dropped on the drop zone') 'a shortcut let go on the drop zone is taken as its PDF'

# 7. As on a real desktop: two shortcuts to PDFs with Arabic names, made in
# another folder and copied here (so the path each keeps relative to itself
# leads nowhere), picked together and dragged up onto the shelf at once.
try {
  $arabic = Join-Path $folder 'arabic'
  New-Item -ItemType Directory -Force -Path $arabic | Out-Null
  # Each shortcut made the way Explorer makes one (right-click > Create
  # shortcut, the Shell's "link" verb), beside its PDF, then copied here: the
  # path it keeps relative to itself now leads nowhere, as on a real desktop.
  $shellApp = New-Object -ComObject Shell.Application
  foreach ($n in 'a', 'b') {
    $name = (-join [char[]](0x622, 0x641, 0x627, 0x20, 0x622, 0x64A)) + " $n.pdf"
    Copy-Item $Sample (Join-Path $arabic $name)
    $before = @(Get-ChildItem $arabic -Filter '*.lnk').Count
    try { $shellApp.Namespace($arabic).ParseName($name).InvokeVerb('link') } catch { Write-Host "link verb: $_" }
    foreach ($try in 1..20) {
      if (@(Get-ChildItem $arabic -Filter '*.lnk').Count -gt $before) { break }
      Start-Sleep -Milliseconds 500
    }
    $lnk = Get-ChildItem $arabic -Filter '*.lnk' | Sort-Object LastWriteTime | Select-Object -Last 1
    if ($lnk) { Copy-Item $lnk.FullName (Join-Path $folder "arabic-$n - Copy.lnk") }
    else { Write-Host "no shortcut was made for $n" }
  }
  # Taller, so both new shortcuts are in sight below what earlier steps made
  # (Explorer only lists the rows it shows).
  $explorer = [Input]::FindWindow('CabinetWClass', [NullString]::Value)
  [Input]::MoveWindow($explorer, 200, 150, 760, 560, $true) | Out-Null
  Start-Sleep -Seconds 3
  $a = FileItem 'arabic-a - Copy'
  $b = FileItem 'arabic-b - Copy'
  [Input]::Mouse($a[0], $a[1], 0); [Input]::Mouse($a[0], $a[1], 0x0002); [Input]::Mouse($a[0], $a[1], 0x0004)
  Start-Sleep -Milliseconds 300
  [Input]::Key(0x11, $false)
  [Input]::Mouse($b[0], $b[1], 0); [Input]::Mouse($b[0], $b[1], 0x0002); [Input]::Mouse($b[0], $b[1], 0x0004)
  [Input]::Key(0x11, $true)
  Start-Sleep -Milliseconds 500
  [Input]::Mouse($b[0], $b[1], 0x0002); Start-Sleep -Milliseconds 200
  foreach ($step in 1..30) {
    [Input]::Mouse($b[0] + $step * ($zx - $b[0]) / 30, $b[1] + $step * ($zy - $b[1]) / 30, 0)
    Start-Sleep -Milliseconds 50
  }
  foreach ($step in 1..10) { [Input]::Mouse($zx + 10 - $step, $zy, 0); Start-Sleep -Milliseconds 60 }
  Start-Sleep -Milliseconds 600
  Shot 'zone-7-over.png'
  [Input]::Mouse($zx, $zy, 0x0004)
  Start-Sleep -Seconds 3
  Shot 'zone-7-after.png'
  Check ((Log) -match '2 files dropped on the drop zone') 'two copied shortcuts to Arabic-named PDFs are both taken'
  Check ((Log) -notmatch 'dropped not taken') 'no dropped shortcut is left out'
} catch {
  Check $false "the Arabic shortcut step ran ($_)"
}

# 8. Let go on a tile (after "Stow"): the PDF itself dragged up and let go
# off centre, on the tile there (Send with the panel left to right, Web
# right to left). What the tile makes lands beside the original.
try {
  # First the shelf folds away, so the next drag opens the tiles again.
  [Input]::Mouse(400, 600, 0)
  Start-Sleep -Seconds 5
  $arabic = Join-Path $folder 'arabic'
  $t0 = Get-Date
  $at = FileItem 'sample'
  $tx = $zx + 80
  [Input]::Mouse($at[0], $at[1], 0); Start-Sleep -Milliseconds 300
  [Input]::Mouse($at[0], $at[1], 0x0002); Start-Sleep -Milliseconds 200
  foreach ($step in 1..30) {
    [Input]::Mouse($at[0] + $step * ($tx - $at[0]) / 30, $at[1] + $step * ($zy - $at[1]) / 30, 0)
    Start-Sleep -Milliseconds 50
  }
  foreach ($step in 1..10) { [Input]::Mouse($tx + 10 - $step, $zy, 0); Start-Sleep -Milliseconds 60 }
  Start-Sleep -Milliseconds 600
  Shot 'zone-8-tile.png'
  [Input]::Mouse($tx, $zy, 0x0004)
  $made = @()
  foreach ($try in 1..30) {
    Start-Sleep -Seconds 1
    $made = @(Get-ChildItem $folder -Recurse -File | Where-Object { $_.LastWriteTime -gt $t0 -and $_.Extension -ne '.lnk' -and $_.FullName -notlike "$arabic*" })
    if ($made.Count -gt 0) { break }
  }
  Shot 'zone-8-note.png'
  Write-Host "made by the tile: $($made.FullName -join ', ')"
  Check ((Log) -match 'dropped on the \w+ tile') 'letting go on a tile runs it'
  Check ($made.Count -gt 0) 'what the tile makes lands beside the original'
  Check ((Log) -match 'a tile made [1-9]') 'what the tile made is kept for Undo and Show'
} catch {
  Check $false "the tile step ran ($_)"
}

# 9. A shortcut whose PDF was moved into a folder below where it was (as
# Put away tidies a desktop) is followed there; one whose PDF was deleted
# is named, not taken.
try {
  [Input]::Mouse(400, 600, 0)
  Start-Sleep -Seconds 5
  $moving = Join-Path $folder 'moving'
  New-Item -ItemType Directory -Force -Path $moving | Out-Null
  $shellApp = New-Object -ComObject Shell.Application
  foreach ($n in 'moved', 'deleted') {
    $name = (-join [char[]](0x645, 0x644, 0x641)) + " $n.pdf"
    Copy-Item $Sample (Join-Path $moving $name)
    $before = @(Get-ChildItem $moving -Filter '*.lnk').Count
    try { $shellApp.Namespace($moving).ParseName($name).InvokeVerb('link') } catch { Write-Host "link verb: $_" }
    foreach ($try in 1..20) {
      if (@(Get-ChildItem $moving -Filter '*.lnk').Count -gt $before) { break }
      Start-Sleep -Milliseconds 500
    }
    $lnk = Get-ChildItem $moving -Filter '*.lnk' | Sort-Object LastWriteTime | Select-Object -Last 1
    if ($lnk) { Copy-Item $lnk.FullName (Join-Path $folder "$n - Copy.lnk") } else { Write-Host "no shortcut was made for $n" }
  }
  $tidied = Join-Path $moving 'PDFs'
  New-Item -ItemType Directory -Force -Path $tidied | Out-Null
  Move-Item (Join-Path $moving ((-join [char[]](0x645, 0x644, 0x641)) + ' moved.pdf')) $tidied
  Remove-Item (Join-Path $moving ((-join [char[]](0x645, 0x644, 0x641)) + ' deleted.pdf'))
  Start-Sleep -Seconds 3
  # The deleted one first: the moved one lands on the Web tile, whose browser
  # window would then cover File Explorer.
  foreach ($n in 'deleted', 'moved') {
    $seen = (Log).Length
    $at = FileItem "$n - Copy"
    [Input]::Mouse($at[0], $at[1], 0); Start-Sleep -Milliseconds 300
    [Input]::Mouse($at[0], $at[1], 0x0002); Start-Sleep -Milliseconds 200
    foreach ($step in 1..30) {
      [Input]::Mouse($at[0] + $step * ($zx - $at[0]) / 30, $at[1] + $step * ($zy - $at[1]) / 30, 0)
      Start-Sleep -Milliseconds 50
    }
    foreach ($step in 1..10) { [Input]::Mouse($zx + 10 - $step, $zy, 0); Start-Sleep -Milliseconds 60 }
    Start-Sleep -Milliseconds 800
    Shot "zone-9-$n-over.png"
    [Input]::Mouse($zx, $zy, 0x0004)
    Start-Sleep -Seconds 3
    Shot "zone-9-$n-after.png"
    $new = (Log).Substring([Math]::Min($seen, (Log).Length))
    Write-Host "log for the $n shortcut: $new"
    if ($n -eq 'moved') {
      Check ($new -match '1 files dropped on the drop zone') 'a shortcut whose PDF was tidied into a folder is followed there'
    } else {
      Check ($new -match 'a shortcut leads nowhere: .*deleted - Copy\.lnk \(made for .*deleted\.pdf\)') 'a shortcut whose PDF was deleted names the file it was made for'
    }
    [Input]::Mouse(400, 600, 0)
    Start-Sleep -Seconds 5
  }
} catch {
  Check $false "the moved shortcut step ran ($_)"
}

Set-Content (Join-Path $Out 'ring.log') (Log)
Get-Process -Name warraq-desktop -ErrorAction SilentlyContinue | Stop-Process -ErrorAction SilentlyContinue
Write-Host (Log)
if ($failures.Count -gt 0) { throw "ring check failed: $($failures -join '; ')" }
Write-Host 'the ring works: it opens, its tools take a drop and a click, and it stays on the screen; the drop zone takes a drop'
