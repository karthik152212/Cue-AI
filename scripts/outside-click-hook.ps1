# Outside-click hook for Cue passive answer window.
# Uses WH_MOUSE_LL to observe (not consume) mouse-down events outside the
# answer window HWND.  When detected, writes "outside-click" to stdout and
# exits cleanly.  The original click continues normally to the underlying
# application.
#
# Classification uses GetWindowRect + point-in-rect.
# ALL marshalling is done inside compiled C# — the PowerShell callback
# never calls Marshal.PtrToStructure directly.
#
# Usage: powershell -ExecutionPolicy Bypass -File outside-click-hook.ps1 <hwnd>
# Communication: stdout lines read by parent process via readline interface.

param([string]$TargetHwnd)

$hwnd = [IntPtr]::Zero
try { $hwnd = [IntPtr][long]$TargetHwnd } catch {}

$hook = [IntPtr]::Zero
$script:dismissed = $false

# ──────────────────────────────────────────────────────────────────────
# C# helper class: ALL marshalling + classification lives here.
# The PowerShell callback only calls HookHelper.ClassifyClick() which
# returns a bool.  No Marshal calls ever happen in PowerShell-land.
# ──────────────────────────────────────────────────────────────────────
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
    static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    const int WH_MOUSE_LL = 14;
    const int WM_LBUTTONDOWN = 0x0201;

    static IntPtr s_hwnd;
    static IntPtr s_hook;
    static bool s_dismissed;

    // ── Classification: returns true if click is OUTSIDE the target rect ──
    // All marshalling happens here in compiled C#, never in PowerShell.
    static bool ClassifyClick(IntPtr lParam) {
        try {
            var msll = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            RECT rect;
            if (!GetWindowRect(s_hwnd, out rect)) return false; // can't determine → treat as inside
            int x = msll.pt.X, y = msll.pt.Y;
            return !(x >= rect.Left && x < rect.Right && y >= rect.Top && y < rect.Bottom);
        } catch {
            return false; // parse failure → treat as inside (UNKNOWN, never OUTSIDE)
        }
    }

    // ── Hook callback: only called for WM_LBUTTONDOWN ──
    static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && wParam == (IntPtr)WM_LBUTTONDOWN && !s_dismissed) {
            if (ClassifyClick(lParam)) {
                s_dismissed = true;
                Console.Write("outside-click");
                PostQuitMessage(0);
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    // ── Public entry point called from PowerShell ──
    public static void InstallAndRun(IntPtr targetHwnd) {
        s_hwnd = targetHwnd;
        s_dismissed = false;

        IntPtr hMod = GetModuleHandle(null);
        s_hook = SetWindowsHookEx(WH_MOUSE_LL, Callback, hMod, 0);
        if (s_hook == IntPtr.Zero) {
            int err = Marshal.GetLastWin32Error();
            Console.Write("hook-error");
            Console.Error.WriteLine("SetWindowsHookEx failed, Win32 error=" + err);
            return;
        }

        // Log target rect for verification
        RECT rect;
        if (GetWindowRect(s_hwnd, out rect))
            Console.WriteLine("target-hwnd=" + s_hwnd + " rect=" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom);

        // Message loop
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0)) {}

        // Cleanup
        if (s_hook != IntPtr.Zero) UnhookWindowsHookEx(s_hook);
    }
}
"@

# Run the hook — all work happens inside C#.
# PowerShell never touches Marshal.PtrToStructure.
[HookHelper]::InstallAndRun($hwnd)
