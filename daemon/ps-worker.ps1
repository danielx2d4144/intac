# agentvoice persistent PowerShell worker.
# One warm process owns: MCI mic recording (start/stop toggle), clipboard,
# window-targeted paste. Protocol: one command per stdin line, base64 args,
# one "OK ..."/"ERR ..." reply line per command.
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
$sig = '[DllImport("winmm.dll", CharSet = CharSet.Auto)] public static extern int mciSendString(string lpstrCommand, System.Text.StringBuilder lpstrReturnString, int uReturnLength, IntPtr hwndCallback);'
Add-Type -Name MCI -Namespace Win32 -MemberDefinition $sig
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class AvWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@

function B64([string]$s) { [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }
function Mci([string]$cmd) { [Win32.MCI]::mciSendString($cmd, $null, 0, [IntPtr]::Zero) }

[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(' ', 3)
  $cmd = $parts[0]
  try {
    switch ($cmd) {
      'PING' { [Console]::Out.WriteLine('OK PING') }
      'REC_START' {
        Mci 'close rec' | Out-Null
        Mci 'open new type waveaudio alias rec' | Out-Null
        Mci 'set rec time format ms bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2' | Out-Null
        Mci 'record rec' | Out-Null
        [Console]::Out.WriteLine('OK REC_START')
      }
      'REC_STOP' {
        $path = B64 $parts[1]
        Mci 'stop rec' | Out-Null
        Mci ('save rec "' + $path + '"') | Out-Null
        Mci 'close rec' | Out-Null
        [Console]::Out.WriteLine('OK REC_STOP')
      }
      'CLIP' {
        Set-Clipboard -Value (B64 $parts[1])
        [Console]::Out.WriteLine('OK CLIP')
      }
      'FOCUS_PASTE' {
        $re = B64 $parts[1]
        $sendEnter = $parts[2] -eq '1'
        $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match $re } | Select-Object -First 1
        if (-not $p) { [Console]::Out.WriteLine('ERR NO_TARGET') }
        else {
          [AvWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
          [AvWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
          [AvWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 400
          [System.Windows.Forms.SendKeys]::SendWait('^v')
          if ($sendEnter) { Start-Sleep -Milliseconds 250; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
          [Console]::Out.WriteLine('OK FOCUS_PASTE ' + $p.MainWindowTitle)
        }
      }
      'EXIT' { [Console]::Out.WriteLine('OK EXIT'); exit 0 }
      default { [Console]::Out.WriteLine('ERR UNKNOWN_CMD') }
    }
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message.Replace("`n", ' ').Substring(0, [Math]::Min(120, $_.Exception.Message.Length)))
  }
  [Console]::Out.Flush()
}
