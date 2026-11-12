# Alles neu bauen und pruefen: Knoten-Tests, Webseite und Mining-Programme parallel, danach das signierte Release. Kein git, kein Deploy der Webseite.
#   .\rebuild-all.ps1                         nur testen und bauen (Knoten, Webseite, Mining-Programme), KEIN Release
#   .\rebuild-all.ps1 -Version 0.2.1 -Notes "Was ist neu"   zusaetzlich signiertes Release nach release-out\
#   .\rebuild-all.ps1 -Version 0.2.1 -Notes "..." -Upload    Release danach auf den Server hochladen (Ordner, bootstrap/install, ZULETZT manifest.json)
#   .\rebuild-all.ps1 -SkipNative             Mining-Programme nicht neu bauen (Release dann mit -NoBinaries, wenn keine .exe da sind)
#   .\rebuild-all.ps1 -KeepComments           Kommentare im Code nicht entfernen
#   .\rebuild-all.ps1 -KeepNodeModules        node_modules nach erfolgreichem Lauf behalten (sonst geloescht; bei Fehler bleiben sie)
#   -KeyFile                                  Standard: %USERPROFILE%\albus-geheim\albus-release.key (nie im Repo)
# Webseite und Mining-Programme brauchen einander nicht und laufen darum gleichzeitig; die Ausgabe erscheint live mit Praefix [web] / [native].
# Die Webseite selbst wird weiter mit .\deploy.ps1 ausgeliefert (nach commit/push durch dich).
param(
    [string]$Version,
    [string]$Notes,
    [string]$KeyFile = (Join-Path $env:USERPROFILE 'albus-geheim\albus-release.key'),
    [switch]$Upload,
    [switch]$SkipNative,
    [switch]$KeepComments,
    [switch]$KeepNodeModules
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if ($Version -and -not $Notes) { throw 'Zu -Version gehoert -Notes "Was ist neu".' }
if ($Upload -and -not $Version) { throw '-Upload braucht -Version und -Notes.' }

if (-not $KeepComments) {
    $removeComments = Join-Path $PSScriptRoot '..\..\remove-comments-from-file.ps1'
    if (-not (Test-Path -LiteralPath $removeComments)) { throw "Fehlt: $removeComments" }
    $excludeDirs = @('node_modules', 'target', '.next', '.git', 'dist', 'build', 'out', 'coverage', '.turbo', '.cache', '.vite',
        '.svelte-kit', '.output', 'vendor', 'release-out', 'releases', 'AlbusCrypto', 'fresh-worker', 'presentation', 'docs', '__pycache__', 'venv', '.venv')
    Write-Host '==> Kommentare entfernen' -ForegroundColor Cyan
    & $removeComments -Path $PSScriptRoot -ExcludeDirs $excludeDirs
}

function Step($text, [scriptblock]$block) {
    Write-Host "==> $text" -ForegroundColor Cyan
    & $block
    if ($LASTEXITCODE -ne 0) { throw "Fehlgeschlagen: $text (Exit $LASTEXITCODE)" }
}
function Need-Install($dir) {
    $bin = Join-Path $dir 'node_modules\.bin'
    -not ((Test-Path $bin) -and (Get-ChildItem $bin -ErrorAction SilentlyContinue))
}

# Der Wallet-Test im Knoten importiert die Wallet der Webseite und braucht deren node_modules (@noble/curves)
if (Need-Install 'web') { Push-Location web; try { Step 'web: npm ci' { npm ci } } finally { Pop-Location } }

# Knoten: Installation, Tests, Typpruefung (zuerst, damit kaputter Code nie in ein Release kommt)
Push-Location chain
try {
    if (Need-Install '.') { Step 'chain: npm ci' { npm ci } }
    Step 'chain: Tests' { npm test }
    Step 'chain: Typecheck' { npx tsc --noEmit -p . }
} finally { Pop-Location }

# Webseite und Mining-Programme gleichzeitig
Write-Host '==> Webseite und Mining-Programme parallel' -ForegroundColor Cyan
$dir = $PSScriptRoot
$defs = @(
    @{ Name = 'web'; Args = @('-Command', 'Set-Location web; if (-not ((Test-Path node_modules\.bin) -and (Get-ChildItem node_modules\.bin))) { npm ci; if ($LASTEXITCODE) { exit $LASTEXITCODE } }; npm run build; exit $LASTEXITCODE') }
)
if (-not $SkipNative) {
    $defs += @{ Name = 'native'; Args = @('-File', "$dir\fresh-worker\build.ps1", '-Test') }
    $defs += @{ Name = 'linux'; Args = @('-File', "$dir\fresh-worker\build-linux.ps1") }
}
$jobs = $defs | ForEach-Object {
    Start-Job -Name $_.Name -ArgumentList $_.Args, $dir -ScriptBlock {
        param($a, $dir)
        Set-Location $dir
        & pwsh -NoProfile @a 2>&1 | ForEach-Object { "$_" }
        "__EXIT__$LASTEXITCODE"
    }
}
$exit = @{}
while ($jobs | Where-Object { $_.State -eq 'Running' -or $_.HasMoreData }) {
    foreach ($j in $jobs) {
        foreach ($line in @(Receive-Job $j)) {
            if ($line -match '^__EXIT__(\d+)$') { $exit[$j.Name] = [int]$Matches[1] }
            elseif ($line.Trim()) { Write-Host "[$($j.Name)] $line" }
        }
    }
    Start-Sleep -Milliseconds 300
}
$jobs | Remove-Job -Force
$failed = @($defs | ForEach-Object { $_.Name } | Where-Object { $exit[$_] -ne 0 })
if ($failed) { Write-Host "FEHLGESCHLAGEN: $($failed -join ', ')" -ForegroundColor Red; exit 1 }

# Release
if ($Version) {
    if (-not (Test-Path $KeyFile)) { throw "Schluessel fehlt: $KeyFile" }
    $relArgs = @('-File', "$dir\local\release.ps1", '-Version', $Version, '-Notes', $Notes, '-KeyFile', $KeyFile)
    if ($SkipNative) { $relArgs += '-NoBinaries' }
    Step "Release $Version bauen und signieren" { pwsh -NoProfile @relArgs }

    if ($Upload) {
        $hostName = $env:DEPLOY_HOST
        if (-not $hostName) { throw 'Setze $env:DEPLOY_HOST (siehe DEPLOYMENT.md).' }
        $key = if ($env:IDENTITY_FILE) { $env:IDENTITY_FILE } else { Join-Path $HOME '.ssh\id_rsa' }
        $ssh = @('-i', $key, '-o', 'BatchMode=yes')
        $t = "root@$hostName"
        $remote = '/opt/albus-crypto/releases'
        $out = Join-Path $dir 'release-out'
        Step 'Upload: Ordner anlegen' { ssh @ssh $t "mkdir -p $remote" }
        Step "Upload: Ordner $Version" { scp @ssh -r (Join-Path $out $Version) "${t}:$remote/" }
        Step 'Upload: Installer (Miner und Farm)' { scp @ssh (Join-Path $out 'bootstrap.mjs') (Join-Path $out 'install-albus.ps1') (Join-Path $out 'farm-bootstrap.mjs') (Join-Path $out 'install-farm.ps1') "${t}:$remote/" }
        Step 'Upload: manifest.json (zuletzt)' { scp @ssh (Join-Path $out 'manifest.json') "${t}:$remote/" }
    }
}

if (-not $KeepNodeModules) {
    Write-Host '==> node_modules loeschen' -ForegroundColor Cyan
    Remove-Item chain\node_modules, web\node_modules -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host ''
if ($Version) { Write-Host "FERTIG: Release $Version liegt in release-out$(if ($Upload) { ' und auf dem Server' })." -ForegroundColor Green }
else { Write-Host 'FERTIG: alles getestet und gebaut (kein Release).' -ForegroundColor Green }
Write-Host 'Naechste Schritte: committen/pushen, dann .\deploy.ps1 fuer die Webseite.' -ForegroundColor Yellow
