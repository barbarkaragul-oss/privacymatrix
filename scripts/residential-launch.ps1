<#
Template for the scheduled task's launcher. scripts/install-residential-task.ps1 copies it OUT of
the repository, into the task's state folder, filling in the two values below. The copy is what the
task runs, so nothing a later pull brings in can change what runs before main is checked out.

Each run: clone the repository into the state folder if needed, reset that clone to origin/main,
remove anything else in it (except node_modules), then run scripts/residential.ts from it. That
clone is used by the task alone, so resetting it can never touch a checkout someone is working in,
and the code that runs is always exactly what is merged to main.

Run it by hand to force a run now:  powershell -ExecutionPolicy Bypass -File <state>\residential-launch.ps1 -Force
Or to see what a run would do, with nothing committed, pushed or sent:  ... -DryRun
#>
param([switch]$Force, [switch]$DryRun)

$ErrorActionPreference = 'Stop'
$state = '__STATE_DIR__'
$remote = '__REMOTE_URL__'
$clone = Join-Path $state 'checkout'
$log = Join-Path $state 'residential.log'
New-Item -ItemType Directory -Force -Path $state | Out-Null

# A scheduled task has nobody to answer a credential prompt: fail instead of hanging.
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
$env:RESIDENTIAL_STATE_DIR = $state

$flag = ''
if ($Force) { $flag += ' --force' }
if ($DryRun) { $flag += ' --dry-run' }
$steps = @(
  "if not exist `"$clone\.git`" git clone --quiet `"$remote`" `"$clone`"",
  "git -C `"$clone`" fetch --quiet origin main",
  "git -C `"$clone`" checkout --quiet -B main FETCH_HEAD",
  "git -C `"$clone`" reset --quiet --hard FETCH_HEAD",
  "git -C `"$clone`" clean -fdxq -e node_modules",
  "cd /d `"$clone`"",
  "node --experimental-strip-types scripts\residential.ts$flag"
)
$chain = ($steps | ForEach-Object { "($_)" }) -join ' && '

Add-Content -Path $log -Encoding UTF8 -Value ('=== {0} launcher' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))
& cmd.exe /d /c "($chain) >> `"$log`" 2>&1"
$code = $LASTEXITCODE
if ($code -ne 0) {
  Add-Content -Path $log -Encoding UTF8 -Value ('=== launcher: a step failed with exit code {0}' -f $code)
}
exit $code
