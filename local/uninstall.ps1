# Removes the Albus tasks / service and stops the workers. Wallet and chain data stay in place.
$ErrorActionPreference = 'Continue'
foreach ($t in 'AlbusSupervisor', 'AlbusMiner', 'AlbusChain') { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
$svc = Join-Path $env:ProgramData 'Albus\AlbusChain.exe'
if (Test-Path $svc) { & $svc stop 2>$null | Out-Null; & $svc uninstall 2>$null | Out-Null }
Get-Process albus-supervisor, albus-gpu, albus-cpu -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'AlbusCrypto' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "Tasks/service removed and workers stopped. Wallet, config, logs and chain data left in place."
