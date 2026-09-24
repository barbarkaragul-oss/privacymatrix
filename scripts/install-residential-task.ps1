<#
.SYNOPSIS
Registers a daily Windows scheduled task that runs the PrivacyMatrix residential re-check.

.DESCRIPTION
Run it once, in an ordinary (not elevated) PowerShell window, from a checkout of the repository,
on a machine whose connection the vendors do not block:

    powershell -ExecutionPolicy Bypass -File scripts\install-residential-task.ps1

What it sets up, all under -StateDir (default %LOCALAPPDATA%\PrivacyMatrix), outside any checkout:
  - residential-launch.cmd, copied from scripts\residential-launch.cmd with the remote URL filled in;
    the folder it sits in is the state folder, so leave it where it is;
  - checkout\, a clone the task alone uses, created on the first run and reset to origin/main before
    every run, so the task never touches the checkout you work in and only runs code merged to main;
  - residential.log, last-success and installed-lock, written by the runs.

The task runs as you, only while you are logged on, so it needs no stored password and no
administrator rights. It starts the batch launcher from the state folder in a console without a
window (conhost --headless), and no PowerShell runs while it runs. It fires every day at -At, default
13:00 (after the weekly cloud run on Monday morning), and at the next chance after a missed time.
Each run exits early unless the last success is six or more days old.

Run once now:     Start-ScheduledTask -TaskName 'PrivacyMatrix residential check'
Force a run:      cmd /c "%LOCALAPPDATA%\PrivacyMatrix\residential-launch.cmd" --force
Dry run:          cmd /c "%LOCALAPPDATA%\PrivacyMatrix\residential-launch.cmd" --dry-run
Remove the task:  Unregister-ScheduledTask -TaskName 'PrivacyMatrix residential check' -Confirm:$false
Re-run this installer after the launcher template changes, or if the state folder is moved or deleted.
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
if ($remote -match '["%]') {
  throw "origin '$remote' contains a double quote or a percent sign, which the launcher cannot hold."
}

# The task starts the launcher from the state folder, so it must be an absolute path to a folder
# on a drive letter: cmd.exe cannot start in a network (UNC) folder. The launcher works out the
# folder from its own location and drops the trailing backslash, which a drive root would not
# survive.
$StateDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StateDir)
if ($StateDir -cnotmatch '^[A-Za-z]:\\[^\\]') {
  throw "-StateDir '$StateDir' is not accepted: it must be a folder on a drive letter, not a drive root or a network path."
}
# A percent sign can be expanded as a variable (by cmd on the command line, by CALL, and by Task
# Scheduler in the working directory), and an ampersand would split any unquoted use of the path
# into two commands.
if ($StateDir -match '[%&]') {
  throw "-StateDir '$StateDir' is not accepted: it contains a percent sign or an ampersand. Choose another folder with -StateDir."
}

# cmd.exe wants CRLF line endings (labels misbehave with bare LF) and no byte-order mark, and it
# reads a batch file in the console's code page, so the launcher must hold no byte above 0x7F.
$template = Get-Content -Raw -Encoding UTF8 -Path (Join-Path $PSScriptRoot 'residential-launch.cmd')
$text = $template.Replace('__REMOTE_URL__', $remote)
$text = ($text -replace "`r?`n", "`r`n")
# -cmatch: a case-insensitive match folds case in the current culture, and in Turkish "I" folds to
# the dotless i, which is not ASCII.
if ($text -cmatch '[^\x00-\x7F]') {
  throw 'The launcher must stay pure ASCII: cmd.exe reads it in the console code page.'
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
# The earlier PowerShell launcher, if this machine had it: remove it so it cannot be run by mistake.
Remove-Item -Force -ErrorAction SilentlyContinue -Path (Join-Path $StateDir 'residential-launch.ps1')
$launcher = Join-Path $StateDir 'residential-launch.cmd'
[System.IO.File]::WriteAllText($launcher, $text, (New-Object System.Text.ASCIIEncoding))

# conhost --headless gives the launcher a console with no window. A plain cmd.exe would open one:
# where Windows Terminal is the default terminal (the Windows 11 default) it cannot be hidden, and
# closing it kills the run part way.
# The launcher is started by name from its own folder, with no path and no quotes on the command
# line: conhost splits the command line again before passing it on and drops doubled quotes, so a
# quoted path with a space in it would not reach cmd.exe whole, and cmd /c drops even single
# quotes around a path that holds "@" or "^". The .\ is there because the current folder may be
# left out of the search for a bare command name.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '--headless cmd.exe /d /c .\residential-launch.cmd' -WorkingDirectory $StateDir
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
Write-Host "Task Scheduler shows the last run result as 0 even when the launcher failed (the headless console returns 0); the last line of the log gives the launcher's exit code."
