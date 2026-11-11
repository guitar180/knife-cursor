param(
  [int]$ParentPid = 0,
  [string]$CursorPath = '',
  [string]$StopPath = '',
  [string]$LogPath = '',
  [switch]$RestoreOnly
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-HelperLog([string]$Message) {
  if (-not $LogPath) {
    return
  }

  try {
    $line = '[' + (Get-Date).ToUniversalTime().ToString('o') + '] ' + $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {
    # Logging must not stop the cursor guard.
  }
}

Write-HelperLog "start parent=$ParentPid cursor=$CursorPath stop=$StopPath restoreOnly=$RestoreOnly"
Write-HelperLog "env TEMP=$env:TEMP TMP=$env:TMP cwd=$((Get-Location).Path) ps=$($PSVersionTable.PSVersion)"

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class KnifeCursorNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadCursorFromFile(string path);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetSystemCursor(IntPtr hcur, uint id);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint action, uint param, IntPtr data, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr cursorName);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetCursor(IntPtr hCursor);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern void mouse_event(
        uint flags,
        int dx,
        int dy,
        uint data,
        UIntPtr extraInfo);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeout", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeoutCursor(
        IntPtr hWnd,
        uint msg,
        IntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out UIntPtr result);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint msg,
        UIntPtr wParam,
        string lParam,
        uint flags,
        uint timeout,
        out UIntPtr result);
}
'@ -ErrorAction Stop
} catch {
  Write-HelperLog "Add-Type failed: $($_.Exception.Message)"
  exit 1
}

# Every standard Windows cursor id. Replacing only OCR_NORMAL leaves the I-beam,
# hand and resize arrows visible over text fields and window borders.
$cursorIds = @(
  32512, 32513, 32514, 32515, 32516,
  32631, 32640, 32641, 32642, 32643, 32644,
  32645, 32646, 32647, 32648, 32649, 32650, 32651
)

$cursorRegistryNames = @{
  32512 = 'Arrow'
  32513 = 'IBeam'
  32514 = 'Wait'
  32515 = 'Crosshair'
  32516 = 'UpArrow'
  32631 = 'Pin'
  32640 = 'SizeAll'
  32641 = 'Icon'
  32642 = 'SizeNWSE'
  32643 = 'SizeNESW'
  32644 = 'SizeWE'
  32645 = 'SizeNS'
  32646 = 'SizeAll'
  32647 = 'Icon'
  32648 = 'No'
  32649 = 'Hand'
  32650 = 'AppStarting'
  32651 = 'Help'
}

$script:cursorScheme = Get-ItemProperty `
  -Path 'HKCU:\Control Panel\Cursors' `
  -ErrorAction SilentlyContinue

$defaultArrow = Join-Path $env:SystemRoot 'Cursors\aero_arrow.cur'
if (-not (Test-Path -LiteralPath $defaultArrow)) {
  $defaultArrow = Join-Path $env:SystemRoot 'Cursors\arrow.cur'
}
if (-not (Test-Path -LiteralPath $defaultArrow)) {
  $defaultArrow = ''
}

function Get-CursorPath([int]$CursorId) {
  $name = $cursorRegistryNames[$CursorId]
  if ($name -and $null -ne $script:cursorScheme) {
    $property = $script:cursorScheme.PSObject.Properties[$name]
    if ($null -ne $property) {
      $raw = [string]$property.Value
      if ($raw) {
        $expanded = [Environment]::ExpandEnvironmentVariables($raw)
        if (Test-Path -LiteralPath $expanded) {
          return $expanded
        }
      }
    }
  }

  return $defaultArrow
}

function Set-CursorFromFile([string]$Path, [uint32]$CursorId) {
  if (-not $Path) {
    Write-HelperLog "restore: no cursor file for id=$CursorId"
    return $false
  }

  $handle = [KnifeCursorNative]::LoadCursorFromFile($Path)
  if ($handle -eq [IntPtr]::Zero) {
    Write-HelperLog "restore: LoadCursorFromFile failed id=$CursorId path=$Path"
    return $false
  }

  $ok = [KnifeCursorNative]::SetSystemCursor($handle, $CursorId)
  if (-not $ok) {
    # SetSystemCursor destroys the handle, so there is nothing to free here.
    Write-HelperLog "restore: SetSystemCursor failed id=$CursorId path=$Path"
  }
  return $ok
}

function Restore-KnifeCursor {
  Write-HelperLog "restore: applying cursor files; arrow=$defaultArrow"

  # Do not rely on SPI_SETCURSORS alone. It reloads the registry scheme but on
  # Windows 11 the current pointer can keep the blank handle until it is
  # re-set. Restore the real files for every cursor id first.
  foreach ($id in $cursorIds) {
    $path = Get-CursorPath -CursorId $id
    [void](Set-CursorFromFile -Path $path -CursorId ([uint32]$id))
  }

  # Reload the user's scheme. This also broadcasts WM_SETTINGCHANGE, but we
  # send an explicit Cursor broadcast below for shells that ignore it.
  [KnifeCursorNative]::SystemParametersInfo(0x0057, 0, [IntPtr]::Zero, 3) | Out-Null

  # The normal arrow is the one users notice. Force a real aero arrow after the
  # scheme reload, even if the scheme's Arrow value is empty or custom.
  if ($defaultArrow) {
    [void](Set-CursorFromFile -Path $defaultArrow -CursorId 32512)
  }

  # SetSystemCursor changes the cursor table; it does not necessarily change
  # the currently displayed handle. SetCursor + a real one-pixel mouse move
  # forces the window under the pointer to process WM_SETCURSOR again.
  $arrow = [KnifeCursorNative]::LoadCursor([IntPtr]::Zero, [IntPtr]32512)
  if ($arrow -ne [IntPtr]::Zero) {
    [KnifeCursorNative]::SetCursor($arrow) | Out-Null
  }

  $broadcastResult = [UIntPtr]::Zero
  [KnifeCursorNative]::SendMessageTimeout(
    [IntPtr]0xffff,
    0x001A,
    [UIntPtr]::Zero,
    'Cursor',
    2,
    100,
    [ref]$broadcastResult
  ) | Out-Null

  $point = [KnifeCursorNative+POINT]::new()
  if ([KnifeCursorNative]::GetCursorPos([ref]$point)) {
    # The current cursor can still point at the destroyed transparent handle
    # even after SetSystemCursor succeeds. Ask the window under the pointer to
    # process WM_SETCURSOR again so Windows installs a fresh, valid arrow.
    $under = [KnifeCursorNative]::WindowFromPoint($point)
    if ($under -ne [IntPtr]::Zero) {
      # lParam = MAKELPARAM(HTCLIENT, WM_MOUSEMOVE)
      $cursorLParam = [IntPtr]((0x0200 -shl 16) -bor 1)
      $cursorResult = [UIntPtr]::Zero
      [KnifeCursorNative]::SendMessageTimeoutCursor(
        $under,
        0x0020,
        $under,
        $cursorLParam,
        2,
        100,
        [ref]$cursorResult
      ) | Out-Null
      Write-HelperLog "restore: WM_SETCURSOR sent hwnd=$under"
    }

    # mouse_event is closer to real input than SetCursorPos on Windows 11;
    # some shells ignore a programmatic SetCursorPos but redraw for a move.
    [KnifeCursorNative]::mouse_event(0x0001, 1, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [KnifeCursorNative]::mouse_event(0x0001, -1, 0, 0, [UIntPtr]::Zero)
    Write-HelperLog "restore: pointer refresh at $($point.X),$($point.Y)"
  } else {
    Write-HelperLog 'restore: GetCursorPos failed; pointer refresh skipped'
  }

  # Last resort from the Windows shell: reload the per-user cursor scheme.
  # This is deliberately fire-and-forget; waiting on rundll32 can stall exit.
  try {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\rundll32.exe') `
      -ArgumentList 'user32.dll,UpdatePerUserSystemParameters' `
      -WindowStyle Hidden | Out-Null
    Write-HelperLog 'restore: UpdatePerUserSystemParameters requested'
  } catch {
    Write-HelperLog "restore: rundll32 failed: $($_.Exception.Message)"
  }

  Write-HelperLog 'restore: complete'
}

if ($RestoreOnly) {
  Write-HelperLog 'restore-only'
  Restore-KnifeCursor
  exit 0
}

try {
  Write-HelperLog 'replacing cursor ids'
  foreach ($id in $cursorIds) {
    $handle = [KnifeCursorNative]::LoadCursorFromFile($CursorPath)
    if ($handle -ne [IntPtr]::Zero) {
      $ok = [KnifeCursorNative]::SetSystemCursor($handle, [uint32]$id)
      if (-not $ok) {
        Write-HelperLog "SetSystemCursor failed id=$id"
      }
    } else {
      Write-HelperLog "LoadCursorFromFile failed id=$id"
    }
  }
  Write-HelperLog 'cursor ids replaced; entering wait loop'

  # Stay alive with the overlay so a crash, task-manager kill or normal quit
  # still restores the user's real cursor. The main process can also request a
  # prompt restore by creating the stop file.
  #
  # Parent PID alone is not enough. If Electron is killed by closing the
  # terminal, Windows may terminate the whole console process group before the
  # parent check gets a chance to run. This guard is started through
  # Start-Process (a separate console), so it survives that close; once the
  # parent disappears it waits at most five seconds, then force-restores.
  $parentMissingSince = $null
  $maxParentMissingSeconds = 5

  while ($true) {
    if ($StopPath -and (Test-Path -LiteralPath $StopPath)) {
      Write-HelperLog 'stop file detected'
      break
    }

    if ($ParentPid -gt 0) {
      $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
      if ($null -eq $parent) {
        if ($null -eq $parentMissingSince) {
          $parentMissingSince = [DateTime]::UtcNow
          Write-HelperLog "parent process $ParentPid not found; waiting up to ${maxParentMissingSeconds}s before restore"
        } elseif (([DateTime]::UtcNow - $parentMissingSince).TotalSeconds -ge $maxParentMissingSeconds) {
          Write-HelperLog "parent process $ParentPid still missing after ${maxParentMissingSeconds}s; forcing restore"
          break
        }
      } else {
        $parentMissingSince = $null
      }
    }

    Start-Sleep -Milliseconds 200
  }
}
catch {
  Write-HelperLog "caught: $($_.Exception.Message)"
}
finally {
  Write-HelperLog 'restoring and exiting'
  Restore-KnifeCursor
}