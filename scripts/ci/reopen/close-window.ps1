# Closes ZOOD's main window as its close button does: WM_CLOSE to the
# largest visible window of the app's process. Lists every visible ZOOD
# window first. With -WaitFor, everything is made ready first and the
# message goes the moment that file appears (to close at once after a page
# turn, before the app's 0.7 s save).
param(
  [string]$Process = 'warraq-desktop',
  [string]$WaitFor = ''
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ZoodWindows {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static List<string> Lines = new List<string>();

  // The largest visible top-level window of these processes, every one listed in Lines.
  public static IntPtr Main(HashSet<int> pids) {
    IntPtr best = IntPtr.Zero; long area = -1;
    Lines.Clear();
    EnumWindows((hwnd, data) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pids.Contains((int)pid) && IsWindowVisible(hwnd)) {
        RECT r; GetWindowRect(hwnd, out r);
        long size = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
        var cls = new StringBuilder(128); GetClassNameW(hwnd, cls, 128);
        var text = new StringBuilder(256); GetWindowTextW(hwnd, text, 256);
        Lines.Add("window '" + text + "' [" + cls + "] " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top));
        if (size > area) { area = size; best = hwnd; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@
$pids = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($p in @(Get-Process -Name $Process -ErrorAction SilentlyContinue)) { [void]$pids.Add($p.Id) }
if ($pids.Count -eq 0) { Write-Output 'ZOOD is not running'; exit 0 }
$main = [ZoodWindows]::Main($pids)
if ($WaitFor) {
  $until = (Get-Date).AddSeconds(60)
  while (-not (Test-Path $WaitFor) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 15 }
}
foreach ($line in [ZoodWindows]::Lines) { Write-Output $line }
if ($main -eq [IntPtr]::Zero) { Write-Output 'no visible ZOOD window to close'; exit 0 }
[void][ZoodWindows]::PostMessageW($main, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output ('sent WM_CLOSE to the largest one at ' + (Get-Date -Format 'HH:mm:ss.fff'))
