@echo off
rem Launcher for the PrivacyMatrix residential re-check (see scripts\residential.ts).
rem
rem scripts\install-residential-task.ps1 copies this file OUT of the repository into the task's
rem state folder and fills in the remote URL below. The copy is what the scheduled task runs, so
rem nothing a later pull brings in can change what runs before main is checked out.
rem
rem The folder the copy sits in is the state folder: the clone, the log and the run markers are
rem kept next to it. Moving the copy moves the state folder; re-run the installer instead.
rem
rem No path is written into this file, and it must stay pure ASCII: cmd.exe reads a batch file in
rem the console's code page, which is not the same on every machine or in every console.
rem
rem Each run: clone the repository into the state folder if needed, reset that clone to
rem origin/main, remove anything else in it (except node_modules), then run residential.ts from it.
rem That clone is used by the task alone, so resetting it never touches a checkout someone works
rem in, and the code that runs is always exactly what is merged to main.
rem
rem One run at a time: a run takes the lock (the folder run-lock in the state folder) before it
rem touches the clone, and a second run started meanwhile (the daily task while --read is open, or
rem the other way round) stops with exit code 3 instead of resetting the clone under the first, and
rem notes that in refused.log. A lock older than three hours was left by a run that was killed, and
rem is removed.
rem
rem It is a plain batch file on purpose: no PowerShell runs while the task runs.
rem
rem Arguments are passed on to residential.ts:  --force  (run now),  --dry-run  (nothing committed)
rem or  --read  (open the reading page for the pages only a person can read; after every run the
rem log says how many are due, and nothing opens on its own)

rem Delayed expansion stays off, so that a "!" in the folder name is kept as it is.
setlocal EnableExtensions DisableDelayedExpansion
rem The state folder is the folder of this file, without the trailing backslash.
set "STATE=%~dp0"
set "STATE=%STATE:~0,-1%"
set "REMOTE=__REMOTE_URL__"
set "CLONE=%STATE%\checkout"
set "LOG=%STATE%\residential.log"
set "LOCK=%STATE%\run-lock"
rem A scheduled task has nobody to answer a credential prompt: fail instead of hanging.
set "GIT_TERMINAL_PROMPT=0"
set "GCM_INTERACTIVE=never"
set "RESIDENTIAL_STATE_DIR=%STATE%"

rem mkdir either creates the folder or fails, in one step, so two launchers cannot both take it.
set "HOLD="
mkdir "%LOCK%" 2>nul && set "HOLD=1"
if not defined HOLD (call :stale && mkdir "%LOCK%" 2>nul && set "HOLD=1")
if not defined HOLD (
  rem The run that holds the lock keeps the log open, so the refusal goes to a file of its own.
  >>"%STATE%\refused.log" echo %DATE% %TIME% another run held the lock, so this one did not start
  echo another run holds the lock, so this one did not start
  exit /b 3
)
>>"%LOG%" echo === %DATE% %TIME% launcher
call :run %* >>"%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
rem Every exit of :run comes back here, so the lock is always given back.
rmdir "%LOCK%" 2>nul
rem Always written, so a log that ends without this line means the run was killed part way.
>>"%LOG%" echo === %DATE% %TIME% launcher finished with exit code %CODE%
exit /b %CODE%

:stale
rem Exit code 0 when the lock is more than three hours old (the task stops a run after one hour)
rem and has been removed; 1 when it is recent, or its age cannot be read.
node -e "process.exit(Date.now()-require('fs').statSync(process.argv[1]).mtimeMs>3*3600e3?0:1)" "%LOCK%" 2>nul || exit /b 1
>>"%LOG%" echo removed a lock more than three hours old, left by a run that was killed
rmdir "%LOCK%" 2>nul
exit /b 0

:run
if not exist "%CLONE%\.git" (
  git clone --quiet "%REMOTE%" "%CLONE%" || exit /b 1
)
git -C "%CLONE%" fetch --quiet origin main || (echo could not reach GitHub; trying again at the next run & exit /b 1)
git -C "%CLONE%" checkout --quiet -B main FETCH_HEAD || exit /b 1
git -C "%CLONE%" reset --quiet --hard FETCH_HEAD || exit /b 1
git -C "%CLONE%" clean -fdxq -e node_modules || exit /b 1
cd /d "%CLONE%" || exit /b 1
node --experimental-strip-types scripts\residential.ts %*
exit /b %ERRORLEVEL%
