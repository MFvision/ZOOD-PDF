# The reopen check's hands on Windows (windows.mjs): brings ZOOD's main
# window to the front, presses keys as a person does, takes screenshots, and
# closes the window as its close button does. It keeps running and takes one
# request per line on stdin; it answers each with one line on stdout, "ok ..."
# or "error ...":
#   front            ZOOD's main window to the front; says what is in front
#   keys <chord>     e.g. ctrl+shift+n, esc, enter, ctrl+tab, 4
#   shot <file.png>  the whole screen
#   windows          ZOOD's visible windows
#   close            WM_CLOSE to ZOOD's main window (its close button's message)
#   quit             ends this helper
# ZOOD's main window is the largest visible window of its process.
param([string]$Process = 'warraq-desktop')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Hands {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int how);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint type);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  static HashSet<uint> Pids(string process) {
    var pids = new HashSet<uint>();
    foreach (var p in System.Diagnostics.Process.GetProcessesByName(process)) pids.Add((uint)p.Id);
    return pids;
  }

  public static string Describe(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return "(none)";
    var cls = new StringBuilder(128); GetClassNameW(hwnd, cls, 128);
    var text = new StringBuilder(256); GetWindowTextW(hwnd, text, 256);
    RECT r; GetWindowRect(hwnd, out r);
    return "'" + text + "' [" + cls + "] " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + " at " + r.Left + "," + r.Top;
  }

  // The largest visible top-level window of the process; every one in `seen`.
  public static IntPtr Main(string process, List<string> seen) {
    var pids = Pids(process);
    IntPtr best = IntPtr.Zero; long area = -1;
    EnumWindows((hwnd, data) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pids.Contains(pid) && IsWindowVisible(hwnd)) {
        RECT r; GetWindowRect(hwnd, out r);
        long size = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
        if (seen != null) seen.Add(Describe(hwnd));
        if (size > area) { area = size; best = hwnd; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static string Windows(string process) {
    var seen = new List<string>();
    Main(process, seen);
    return seen.Count == 0 ? "no visible ZOOD window" : string.Join(" | ", seen);
  }

  public static string Front(string process) {
    IntPtr main = Main(process, null);
    if (main == IntPtr.Zero) return "no visible ZOOD window";
    if (GetForegroundWindow() != main) {
      if (IsIconic(main)) ShowWindow(main, 9);
      // A tap of Alt lets this process hand the foreground over.
      Key(0x12, false); Key(0x12, true);
      SetForegroundWindow(main);
      Thread.Sleep(400);
    }
    IntPtr now = GetForegroundWindow();
    return (now == main ? "ZOOD in front: " : "NOT ZOOD in front: ") + Describe(now);
  }

  static bool Extended(uint vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E; }

  static void Key(uint vk, bool up) {
    keybd_event((byte)vk, (byte)MapVirtualKeyW(vk, 0), (up ? 2u : 0u) | (Extended(vk) ? 1u : 0u), UIntPtr.Zero);
  }

  static uint Vk(string name) {
    switch (name) {
      case "ctrl": return 0x11;
      case "shift": return 0x10;
      case "alt": return 0x12;
      case "esc": return 0x1B;
      case "enter": return 0x0D;
      case "tab": return 0x09;
      case "pagedown": return 0x22;
      case "pageup": return 0x21;
      case "home": return 0x24;
      case "end": return 0x23;
    }
    if (name.Length == 1) {
      char c = char.ToUpperInvariant(name[0]);
      if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z')) return c;
    }
    throw new ArgumentException("no key called '" + name + "'");
  }

  // "ctrl+shift+n": the keys down in order, then up in reverse.
  public static void Chord(string chord) {
    var keys = new List<uint>();
    foreach (var name in chord.ToLowerInvariant().Split('+')) keys.Add(Vk(name.Trim()));
    foreach (var vk in keys) { Key(vk, false); Thread.Sleep(30); }
    for (int i = keys.Count - 1; i >= 0; i--) { Key(keys[i], true); Thread.Sleep(30); }
  }

  public static string Close(string process) {
    IntPtr main = Main(process, null);
    if (main == IntPtr.Zero) return "no visible ZOOD window to close";
    PostMessageW(main, 0x0010, IntPtr.Zero, IntPtr.Zero);
    return "WM_CLOSE sent to " + Describe(main) + " at " + DateTime.Now.ToString("HH:mm:ss.fff");
  }
}
'@
[Hands]::SetProcessDPIAware() | Out-Null

function Shot([string]$file) {
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size)
  $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
  return "$($screen.Width)x$($screen.Height)"
}

[Console]::Out.WriteLine('ok ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $verb, $rest = $line.Trim().Split(' ', 2)
  try {
    $answer = switch ($verb) {
      'front' { [Hands]::Front($Process) }
      'keys' { [Hands]::Chord($rest); 'pressed' }
      'shot' { Shot $rest }
      'windows' { [Hands]::Windows($Process) }
      'close' { [Hands]::Close($Process) }
      'quit' { exit 0 }
      default { throw "no request called '$verb'" }
    }
    [Console]::Out.WriteLine("ok $(([string]$answer) -replace '\s*[\r\n]+\s*', ' | ')")
  } catch {
    [Console]::Out.WriteLine("error $(($_.Exception.Message) -replace '\s*[\r\n]+\s*', ' | ')")
  }
  [Console]::Out.Flush()
}
