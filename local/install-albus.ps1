# Albus Miner installieren (Windows). Aufruf in PowerShell:
#   irm https://albus.workflowsolved.com/releases/install-albus.ps1 | iex
# Das Skript prueft Node.js und PowerShell 7, laedt das Installationsprogramm und startet es.
# Das Programm prueft die Unterschrift jedes Updates mit einem fest eingebauten Schluessel. Ihre Coins und Schluessel bleiben auf diesem PC.
$ErrorActionPreference = 'Stop'
$base = if ($env:ALBUS_RELEASES) { $env:ALBUS_RELEASES.TrimEnd('/') } else { 'https://albus.workflowsolved.com/releases' }
$home2 = if ($env:ALBUS_HOME) { $env:ALBUS_HOME } else { Join-Path $env:LOCALAPPDATA 'Albus' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Need($cmd, $wingetId, $name) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { return }
  Write-Host "$name fehlt." -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $a = Read-Host "$name jetzt mit winget installieren? (j/n)"
    if ($a -match '^(j|y)') {
      winget install --id $wingetId -e --accept-package-agreements --accept-source-agreements
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
      if (Get-Command $cmd -ErrorAction SilentlyContinue) { return }
      throw "$name ist installiert, aber noch nicht im Pfad. Bitte dieses Fenster schliessen, ein neues oeffnen und den Befehl noch einmal ausfuehren."
    }
  }
  throw "Bitte $name installieren und diesen Befehl noch einmal ausfuehren."
}

Need 'node' 'OpenJS.NodeJS.LTS' 'Node.js (LTS)'
Need 'pwsh' 'Microsoft.PowerShell' 'PowerShell 7'

New-Item -ItemType Directory -Force $home2 | Out-Null
$boot = Join-Path $home2 'bootstrap.mjs'
Write-Host "Lade Installationsprogramm von $base ..."
Invoke-WebRequest "$base/bootstrap.mjs" -OutFile $boot -UseBasicParsing
$env:ALBUS_UPDATE_URL = $base
$env:ALBUS_HOME = $home2
node $boot
if ($LASTEXITCODE) { throw 'Installation fehlgeschlagen (siehe Meldung oben).' }
Write-Host ''
Write-Host 'Fertig. Oeffne http://127.0.0.1:4777/ - dort legst du deine Wallet und deine Freundesliste an.' -ForegroundColor Green
Start-Process 'http://127.0.0.1:4777/'
