# Local testnet: 3 Albus nodes on 127.0.0.1:4101-4103, separate data directories, test values only.
# A and B mine themselves (CPU miner), C does not mine and follows A.
# Flow: connect -> same tip -> disconnect (A/B keep mining apart, the chains diverge)
#       -> reconnect -> reorg -> all three share the same tip -> restart C -> still the same.
# Touches neither port 4000 nor an installed AlbusChain task nor any real chain data.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path dist\index.js)) { npm run build | Out-Null }

$ports = @{ A = 4101; B = 4102; C = 4103 }
$addr = @{
  A = 'albus1' + ('a' * 40)
  B = 'albus1' + ('b' * 40)
  C = 'albus1' + ('c' * 40)
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('albus-testnet-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root | Out-Null
$procs = @{}
$fail = 0

function Url($n) { "http://127.0.0.1:$($ports[$n])" }
function Info($n) { Invoke-RestMethod -Uri "$(Url $n)/info" -TimeoutSec 3 }
function Check($ok, $text) {
  if ($ok) { Write-Host "  OK   $text" -ForegroundColor Green } else { Write-Host "  FAIL $text" -ForegroundColor Red; $script:fail++ }
}

function Start-Node($n, $peers, $mine) {
  $dir = Join-Path $root $n
  $env:PORT = "$($ports[$n])"; $env:HOST = '127.0.0.1'; $env:DATA_DIR = $dir
  $env:PEERS = $peers; $env:P2P_PUBLIC_URL = "ws://127.0.0.1:$($ports[$n])/p2p"
  $env:INITIAL_DIFFICULTY = '192'; $env:RETARGET_TAU_MS = '1e15'; $env:P2P_ALLOW_PRIVATE = '1'
  $env:MINER_ADDRESS = $addr[$n]; $env:CPU_MINE_THROTTLE_MS = '100'
  if ($mine) { $env:CPU_MINE = '1' } else { Remove-Item Env:CPU_MINE -ErrorAction SilentlyContinue }
  $procs[$n] = Start-Process node -ArgumentList 'dist/index.js' -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $root "$n.out.log") -RedirectStandardError (Join-Path $root "$n.err.log")
  for ($i = 0; $i -lt 40; $i++) {
    try { Info $n | Out-Null; return } catch { Start-Sleep -Milliseconds 250 }
  }
  throw "Node $n does not start (see $root\$n.err.log)"
}

function Stop-Node($n) {
  if ($procs[$n] -and -not $procs[$n].HasExited) { Stop-Process -Id $procs[$n].Id -Force }
}

function Wait-Until($seconds, [scriptblock]$cond) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  return $false
}

function Same-Tip { $t = 'A', 'B', 'C' | ForEach-Object { (Info $_).tip } | Select-Object -Unique; @($t).Count -eq 1 }

try {
  Write-Host "Data directory: $root"
  Write-Host "1) Start nodes: A and B mine, B knows A, C knows A"
  Start-Node 'A' '' $true
  Start-Node 'B' "ws://127.0.0.1:$($ports.A)/p2p" $true
  Start-Node 'C' "ws://127.0.0.1:$($ports.A)/p2p" $false
  $ia = Info 'A'; $ib = Info 'B'; $ic = Info 'C'
  Check ($ia.genesis -eq $ib.genesis -and $ib.genesis -eq $ic.genesis) "all three have the same genesis ($($ia.genesis.Substring(0, 12))...)"
  Check ($ia.networkId -eq $ib.networkId) "same networkId $($ia.networkId)"

  Write-Host "2) Wait for the same tip at height >= 6"
  $ok = Wait-Until 90 { (Same-Tip) -and ((Info 'C').height -ge 6) }
  Check $ok "A, B, C share the same tip (height $((Info 'C').height)) although C never mines"
  Check ((Info 'A').peers -ge 2) "A sees at least 2 peers ($((Info 'A').peers))"

  Write-Host "3) Disconnect: restart A and B without a link, each keeps mining alone"
  Stop-Node 'B'; Stop-Node 'C'; Stop-Node 'A'
  Start-Sleep -Seconds 1
  # peers.json persists, so remove the files -> really disconnected
  Remove-Item (Join-Path $root 'A\peers.json'), (Join-Path $root 'B\peers.json') -ErrorAction SilentlyContinue
  Start-Node 'A' '' $true
  Start-Node 'B' '' $true
  $h0 = (Info 'A').height
  $ok = Wait-Until 120 { ((Info 'A').height -ge $h0 + 4) -and ((Info 'B').height -ge $h0 + 5) }
  $ia = Info 'A'; $ib = Info 'B'
  Check $ok "A height $($ia.height), B height $($ib.height) (both grow alone)"
  Check ($ia.tip -ne $ib.tip) "the chains diverged (different tips)"
  $heavier = if ([bigint]$ia.totalWork -ge [bigint]$ib.totalWork) { 'A' } else { 'B' }
  $balA = (Invoke-RestMethod "$(Url 'A')/balance/$($addr.A)").balance

  Write-Host "4) Connect: B learns about A -> the heavier chain must win"
  Invoke-RestMethod -Method Post -Uri "$(Url 'B')/p2p/peers" -ContentType 'application/json' `
    -Body (@{ url = "ws://127.0.0.1:$($ports.A)/p2p" } | ConvertTo-Json) | Out-Null
  Start-Node 'C' "ws://127.0.0.1:$($ports.A)/p2p" $false
  # both keep mining -> tips move; "same tip" means the same tip at the same moment
  $ok = Wait-Until 60 { Same-Tip }
  Check $ok "after connecting, A, B, C share the same tip again"
  $ia = Info 'A'; $ib = Info 'B'
  Check ($ia.height -ge $h0 + 4) "height $($ia.height) (nothing lost that the winning chain had)"

  Write-Host "5) Supply adds up: supply = height * 10 ALB"
  # the nodes keep mining: only compare a snapshot where the height is the same before and after reading
  $consistent = $false
  for ($try = 0; $try -lt 20 -and -not $consistent; $try++) {
    $h1 = (Info 'C').height
    $s = Invoke-RestMethod "$(Url 'C')/supply"
    $h2 = (Info 'C').height
    $consistent = ($h1 -eq $h2)
  }
  Check ($consistent -and $s.circulatingSupply -eq ($h2 * 10)) "supply $($s.circulatingSupply) ALB at height $h2 (no premine, no faucet)"
  $f = $null
  try { Invoke-RestMethod -Method Post -Uri "$(Url 'A')/faucet" | Out-Null } catch { $f = $_.Exception.Response.StatusCode.value__ }
  Check ($f -eq 410) "faucet is off (HTTP $f)"

  Write-Host "6) Restart C: the chain comes from disk (fully re-validated) and stays the same"
  Stop-Node 'A'; Stop-Node 'B'
  $before = (Info 'C').tip
  Stop-Node 'C'; Start-Sleep -Seconds 1
  Start-Node 'C' '' $false
  Check ((Info 'C').tip -eq $before) "C has the same tip after the restart"
}
finally {
  foreach ($n in 'A', 'B', 'C') { Stop-Node $n }
  Write-Host ''
  if ($fail -eq 0) {
    Write-Host 'TESTNET: all passed' -ForegroundColor Green
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "TESTNET: $fail failure(s), logs in $root" -ForegroundColor Red
  }
}
exit $fail
