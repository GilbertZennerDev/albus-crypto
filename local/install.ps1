# Sets up Albus locally: chain node + native idle-aware mining worker.
#   pwsh -File E:\WebApps\AlbusCrypto\local\install.ps1 [-SkipBuild] [-NoService]
#
#  chain        WinSW service (starts at boot, needs an elevated shell); without admin
#               it falls back to a logon task, which starts at logon instead of boot.
#  supervisor   per-user logon task (tray app; it owns idle / lock / game / thermal policy).
#               No Task Scheduler idle condition: that mechanism is unreliable.
#  old miner    the AlbusMiner task (Node/Dawn) is removed.
# Source of truth stays on E:, npm install / builds happen on D: (per the drive-layout rule).
param([switch]$SkipBuild, [switch]$NoService)
$ErrorActionPreference = 'Stop'
$src   = Split-Path -Parent $PSScriptRoot
$dst   = 'D:\app-builder\AlbusCrypto'
$state = Join-Path $env:LOCALAPPDATA 'Albus'
$bin   = Join-Path $state 'bin'
$node  = (Get-Command node).Source
$me    = "$env:USERDOMAIN\$env:USERNAME"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
New-Item -ItemType Directory -Force $state, $bin | Out-Null

# 1. Sync to D: (keep chain data and node_modules there) and build the chain
robocopy $src $dst /E /XD node_modules dist .git data web build /XF pwd.md .env /NFL /NDL /NJH /NJS | Out-Null
robocopy (Join-Path $src 'chain\data') (Join-Path $dst 'chain\data') /E /XC /XN /XO /NFL /NDL /NJH /NJS | Out-Null
Push-Location "$dst\chain"; npm install --no-audit --no-fund; npm run build; Pop-Location

# 2. Native workers (build.ps1 builds on D: and runs the golden vectors + GPU self-test with -Test)
if (-not $SkipBuild) { & (Join-Path $src 'fresh-worker\build.ps1') -Test }
$built = 'D:\app-builder\AlbusCrypto\fresh-worker\build\bin'

# 3. Stop what is running, then install binaries. A running supervisor keeps its files locked.
Get-Process albus-supervisor, albus-gpu, albus-cpu -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 1
foreach ($f in 'albus-supervisor.exe', 'albus-gpu.exe', 'albus-cpu.exe') { Copy-Item (Join-Path $built $f) $bin -Force }

# 4. Default supervisor config (never overwritten)
$cfg = Join-Path $state 'supervisor.json'
if (-not (Test-Path $cfg)) {
  @{ chainWs = 'ws://127.0.0.1:4000/mining/ws'; idleStartSeconds = 300; rampSeconds = 60; startDutyPercent = 25; activeGpuDutyPercent = 50; activeCpuDutyPercent = 40 } |
    ConvertTo-Json | Set-Content $cfg
}

# 5. Remove the old Node/Dawn miner task and process
Unregister-ScheduledTask -TaskName 'AlbusMiner' -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'AlbusCrypto.*miner' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 6. Chain: service when elevated, otherwise a logon task
$svcDir = Join-Path $env:ProgramData 'Albus'
$useService = $isAdmin -and -not $NoService
if ($useService) {
  New-Item -ItemType Directory -Force $svcDir | Out-Null
  $exe = Join-Path $svcDir 'AlbusChain.exe'
  if (-not (Test-Path $exe)) {
    Invoke-WebRequest 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile $exe
  }
  @"
<service>
  <id>AlbusChain</id>
  <name>Albus chain</name>
  <description>Albus proof-of-work chain node (localhost only)</description>
  <executable>$node</executable>
  <arguments>dist/index.js</arguments>
  <workingdirectory>$dst\chain</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <log mode="roll-by-size"><sizeThreshold>5120</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
"@ | Set-Content (Join-Path $svcDir 'AlbusChain.xml') -Encoding UTF8
  Unregister-ScheduledTask -TaskName 'AlbusChain' -Confirm:$false -ErrorAction SilentlyContinue
  & $exe stop 2>$null | Out-Null
  & $exe uninstall 2>$null | Out-Null
  & $exe install
  & $exe start
} else {
  if (-not $isAdmin) { Write-Warning 'Not elevated: chain runs from a logon task (starts at logon, not boot). Re-run from an admin shell for the boot-time service.' }
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  $chainAct = New-ScheduledTaskAction -Execute $node -Argument 'dist/index.js' -WorkingDirectory "$dst\chain"
  $chainSet = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
  Register-ScheduledTask -TaskName 'AlbusChain' -Action $chainAct -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me) `
    -Settings $chainSet -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName 'AlbusChain'
}

# 7. Wait for the chain, create the wallet once (key stays in %LOCALAPPDATA%\Albus, never in git)
$api = 'http://127.0.0.1:4000'
for ($i = 0; $i -lt 30; $i++) { try { Invoke-RestMethod "$api/health" | Out-Null; break } catch { Start-Sleep 1 } }
$walletFile = Join-Path $state 'wallet.json'
if (-not (Test-Path $walletFile)) {
  & $node (Join-Path $dst 'chain\dist\new-wallet.js') | Set-Content $walletFile
  Write-Host "Wallet created: $walletFile  (BACK UP the private key)"
}

# 8. Supervisor: logon task, no idle condition, restarts itself if it ever dies
$supAct = New-ScheduledTaskAction -Execute (Join-Path $bin 'albus-supervisor.exe') -WorkingDirectory $bin
$supSet = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$supPrincipal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'AlbusSupervisor' -Action $supAct -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me) `
  -Settings $supSet -Principal $supPrincipal -Force | Out-Null
Start-ScheduledTask -TaskName 'AlbusSupervisor'

$idle = (Get-Content $cfg -Raw | ConvertFrom-Json).idleStartSeconds
Write-Host "Done. Chain: $(if ($useService) { 'service AlbusChain' } else { 'task AlbusChain' }). Supervisor: tray icon, mines after $idle s idle."
Write-Host "Status: $state\status.json   Logs: $state\logs\   Config: $cfg"
