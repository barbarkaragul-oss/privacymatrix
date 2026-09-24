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
rem It is a plain batch file on purpose: no PowerShell runs while the task runs.
rem
rem Arguments are passed on to residential.ts:  --force  (run now)  or  --dry-run  (nothing committed)

rem Delayed expansion stays off, so that a "!" in the folder name is kept as it is.
setlocal EnableExtensions DisableDelayedExpansion
rem The state folder is the folder of this file, without the trailing backslash.
set "STATE=%~dp0"
set "STATE=%STATE:~0,-1%"
set "REMOTE=__REMOTE_URL__"
set "CLONE=%STATE%\checkout"
set "LOG=%STATE%\residential.log"
rem A scheduled task has nobody to answer a credential prompt: fail instead of hanging.
set "GIT_TERMINAL_PROMPT=0"
set "GCM_INTERACTIVE=never"
set "RESIDENTIAL_STATE_DIR=%STATE%"

>>"%LOG%" echo === %DATE% %TIME% launcher
call :run %* >>"%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
rem Always written, so a log that ends without this line means the run was killed part way.
>>"%LOG%" echo === %DATE% %TIME% launcher finished with exit code %CODE%
exit /b %CODE%

:run
if not exist "%CLONE%\.git" (
  git clone --quiet "%REMOTE%" "%CLONE%" || exit /b 1
)
git -C "%CLONE%" fetch --quiet origin main || exit /b 1
git -C "%CLONE%" checkout --quiet -B main FETCH_HEAD || exit /b 1
git -C "%CLONE%" reset --quiet --hard FETCH_HEAD || exit /b 1
git -C "%CLONE%" clean -fdxq -e node_modules || exit /b 1
cd /d "%CLONE%" || exit /b 1
node --experimental-strip-types scripts\residential.ts %*
exit /b %ERRORLEVEL%
