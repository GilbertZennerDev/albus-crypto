# Legt die alte Kette beiseite und startet den Dienst AlbusChain mit den neuen Regeln neu.
#   (Admin-Shell)  pwsh -File C:\Dev\WebApps\AlbusCrypto\local\reset-chain.ps1
# Nichts wird geloescht: blocks.jsonl wird nur umbenannt.
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Bitte in einer Admin-Shell starten.' }
$data = 'D:\app-builder\AlbusCrypto\chain\data'
Unregister-ScheduledTask -TaskName 'AlbusChain' -Confirm:$false -ErrorAction SilentlyContinue
Stop-Service AlbusChain
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($f in 'blocks.jsonl', 'peers.json') {
  $p = Join-Path $data $f
  if (Test-Path $p) { Rename-Item $p "$f.alt-$stamp"; Write-Host "beiseite: $f.alt-$stamp" }
}
Start-Service AlbusChain
for ($i = 0; $i -lt 30; $i++) {
  try { $info = Invoke-RestMethod http://127.0.0.1:4000/info; break } catch { Start-Sleep 1 }
}
if (-not $info) { throw 'Knoten antwortet nicht. Log: C:\ProgramData\Albus\AlbusChain.err.log' }
Write-Host "Node running: height $($info.height), networkId $($info.networkId)"
