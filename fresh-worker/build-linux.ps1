# Baut den CPU-Miner fuer Linux (ohne GPU, ohne Tray) und prueft die Hashes.
#   pwsh -File build-linux.ps1            baut mit g++ (Linux) oder, falls dort keins ist, in einem Docker-Container
#   pwsh -File build-linux.ps1 -Out DIR   Ausgabeordner (Standard: build-linux)
param([string]$Out = (Join-Path $PSScriptRoot 'build-linux'))
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
New-Item -ItemType Directory -Force $Out | Out-Null
$script = 'set -e; g++ -std=c++20 -O2 -pthread -static-libstdc++ -static-libgcc cpu/main.cpp -o OUT/albus-cpu; g++ -std=c++20 -O2 -pthread tests/test_cpu.cpp -o OUT/albus-tests; OUT/albus-tests tests/golden/vectors.json; OUT/albus-cpu --selftest'
if ($IsLinux -and (Get-Command g++ -ErrorAction SilentlyContinue)) {
    Push-Location $src
    try { bash -c ($script -replace 'OUT', $Out); if ($LASTEXITCODE -ne 0) { throw "Linux-Build fehlgeschlagen ($LASTEXITCODE)" } } finally { Pop-Location }
} else {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Auf Linux wird g++ gebraucht, sonst Docker.' }
    docker run --rm -v "${src}:/w" -w /w gcc:13 bash -c ($script -replace 'OUT', 'build-linux')
    if ($LASTEXITCODE -ne 0) { throw "Linux-Build fehlgeschlagen ($LASTEXITCODE)" }
}
Write-Host "OK: $Out" -ForegroundColor Green
