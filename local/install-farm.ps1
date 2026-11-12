# Albus Farm-Rechner oder Server als Miner einrichten (Linux oder Windows, nur PowerShell 7).
# Der Rechner schuerft fuer DEINE Wallet-Adresse. Der private Schluessel wird hier nicht gebraucht und bleibt auf deinem Haupt-PC.
#   pwsh -c "irm https://albus.workflowsolved.com/releases/install-farm.ps1 -OutFile install-farm.ps1"
#   pwsh -File install-farm.ps1 -Address albus1... -Name Server-1
# Erneut ausfuehren = Update (die Dateien werden wieder mit der festen Unterschrift geprueft).
# Linux: als root (sudo) ausfuehren, dann laeuft der Miner als Dienst "albus-farm" und startet nach jedem Neustart von selbst.
# Windows: als Administrator ausfuehren, dann entsteht die Aufgabe "AlbusFarm".
param(
    [string]$Address = $env:ALBUS_ADDRESS,
    [string]$Name = $env:ALBUS_NAME,
    [int]$Threads = 0,
    [int]$Duty = 100,
    [string]$Dir,
    [string]$ChainWs = $env:ALBUS_CHAIN_WS,
    [switch]$NoService,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$base = if ($env:ALBUS_RELEASES) { $env:ALBUS_RELEASES.TrimEnd('/') } else { 'https://albus.workflowsolved.com/releases' }
$onWin = $IsWindows -or $env:OS -eq 'Windows_NT'
if (-not $Dir) { $Dir = if ($onWin) { Join-Path $env:ProgramData 'AlbusFarm' } elseif ((id -u) -eq '0') { '/opt/albus-farm' } else { Join-Path $HOME 'albus-farm' } }
$isAdmin = if ($onWin) { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } else { (id -u) -eq '0' }

function Stop-Farm {
    if ($onWin) { Stop-ScheduledTask -TaskName AlbusFarm -ErrorAction SilentlyContinue; Get-Process albus-cpu -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dir*" } | Stop-Process -Force -ErrorAction SilentlyContinue }
    elseif (Get-Command systemctl -ErrorAction SilentlyContinue) { systemctl stop albus-farm 2>$null }
}

if ($Uninstall) {
    Stop-Farm
    if ($onWin) { Unregister-ScheduledTask -TaskName AlbusFarm -Confirm:$false -ErrorAction SilentlyContinue }
    elseif (Get-Command systemctl -ErrorAction SilentlyContinue) { systemctl disable albus-farm 2>$null; Remove-Item /etc/systemd/system/albus-farm.service -ErrorAction SilentlyContinue; systemctl daemon-reload }
    Write-Host "Dienst entfernt. Der Ordner $Dir bleibt liegen, du kannst ihn loeschen."
    return
}

if (-not $Address) { $Address = Read-Host 'Adresse deiner Wallet (albus1...)' }
$Address = $Address.Trim().ToLower()
if ($Address -notmatch '^albus1[0-9a-f]{40}$') { throw 'Das ist keine gueltige Albus-Adresse (albus1 und 40 Zeichen 0-9 a-f). Du findest sie oben in der Miner-Oberflaeche auf deinem Haupt-PC.' }
if (-not $Name) { $Name = [Environment]::MachineName }
$Name = ($Name -replace '[^\p{L}\p{N} ._-]', '').Trim()
if (-not $Name) { $Name = 'farm' }
if ($Threads -le 0) { $Threads = [Environment]::ProcessorCount }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 20 oder neuer fehlt. Linux: z. B. "sudo apt install nodejs" (oder https://nodejs.org). Windows: "winget install OpenJS.NodeJS.LTS". Danach dieses Skript noch einmal starten.' }
$major = [int](((& node -v) -replace '^v', '') -split '\.')[0]
if ($major -lt 20) { throw "Node.js $major ist zu alt, gebraucht wird 20 oder neuer." }

New-Item -ItemType Directory -Force $Dir | Out-Null
Stop-Farm
$boot = Join-Path $Dir 'farm-bootstrap.mjs'
Write-Host "Lade das Installationsprogramm von $base ..."
Invoke-WebRequest "$base/farm-bootstrap.mjs" -OutFile $boot -UseBasicParsing
$env:ALBUS_UPDATE_URL = $base
& node $boot --dir $Dir
if ($LASTEXITCODE) { throw 'Installation fehlgeschlagen (siehe Meldung oben).' }

$agent = Join-Path $Dir 'agent.mjs'
$agentArgs = @($agent, '--address', $Address, '--name', $Name, '--threads', "$Threads", '--duty', "$Duty")
if ($ChainWs) { $agentArgs += @('--chain-ws', $ChainWs) }
$nodePath = $node.Source

if ($NoService -or -not $isAdmin) {
    Write-Host ''
    if (-not $NoService) { Write-Host 'Ohne Administratorrechte (root) wird kein Dienst angelegt.' -ForegroundColor Yellow }
    Write-Host 'Von Hand starten mit:'
    $q = [char]34
    $shown = ($agentArgs | ForEach-Object { if ($_ -match '\s') { $q + $_ + $q } else { $_ } }) -join ' '
    Write-Host ("  " + $q + $nodePath + $q + " " + $shown) -ForegroundColor Green
    return
}

if ($onWin) {
    $action = New-ScheduledTaskAction -Execute $nodePath -Argument (($agentArgs | ForEach-Object { "`"$_`"" }) -join ' ') -WorkingDirectory $Dir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
    Register-ScheduledTask -TaskName AlbusFarm -Action $action -Trigger $trigger -Settings $set -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    Start-ScheduledTask -TaskName AlbusFarm
} else {
    if (-not (Get-Command systemctl -ErrorAction SilentlyContinue)) { throw 'systemctl nicht gefunden. Starte den Miner von Hand (siehe oben) oder mit -NoService.' }
    $exec = ('"' + $nodePath + '" ' + (($agentArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '))
    $unit = @"
[Unit]
Description=Albus farm miner ($Name)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$Dir
ExecStart=$exec
Restart=always
RestartSec=10
Nice=10

[Install]
WantedBy=multi-user.target
"@
    Set-Content -Path /etc/systemd/system/albus-farm.service -Value $unit -Encoding utf8NoBOM
    systemctl daemon-reload
    systemctl enable --now albus-farm
}
Write-Host ''
Write-Host "Fertig. Der Rechner '$Name' schuerft jetzt fuer $Address." -ForegroundColor Green
Write-Host 'In wenigen Sekunden taucht er in der Miner-Oberflaeche auf deinem Haupt-PC unter "Your farm and servers" auf.'
if (-not $onWin) { Write-Host 'Log ansehen: journalctl -u albus-farm -f' }
