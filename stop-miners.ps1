# Stops every Albus miner (CPU controller + GPU workers). Run with: pwsh stop-miners.ps1
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'AlbusCrypto|albus1|gpu-worker' }

if (-not $procs) { Write-Host "No miners running."; return }

# Kill the controllers first so they can't respawn the GPU workers
$ordered = $procs | Sort-Object { $_.CommandLine -match 'gpu-worker' }
foreach ($p in $ordered) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped PID $($p.ProcessId)"
}

Start-Sleep -Seconds 2
$left = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'AlbusCrypto|albus1|gpu-worker' }
if ($left) { Write-Warning "Still running: $($left.ProcessId -join ', ')" } else { Write-Host "All miners stopped." }
