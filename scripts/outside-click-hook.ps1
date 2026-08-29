# Outside-click hook for Cue passive answer window.
# Uses WH_MOUSE_LL to observe (not consume) mouse-down events outside the
# answer window HWND.  When detected, writes "outside-click" to stdout and
# exits cleanly.  The original click continues normally to the underlying
# application.
#
# Classification uses GetWindowRect + point-in-rect instead of
# WindowFromPoint/GetAncestor because Chromium creates complex child HWND
# hierarchies that make root-window comparison unreliable.
#
# Usage: powershell -ExecutionPolicy Bypass -File outside-click-hook.ps1 <hwnd>
# Communication: stdout lines read by parent process via readline interface.
#                stderr used for diagnostic logging (read by parent for debugging).

param([string]$TargetHwnd)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class OutClickHook {
    public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    public static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    public static extern bool PostQuitMessage(int nExitCode);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSLLHOOKSTRUCT {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    public const int WH_MOUSE_LL = 14;
    public const int WM_LBUTTONDOWN = 0x0201;

    // Marshal.PtrToStructure inside PowerShell scriptblocks throws
    // "structure must not be a value class" on PowerShell 5.1 because the
    // boxed struct is passed by value to an overload expecting ref.
    // Move all marshaling into compiled C# helpers to avoid this.

    public static MSLLHOOKSTRUCT ReadMSLL(IntPtr ptr) {
        return (MSLLHOOKSTRUCT)Marshal.PtrToStructure(ptr, typeof(MSLLHOOKSTRUCT));
    }

    // Check if a screen point falls inside a window's rect.
    // This is more reliable than WindowFromPoint + GetAncestor for
    // Chromium/Electron which creates complex child HWND hierarchies.
    public static bool IsPointInWindowRect(IntPtr hwnd, int x, int y) {
        RECT rect;
        if (!GetWindowRect(hwnd, out rect)) return false;
        return x >= rect.Left && x < rect.Right && y >= rect.Top && y < rect.Bottom;
    }
}
"@

$hwnd = [IntPtr]::Zero
try { $hwnd = [IntPtr][long]$TargetHwnd } catch {}

$hook = [IntPtr]::Zero
$dllHandle = [OutClickHook]::GetModuleHandle([NullString]::Value)

$script:outsideDetected = $false

$callback = [OutClickHook+LowLevelMouseProc]{
    param($nCode, $wParam, $lParam)
    if ($nCode -ge 0 -and $wParam -eq [OutClickHook]::WM_LBUTTONDOWN -and -not $script:outsideDetected) {
        try {
            # Use C# helper — PtrToStructure inside the scriptblock causes
            # "structure must not be a value class" on PowerShell 5.1.
            $msll = [OutClickHook]::ReadMSLL($lParam)
            $x = $msll.pt.X
            $y = $msll.pt.Y

            # Point-in-rect: check if the click is inside Cue's window rectangle.
            # This avoids the unreliable WindowFromPoint + GetAncestor(GA_ROOT)
            # approach which fails with Chromium's complex child HWND hierarchy.
            $inside = [OutClickHook]::IsPointInWindowRect($script:hwnd, $x, $y)

            if (-not $inside) {
                $script:outsideDetected = $true
                Write-Host "outside-click"
                # Unblock the message loop so GetMessage returns false
                [OutClickHook]::PostQuitMessage(0)
            }
        } catch {
            # If marshaling or classification fails, treat as UNKNOWN —
            # do NOT emit outside-click.  Log to stderr for diagnostics.
            Write-Host "MOUSE_PARSE_ERROR: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    return [OutClickHook]::CallNextHookEx([IntPtr]::Zero, $nCode, $wParam, $lParam)
}

$hook = [OutClickHook]::SetWindowsHookEx([OutClickHook]::WH_MOUSE_LL, $callback, $dllHandle, 0)
if ($hook -eq [IntPtr]::Zero) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Host "hook-error"
    Write-Host "hook-error: SetWindowsHookEx failed, Win32 error=$err" -ForegroundColor Red
    [Environment]::Exit(1)
}

# Log the target HWND rect for verification
$rect = New-Object OutClickHook+RECT
[OutClickHook]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
Write-Host "target-hwnd=$hwnd rect=$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"

# Message loop: keeps the hook alive.  GetMessage returns false when
# PostQuitMessage is called by the callback, or when the process is killed.
$msg = New-Object OutClickHook+MSG
while ([OutClickHook]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0)) {}

# Cleanup: unhook before exiting so Windows removes the hook promptly.
if ($hook -ne [IntPtr]::Zero) {
    [OutClickHook]::UnhookWindowsHookEx($hook) | Out-Null
}
