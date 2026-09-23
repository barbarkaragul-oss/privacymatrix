<#
.SYNOPSIS
Registers a daily Windows scheduled task that runs the PrivacyMatrix residential re-check.

.DESCRIPTION
Run it once, in an ordinary (not elevated) PowerShell window, from a checkout of the repository,
on a machine whose connection the vendors do not block:

    powershell -ExecutionPolicy Bypass -File scripts\install-residential-task.ps1

What it sets up, all under -StateDir (default %LOCALAPPDATA%\PrivacyMatrix), outside any checkout:
  - residential-launch.cmd, copied from scripts\residential-launch.cmd with the paths filled in;
  - checkout\, a clone the task alone uses, created on the first run and reset to origin/main before
    every run, so the task never touches the checkout you work in and only runs code merged to main;
  - residential.log, last-success and installed-lock, written by the runs.

The task runs as you, only while you are logged on, so it needs no stored password and no
administrator rights. It starts the batch launcher in a console without a window
(conhost --headless), and no PowerShell runs while it runs. It fires every day at -At, default
13:00 (after the weekly cloud run on Monday morning), and at the next chance after a missed time.
Each run exits early unless the last success is six or more days old.

Run once now:     Start-ScheduledTask -TaskName 'PrivacyMatrix residential check'
Force a run:      cmd /c "%LOCALAPPDATA%\PrivacyMatrix\residential-launch.cmd" --force
Dry run:          cmd /c "%LOCALAPPDATA%\PrivacyMatrix\residential-launch.cmd" --dry-run
Remove the task:  Unregister-ScheduledTask -TaskName 'PrivacyMatrix residential check' -Confirm:$false
Re-run this installer after the launcher template changes.
#>
param(
  [string]$At = '13:00',
  [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'PrivacyMatrix')
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

foreach ($tool in 'git', 'node', 'npm') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool was not found on PATH; install it or fix PATH before registering the task."
  }
}
$remote = (& git -C $repo remote get-url origin).Trim()
if ($remote -notmatch '^https://github\.com/') {
  throw "origin is '$remote'; the task needs the https GitHub remote so that git's credential manager can push."
}
foreach ($value in $StateDir, $remote) {
  if ($value -match '["%]') { throw "'$value' contains a double quote or a percent sign, which a batch file cannot hold safely." }
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
# The earlier PowerShell launcher, if this machine had it: remove it so it cannot be run by mistake.
Remove-Item -Force -ErrorAction SilentlyContinue -Path (Join-Path $StateDir 'residential-launch.ps1')

# cmd.exe wants CRLF line endings (labels misbehave with bare LF) and no byte-order mark.
$template = Get-Content -Raw -Encoding UTF8 -Path (Join-Path $PSScriptRoot 'residential-launch.cmd')
$text = $template.Replace('__STATE_DIR__', $StateDir).Replace('__REMOTE_URL__', $remote)
$text = ($text -replace "`r?`n", "`r`n")
$launcher = Join-Path $StateDir 'residential-launch.cmd'
[System.IO.File]::WriteAllText($launcher, $text, (New-Object System.Text.ASCIIEncoding))

# conhost --headless gives the launcher a console with no window. A plain cmd.exe would open one:
# where Windows Terminal is the default terminal (the Windows 11 default) it cannot be hidden, and
# closing it kills the run part way.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless cmd.exe /d /c `"`"$launcher`"`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RunOnlyIfNetworkAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName 'PrivacyMatrix residential check' `
  -Description 'Re-checks the PrivacyMatrix apps whose sources refuse cloud IP ranges. See scripts/residential.ts.' `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered 'PrivacyMatrix residential check': daily at $At, or at the next chance after a missed time."
Write-Host "Launcher: $launcher"
Write-Host "Log:      $(Join-Path $StateDir 'residential.log')"
