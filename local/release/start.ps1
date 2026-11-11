# Startet DIESE Version: haengt die Aufgaben AlbusChain und AlbusSupervisor auf diesen Ordner um und startet sie.
# Daten (Wallet, Freundesliste, Kette) liegen ausserhalb in %LOCALAPPDATA%\Albus und bleiben bei jedem Update erhalten.
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$state = if ($env:ALBUS_HOME) { $env:ALBUS_HOME } else { Join-Path $env:LOCALAPPDATA 'Albus' }
$me    = "$env:USERDOMAIN\$env:USERNAME"
$node  = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force $state, (Join-Path $state 'chain-data') | Out-Null

$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$logon = New-ScheduledTaskTrigger -AtLogOn -User $me

$chain = Join-Path $root 'scripts\run-chain.ps1'
$a = New-ScheduledTaskAction -Execute 'pwsh' -Argument "-NoProfile -WindowStyle Hidden -File `"$chain`" -Node `"$node`" -Root `"$root`" -State `"$state`""
Register-ScheduledTask -TaskName 'AlbusChain' -Action $a -Trigger $logon -Settings $set -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'AlbusChain'

$sup = Join-Path $root 'bin\albus-supervisor.exe'
if (Test-Path $sup) {
  $a = New-ScheduledTaskAction -Execute $sup -WorkingDirectory (Join-Path $root 'bin')
  Register-ScheduledTask -TaskName 'AlbusSupervisor' -Action $a -Trigger $logon -Settings $set -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName 'AlbusSupervisor'
}

# Oberflaeche: wird nur eingetragen (gilt ab dem naechsten Anmelden) und nur gestartet, wenn sie nicht schon laeuft.
# Sie wird bei einem Update NICHT angehalten, denn sie fuehrt das Update ja gerade aus.
$ui = Join-Path $root 'scripts\run-ui.ps1'
$a = New-ScheduledTaskAction -Execute 'pwsh' -Argument "-NoProfile -WindowStyle Hidden -File `"$ui`" -Node `"$node`" -Root `"$root`" -State `"$state`""
Register-ScheduledTask -TaskName 'AlbusUi' -Action $a -Trigger $logon -Settings $set -Principal $principal -Force | Out-Null
if ((Get-ScheduledTask -TaskName 'AlbusUi').State -ne 'Running') { Start-ScheduledTask -TaskName 'AlbusUi' }
