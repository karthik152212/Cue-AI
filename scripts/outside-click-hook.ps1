# Outside-click hook for Cue passive answer window.
# WH_MOUSE_LL observes mouse-down events. Classification via GetWindowRect + point-in-rect.
# C# does marshalling + per-click diagnostic logging to stderr.
# PowerShell writes "outside-click" to stdout after the message loop exits.
#
# Usage: powershell -ExecutionPolicy Bypass -File outside-click-hook.ps1 <hwnd>

param([string]$TargetHwnd)

$hwnd = [IntPtr]::Zero
try { $hwnd = [IntPtr][long]$TargetHwnd } catch {}

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class HookHelper {
    [DllImport("user32.dll")]
    static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")]
    static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")]
    static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    static extern bool PostQuitMessage(int nExitCode);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MSLL { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
    public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    const int WH_MOUSE_LL = 14;
    const int WM_LBUTTONDOWN = 0x0201;
    static IntPtr s_hwnd;
    static IntPtr s_hook;

    public static bool OutsideDetected;
    public static int ClickCount;

    static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && wParam == (IntPtr)WM_LBUTTONDOWN && !OutsideDetected) {
            ClickCount++;
            try {
                var msll = (MSLL)Marshal.PtrToStructure(lParam, typeof(MSLL));
                RECT rect;
                if (GetWindowRect(s_hwnd, out rect)) {
                    int x = msll.pt.X, y = msll.pt.Y;
                    bool inside = x >= rect.Left && x < rect.Right && y >= rect.Top && y < rect.Bottom;
                    // Diagnostic: write to temp file (most reliable)
                    string logPath = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "cue-hook-clicks.log");
                    string entry = "CLICK #" + ClickCount +
                        " mouse=" + x + "," + y +
                        " rect=" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom +
                        " => " + (inside ? "INSIDE" : "OUTSIDE");
                    System.IO.File.AppendAllText(logPath, entry + System.Environment.NewLine);
                    if (!inside) {
                        OutsideDetected = true;
                        System.IO.File.AppendAllText(logPath, "DISMISS_EMIT" + System.Environment.NewLine);
                        PostQuitMessage(0);
                    } else {
                        System.IO.File.AppendAllText(logPath, "NO_DISMISS" + System.Environment.NewLine);
                    }
                }
            } catch {
                Console.Error.WriteLine("CLICK #" + ClickCount + " => UNKNOWN (parse error)");
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    public static bool Run(IntPtr targetHwnd) {
        OutsideDetected = false;
        ClickCount = 0;
        s_hwnd = targetHwnd;
        IntPtr hMod = GetModuleHandle(null);
        s_hook = SetWindowsHookEx(WH_MOUSE_LL, Callback, hMod, 0);
        if (s_hook == IntPtr.Zero) {
            string logPath = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "cue-hook-clicks.log");
        System.IO.File.AppendAllText(logPath, "HOOK_ERROR: SetWindowsHookEx failed" + System.Environment.NewLine);
            return false;
        }
        RECT rect;
        if (GetWindowRect(s_hwnd, out rect)) {
            string logPath2 = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "cue-hook-clicks.log");
            System.IO.File.AppendAllText(logPath2, "READY hwnd=" + s_hwnd +
                " rect=" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom + System.Environment.NewLine);
        }
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0)) {}
        if (s_hook != IntPtr.Zero) UnhookWindowsHookEx(s_hook);
        return OutsideDetected;
    }
}
"@

# Run the hook synchronously. C# logs each click to stderr in real-time.
# After the message loop exits (outside click or process kill), check the flag.
$dismissed = [HookHelper]::Run($hwnd)

# Write result to stdout via Write-Host (only runs after message loop exits).
if ($dismissed) {
    Write-Host "outside-click"
}
