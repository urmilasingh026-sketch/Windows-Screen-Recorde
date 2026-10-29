param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("apply", "restore")]
  [string] $Action,

  [Parameter(Mandatory = $false)]
  [string] $CursorPath
)

$ErrorActionPreference = "Stop"

$nativeMethods = @"
using System;
using System.Runtime.InteropServices;

public static class FrameCaptureCursorNative
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadCursorFromFile(string fileName);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetSystemCursor(IntPtr cursor, uint cursorId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SystemParametersInfo(
        uint action,
        uint parameter,
        IntPtr value,
        uint flags
    );

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyCursor(IntPtr cursor);
}
"@

Add-Type -TypeDefinition $nativeMethods -ErrorAction Stop

if ($Action -eq "restore") {
  $restored = [FrameCaptureCursorNative]::SystemParametersInfo(
    0x0057,
    0,
    [IntPtr]::Zero,
    0
  )
  if (-not $restored) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Windows could not reload the saved pointer theme (error $errorCode)."
  }
  exit 0
}

if ([string]::IsNullOrWhiteSpace($CursorPath) -or -not (Test-Path -LiteralPath $CursorPath -PathType Leaf)) {
  throw "The FrameCapture cursor file is missing."
}

$cursor = [FrameCaptureCursorNative]::LoadCursorFromFile($CursorPath)
if ($cursor -eq [IntPtr]::Zero) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "Windows could not load the FrameCapture pointer (error $errorCode)."
}

$applied = [FrameCaptureCursorNative]::SetSystemCursor($cursor, 32512)
if (-not $applied) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  [void][FrameCaptureCursorNative]::DestroyCursor($cursor)
  throw "Windows could not apply the FrameCapture pointer (error $errorCode)."
}

exit 0
