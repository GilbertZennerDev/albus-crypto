# Farm lokal ausprobieren, ohne Deploy und ohne dein echtes Netz / deine echte Wallet.
#   pwsh -File local\try-farm.ps1
# Startet: einen Test-Knoten (Port 4010), einen Test-Helfer und die Miner-Oberflaeche (Port 4777) mit Test-Wallet im Temp-Ordner.
# Enter druecken = alles beenden und aufraeumen (-Keep behaelt den Temp-Ordner).
param(
    [int]$NodePort = 4010,
    [int]$UiPort = 4777,
    [int]$Threads = 2,
    [string]$Cpu = 'D:\app-builder\AlbusCrypto\fresh-worker\build\bin\albus-cpu.exe',
    [switch]$Keep
)
$ErrorActionPreference = 'Stop'
$chain = Join-Path (Split-Path -Parent $PSScriptRoot) 'chain'
$tmp = Join-Path ([IO.Path]::GetTempPath()) 'albus-try'
$address = 'albus1' + ('ab' * 20)
$procs = @()

function Test-Port($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
function Wait-Url($url, $sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { try { return Invoke-RestMethod $url -TimeoutSec 2 } catch { Start-Sleep -Milliseconds 500 } }
    throw "Keine Antwort von $url (siehe Logs in $tmp)"
}
function Start-Node($name, $envs, [string[]]$nodeArgs) {
    $saved = @{}
    foreach ($k in $envs.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $envs[$k]) }
    try {
        Start-Process node -ArgumentList $nodeArgs -WorkingDirectory $chain -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $tmp "$name.log") -RedirectStandardError (Join-Path $tmp "$name.err.log")
    } finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
}

if (-not (Test-Path (Join-Path $chain 'node_modules\.bin'))) { throw "Im Ordner chain fehlt node_modules. Zuerst: cd chain; npm ci" }
if (-not (Test-Path $Cpu)) { throw "Mining-Programm fehlt: $Cpu (Parameter -Cpu anpassen)" }
foreach ($p in $NodePort, $UiPort) { if (Test-Port $p) { throw "Port $p ist schon belegt. Anderen Port waehlen: -NodePort / -UiPort" } }

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $tmp 'home'), (Join-Path $tmp 'node') | Out-Null
# Test-Wallet nur mit Adresse (kein Schluessel)
Set-Content (Join-Path $tmp 'home\wallet.json') (@{ address = $address } | ConvertTo-Json) -Encoding utf8NoBOM

try {
    Write-Host '1/3 Test-Knoten startet ...' -ForegroundColor Cyan
    $procs += Start-Node 'node' @{ PORT = "$NodePort"; DATA_DIR = (Join-Path $tmp 'node') } @('--import', 'tsx', 'src/index.ts')
    Wait-Url "http://127.0.0.1:$NodePort/info" 60 | Out-Null

    Write-Host '2/3 Test-Helfer startet ...' -ForegroundColor Cyan
    $procs += Start-Node 'agent' @{} @('--import', 'tsx', 'src/farm/agent.ts', '--address', $address, '--name', 'Test-Rig', '--threads', "$Threads",
        '--chain-ws', "ws://127.0.0.1:$NodePort/mining/ws", '--cpu', $Cpu)
    $w = $null
    foreach ($i in 1..40) {
        $w = Invoke-RestMethod "http://127.0.0.1:$NodePort/mining/workers/$address" -TimeoutSec 3
        if ($w.count -gt 0) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $w -or $w.count -lt 1) { throw "Der Helfer hat sich nicht angemeldet. Siehe $tmp\agent.log und agent.err.log" }
    Write-Host "    Knoten sieht $($w.count) Rechner: $($w.workers[0].name)" -ForegroundColor Green

    Write-Host '3/3 Oberflaeche startet ...' -ForegroundColor Cyan
    $procs += Start-Node 'ui' @{ ALBUS_HOME = (Join-Path $tmp 'home'); ALBUS_API = "http://127.0.0.1:$NodePort"; ALBUS_FARM_API = "http://127.0.0.1:$NodePort"; UI_PORT = "$UiPort"; ALBUS_NO_BROWSER = '1' } @('--import', 'tsx', 'src/ui/main.ts')
    Wait-Url "http://127.0.0.1:$UiPort/" 60 | Out-Null
    Start-Process "http://127.0.0.1:$UiPort/"

    Write-Host ''
    Write-Host "Fertig. Oberflaeche: http://127.0.0.1:$UiPort/" -ForegroundColor Green
    Write-Host 'Unter "Your farm and servers" erscheint "Test-Rig" nach etwa 15 Sekunden.'
    Write-Host "Logs: $tmp"
    Read-Host 'Enter druecken zum Beenden und Aufraeumen'
} finally {
    foreach ($p in $procs) {
        if ($p -and -not $p.HasExited) {
            Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Get-Process albus-cpu -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Cpu } | Stop-Process -Force -ErrorAction SilentlyContinue
    if (-not $Keep) { Start-Sleep -Milliseconds 500; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host 'Beendet.'
}
