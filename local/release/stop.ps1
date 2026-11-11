# Haelt Knoten und Mining-Programme an (Aufgaben bleiben eingetragen, start.ps1 der naechsten Version haengt sie um).
$ErrorActionPreference = 'SilentlyContinue'
foreach ($t in 'AlbusSupervisor', 'AlbusChain') { Stop-ScheduledTask -TaskName $t }
Get-Process albus-supervisor, albus-gpu, albus-cpu | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'run-chain|chain[\/]index\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 1
