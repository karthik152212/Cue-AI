# Outside-click hook for Cue passive answer window.
# WH_MOUSE_LL observes mouse-down events.
# Classification uses Electron-provided bounds (DIP→physical) instead of
# GetWindowRect, because Chromium transparent HWNDs return compositor rects.
#
# Usage: powershell -ExecutionPolicy Bypass -File outside-click-hook.ps1 <hwnd> <bounds-file>

param(
    [string]$TargetHwnd,
    [string]$BoundsFile
)

$hwnd = [IntPtr]::Zero
try { $hwnd = [IntPtr][long]$TargetHwnd } catch {}

# Parse Electron bounds from temp file (avoids PowerShell interpreting negative coords as flags)
$rectLeft = 0; $rectTop = 0; $rectRight = 0; $rectBottom = 0
$boundsPath = Join-Path $env:TEMP $BoundsFile
if ($BoundsFile -and (Test-Path $boundsPath)) {
    $raw = (Get-Content $boundsPath -Raw).Trim()
    $parts = $raw.Split(',')
    if ($parts.Length -ge 5) {
        $dipX = [double]$parts[0]
        $dipY = [double]$parts[1]
        $dipW = [double]$parts[2]
        $dipH = [double]$parts[3]
        $sc   = [double]$parts[4]
        if ($sc -le 0) { $sc = 1.0 }
        $rectLeft   = [int]([math]::Round($dipX * $sc))
        $rectTop    = [int]([math]::Round($dipY * $sc))
        $rectRight  = [int]([math]::Round(($dipX + $dipW) * $sc))
        $rectBottom = [int]([math]::Round(($dipY + $dipH) * $sc))
    }
}

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
    static IntPtr s_hook;
    static RECT s_rect;

    public static bool OutsideDetected;

    static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && wParam == (IntPtr)WM_LBUTTONDOWN && !OutsideDetected) {
            try {
                var msll = (MSLL)Marshal.PtrToStructure(lParam, typeof(MSLL));
                int x = msll.pt.X, y = msll.pt.Y;
                bool inside = x >= s_rect.Left && x < s_rect.Right && y >= s_rect.Top && y < s_rect.Bottom;
                if (!inside) {
                    OutsideDetected = true;
                    PostQuitMessage(0);
                }
            } catch {
                // Parse failure: treat as UNKNOWN, never dismiss
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    public static bool Run(IntPtr targetHwnd, RECT electronBounds) {
        OutsideDetected = false;
        s_rect = electronBounds;
        IntPtr hMod = GetModuleHandle(null);
        s_hook = SetWindowsHookEx(WH_MOUSE_LL, Callback, hMod, 0);
        if (s_hook == IntPtr.Zero) return false;
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0)) {}
        if (s_hook != IntPtr.Zero) UnhookWindowsHookEx(s_hook);
        return OutsideDetected;
    }
}
"@

# Build RECT from Electron-provided DIP bounds + scale factor
$bounds = New-Object HookHelper+RECT
$bounds.Left   = $rectLeft
$bounds.Top    = $rectTop
$bounds.Right  = $rectRight
$bounds.Bottom = $rectBottom

# Run the hook synchronously
$dismissed = [HookHelper]::Run($hwnd, $bounds)

# Clean up bounds file
if (Test-Path $boundsPath) { Remove-Item $boundsPath -Force -ErrorAction SilentlyContinue }

# Write result to stdout via Write-Host (only runs after message loop exits)
if ($dismissed) {
    Write-Host "outside-click"
}
