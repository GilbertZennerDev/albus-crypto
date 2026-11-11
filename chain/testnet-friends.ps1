# Probelauf "Friends with Benefits": ein Testnetz-Knoten, ein Neuling, ein Freund.
# Nutzt Port 4150 und einen Temp-Ordner. Das echte Netz und deine Daten bleiben unberuehrt.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("albus-friends-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory $tmp | Out-Null
$port = 4150
$api = "http://127.0.0.1:$port"
$node = $null
function Fail($m) { throw "FEHLER: $m" }
try {
    npx tsx src/new-wallet.ts | Set-Content (Join-Path $tmp "newcomer.json")
    npx tsx src/new-wallet.ts | Set-Content (Join-Path $tmp "friend.json")
    $newcomer = Get-Content (Join-Path $tmp "newcomer.json") -Raw | ConvertFrom-Json
    $friend = Get-Content (Join-Path $tmp "friend.json") -Raw | ConvertFrom-Json
    Write-Host "Neuling: $($newcomer.address)"
    Write-Host "Freund:  $($friend.address)"

    $env:REFERRAL_BPS = "1000"; $env:INITIAL_DIFFICULTY = "12"
    $env:PORT = "$port"; $env:DATA_DIR = Join-Path $tmp "data"

    # 1) Netz-ID ausrechnen (gleiche Regeln wie der Knoten)
    $env:NETWORK_ID = (npx tsx -e "import {Blockchain} from './src/blockchain.ts'; import {paramsFromEnv} from './src/params.ts'; console.log(new Blockchain(paramsFromEnv(), null).networkId)" | Select-Object -Last 1).Trim()
    Write-Host "Netz-ID: $($env:NETWORK_ID)"
    if ($env:NETWORK_ID -eq "5612ab3f9ec5bebf") { Fail "das ist die Haupt-Netz-ID" }

    # 2) Einladung mit dem Schluessel des Neulings
    $env:ALBUS_KEY_FILE = Join-Path $tmp "newcomer.json"; $env:FRIEND = $friend.address
    $invite = (npx tsx src/invite.ts 2>$null | Select-Object -Last 1).Trim()
    if (-not $invite) { Fail "keine Einladung erzeugt" }
    Write-Host "Einladung erzeugt ($($invite.Length) Zeichen)"

    # 3) Knoten mit CPU-Miner und Einladung starten
    $env:CPU_MINE = "1"; $env:MINER_ADDRESS = $newcomer.address; $env:MINER_INVITATION = $invite
    $node = Start-Process -FilePath "npx.cmd" -ArgumentList "tsx", "src/index.ts" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $tmp "node.log") -RedirectStandardError (Join-Path $tmp "node.err")
    $info = $null
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        try { $info = Invoke-RestMethod "$api/info"; if ($info.height -ge 3) { break } } catch {}
    }
    if (-not $info -or $info.height -lt 3) { Fail "Knoten oder Mining laeuft nicht. Siehe $tmp\node.err" }
    Write-Host "Knoten: Hoehe $($info.height), Netz $($info.networkId), referralBps $($info.referralBps)"
    if ($info.networkId -ne $env:NETWORK_ID) { Fail "Netz-ID passt nicht" }
    if ($info.referralBps -ne 1000) { Fail "referralBps fehlt" }

    # 4) Konten pruefen: Freund bekommt 10 %, Neuling 90 %
    $a = Invoke-RestMethod "$api/account/$($friend.address)"
    $b = Invoke-RestMethod "$api/account/$($newcomer.address)"
    Write-Host "Freund: $($a | ConvertTo-Json -Compress)"
    Write-Host "Neuling: $($b | ConvertTo-Json -Compress)"
    $fu = [double]$a.total; $nu = [double]$b.total
    if ($fu -le 0) { Fail "Freund hat nichts bekommen" }
    # Der Knoten schuerft weiter, die zwei Abfragen liegen etwas auseinander: ein paar Bloecke Toleranz
    $slack = 5 * 10 * 1e8
    if ([Math]::Abs($fu * 9 - $nu) -gt $slack) { Fail "Verhaeltnis ist nicht 1 : 9" }
    Write-Host "OK: Freund bekommt genau ein Zehntel, Neuling neun Zehntel."
}
finally {
    if ($node) { Stop-Process -Id $node.Id -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*src/index.ts*" -and $_.CommandLine -like "*albus-crypto*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
