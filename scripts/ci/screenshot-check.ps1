# Can a person still take a screenshot while ZOOD runs (CI)? Tried first
# with no ZOOD, then with ZOOD running as people run it (ring, drop zone with
# a file on the shelf, Ask ZOOD's taps and glow, the bubble), each way:
#   - the Print Screen key: a picture lands on the clipboard;
#   - Print Screen and Win+Shift+S with a rectangle dragged with the mouse
#     on the Snipping Tool's screen clip;
#   - whether anything holds the clipboard open, and who;
#   - whether the Print Screen key is taken by a program's hotkey;
#   - ZOOD's windows on the screen, and what is in front after each try.
# Everything goes to $Out/shots.txt. Exits non-zero when a screenshot that
# works without ZOOD does not work with it.
param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Sample = 'tests/fixtures/layers/layers.pdf'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Shots {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern bool IsClipboardFormatAvailable(uint format);
  [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
  [DllImport("user32.dll")] public static extern bool EmptyClipboard();
  [DllImport("user32.dll")] public static extern IntPtr GetOpenClipboardWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hwnd, int id, uint mods, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hwnd, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static void Down(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void Up(byte vk) { keybd_event(vk, 0, 2, UIntPtr.Zero); }
  public static void Tap(byte vk) { Down(vk); Up(vk); }

  public static string Describe(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return "(none)";
    var cls = new StringBuilder(128); GetClassNameW(hwnd, cls, 128);
    var text = new StringBuilder(128); GetWindowTextW(hwnd, text, 128);
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    string name = "?";
    try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
    return name + " [" + cls + "] '" + text + "'";
  }

  // Tries to open the clipboard every 10 ms for `ms`: how often it was held
  // by someone else, and by whom.
  public static string Probe(int ms) {
    int tries = 0, held = 0; var by = new Dictionary<string, int>();
    var until = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < until) {
      tries++;
      if (OpenClipboard(IntPtr.Zero)) { CloseClipboard(); }
      else {
        held++;
        string who = Describe(GetOpenClipboardWindow());
        by[who] = by.ContainsKey(who) ? by[who] + 1 : 1;
      }
      System.Threading.Thread.Sleep(10);
    }
    var sb = new StringBuilder();
    sb.Append(held + " of " + tries + " tries found the clipboard held");
    foreach (var kv in by) sb.Append("; " + kv.Key + " x" + kv.Value);
    return sb.ToString();
  }

  public static bool Empty() {
    for (int i = 0; i < 50; i++) {
      if (OpenClipboard(IntPtr.Zero)) { EmptyClipboard(); CloseClipboard(); return true; }
      System.Threading.Thread.Sleep(20);
    }
    return false;
  }

  // CF_BITMAP, CF_DIB or CF_DIBV5: a picture is on the clipboard.
  public static bool HasPicture() {
    return IsClipboardFormatAvailable(2) || IsClipboardFormatAvailable(8) || IsClipboardFormatAvailable(17);
  }

  public static List<string> WindowsOf(HashSet<int> pids) {
    var list = new List<string>();
    EnumWindows((hwnd, data) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pids.Contains((int)pid) && IsWindowVisible(hwnd)) {
        RECT r; GetWindowRect(hwnd, out r);
        long ex = GetWindowLongPtrW(hwnd, -20).ToInt64();
        list.Add(Describe(hwnd) + " at " + r.Left + "," + r.Top + " " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) +
          ((ex & 0x8) != 0 ? " topmost" : "") + ((ex & 0x20) != 0 ? " click-through" : "") +
          ((ex & 0x80000) != 0 ? " layered" : "") + ((ex & 0x8000000) != 0 ? " no-activate" : ""));
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
[Shots]::SetProcessDPIAware() | Out-Null
$lines = New-Object System.Collections.Generic.List[string]
function Say($text) { Write-Host $text; $lines.Add($text) }

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Say "screen: $($screen.Width)x$($screen.Height); Windows $([Environment]::OSVersion.Version)"

function Shot($name) {
  $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size)
  $bitmap.Save((Join-Path $Out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}

# One way of taking a screenshot: the clipboard emptied, `$take` run, and
# up to 8 seconds to see a picture arrive.
function Try-Shot($label, [scriptblock]$take) {
  [Shots]::Empty() | Out-Null
  $before = [Shots]::GetClipboardSequenceNumber()
  & $take
  $got = $false
  foreach ($n in 1..40) {
    Start-Sleep -Milliseconds 200
    if ([Shots]::HasPicture()) { $got = $true; break }
  }
  $after = [Shots]::GetClipboardSequenceNumber()
  Say ("  {0}: {1} (clipboard changed {2} times); in front after: {3}" -f $label,
    $(if ($got) { 'PICTURE ON THE CLIPBOARD' } else { 'NO PICTURE' }), ($after - $before),
    [Shots]::Describe([Shots]::GetForegroundWindow()))
  # Whatever the try left open (the snip overlay, the Snipping Tool) goes.
  [Shots]::Tap(0x1B); Start-Sleep -Milliseconds 400
  return $got
}

function Drag-Rectangle {
  $x = [int]($screen.Width * 0.3); $y = [int]($screen.Height * 0.3)
  [Shots]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 150
  [Shots]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
  foreach ($step in 1..20) {
    [Shots]::SetCursorPos($x + 15 * $step, $y + 10 * $step) | Out-Null
    Start-Sleep -Milliseconds 25
  }
  [Shots]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
}

function Round($phase, $pids) {
  Say ""
  Say "== $phase =="
  if ($pids) {
    Say "  ZOOD's windows on the screen:"
    foreach ($w in [Shots]::WindowsOf($pids)) { Say "    $w" }
  }
  Say ("  clipboard over 5 s: " + [Shots]::Probe(5000))
  $free = [Shots]::RegisterHotKey([IntPtr]::Zero, 7001, 0, 0x2C)
  if ($free) { [Shots]::UnregisterHotKey([IntPtr]::Zero, 7001) | Out-Null }
  Say ("  Print Screen as a program's hotkey: " + $(if ($free) { 'free' } else { 'TAKEN by another program' }))
  $result = [ordered]@{}
  $result.printScreen = Try-Shot 'Print Screen' { [Shots]::Tap(0x2C) }
  $result.altPrintScreen = Try-Shot 'Alt+Print Screen' { [Shots]::Down(0x12); [Shots]::Tap(0x2C); [Shots]::Up(0x12) }
  # Print Screen opens the Snipping Tool's screen clip where Windows has it:
  # a rectangle is then dragged, as people do.
  $result.printScreenDrag = Try-Shot 'Print Screen, then a rectangle dragged' {
    [Shots]::Tap(0x2C)
    Start-Sleep -Milliseconds 2500
    Drag-Rectangle
  }
  $result.winShiftS = Try-Shot 'Win+Shift+S, then a rectangle dragged' {
    [Shots]::Down(0x5B); [Shots]::Down(0x10); [Shots]::Tap(0x53); [Shots]::Up(0x10); [Shots]::Up(0x5B)
    Start-Sleep -Milliseconds 2500
    Drag-Rectangle
  }
  $result.winShiftSShiftHeld = Try-Shot 'Win+Shift+S, then a rectangle dragged with Shift still down' {
    [Shots]::Down(0x5B); [Shots]::Down(0x10); [Shots]::Tap(0x53); [Shots]::Up(0x5B)
    Start-Sleep -Milliseconds 2500
    Drag-Rectangle
    [Shots]::Up(0x10)
  }
  Shot ("shot-$phase.png")
  return $result
}

Get-Process warraq-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$without = Round 'without ZOOD' $null

# ZOOD as people run it, with a file waiting on the shelf.
$data = Join-Path $env:APPDATA 'app.warraq.desktop'
New-Item -ItemType Directory -Force -Path $data | Out-Null
'{"ring":true,"background":true,"scale":1,"shortcut":"Ctrl+Alt+Z","dragKey":"any","dropZone":true}' |
  Set-Content -Encoding utf8 (Join-Path $data 'quick-tools.json')
'{"enabled":true,"shortcut":"","sees":false,"taps":true,"tap_key":"right-main","tap_to_type":true,"tap_speaks":true,"glow":true}' |
  Set-Content -Encoding utf8 (Join-Path $data 'ask.json')
'{"bubble":true,"lang":"en"}' | Set-Content -Encoding utf8 (Join-Path $data 'presence.json')
$held = (Resolve-Path $Sample).Path
ConvertTo-Json -Compress @(@{ path = $held; made = $false }) | Set-Content -Encoding utf8 (Join-Path $data 'shelf.json')
Start-Process -FilePath $App | Out-Null
Start-Sleep -Seconds 25
$pids = New-Object System.Collections.Generic.HashSet[int]
$root = (Get-Process warraq-desktop -ErrorAction SilentlyContinue | Select-Object -First 1).Id
if (-not $root) { throw 'the app did not start' }
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
[void]$pids.Add([int]$root)
do {
  $grew = $false
  foreach ($p in $all) {
    if ($pids.Contains([int]$p.ParentProcessId) -and $pids.Add([int]$p.ProcessId)) { $grew = $true }
  }
} while ($grew)
$with = Round 'with ZOOD' $pids

$stalls = Join-Path $data 'stall.log'
if (Test-Path $stalls) { Say ""; Say "stall.log:"; Say (Get-Content $stalls -Raw) }
Get-Process warraq-desktop -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$broken = @($without.Keys | Where-Object { $without[$_] -and -not $with[$_] })
Say ""
if ($broken.Count) { Say ("BROKEN BY ZOOD: " + ($broken -join ', ')) } else { Say 'every way that works without ZOOD works with it' }
$lines | Set-Content (Join-Path $Out 'shots.txt')
if ($broken.Count) { exit 1 }
