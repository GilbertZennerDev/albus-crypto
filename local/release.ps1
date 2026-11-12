# Baut ein signiertes Release fuer den Updater. Der private Schluessel liegt NUR bei dir (nie im Repo, nie auf dem Server).
#   pwsh -File local\release.ps1 -Version 0.2.0 -Notes "Freundesliste" -KeyFile C:\geheim\albus-release.key [-BinDir ...] [-Out ...]
# Ergebnis: <Out>\manifest.json und <Out>\<Version>\...  -> beides nach https://albus.workflowsolved.com/releases/ hochladen
#           (zuerst den Ordner <Version>, ZULETZT manifest.json, damit nie ein Manifest ohne Dateien online steht)
param(
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][string]$Notes,
  [Parameter(Mandatory)][string]$KeyFile,
  [string]$Out = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release-out'),
  [string]$BinDir = 'D:\app-builder\AlbusCrypto\fresh-worker\build\bin',
  [switch]$NoBinaries
)
$ErrorActionPreference = 'Stop'
$repo  = Split-Path -Parent $PSScriptRoot
$chain = Join-Path $repo 'chain'
if (-not (Test-Path $KeyFile)) { throw "Schluesseldatei fehlt: $KeyFile (erzeugen: `$env:RELEASE_KEY_FILE='...'; npx tsx src/update/release.ts keygen)" }
if ((Resolve-Path $KeyFile).Path.StartsWith($repo, 'OrdinalIgnoreCase')) { throw 'Der Schluessel darf nicht im Repo liegen.' }
$stage = Join-Path ([IO.Path]::GetTempPath()) ("albus-stage-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force (Join-Path $stage 'chain'), (Join-Path $stage 'ui'), (Join-Path $stage 'scripts'), (Join-Path $stage 'bin') | Out-Null
try {
  Push-Location $chain
  $banner = 'import{createRequire as __cr}from"module";const require=__cr(import.meta.url);'
  # Alles in je EINE Datei, damit kein node_modules mitgeliefert werden muss
  npx esbuild src/index.ts --bundle --platform=node --format=esm --target=node20 "--banner:js=$banner" --outfile="$stage\chain\index.mjs" --log-level=warning
  if ($LASTEXITCODE) { throw 'esbuild (Knoten) fehlgeschlagen' }
  npx esbuild src/ui/main.ts --bundle --platform=node --format=esm --target=node20 "--banner:js=$banner" --outfile="$stage\ui\ui.mjs" --log-level=warning
  if ($LASTEXITCODE) { throw 'esbuild (Oberflaeche) fehlgeschlagen' }
  Pop-Location
  Copy-Item (Join-Path $PSScriptRoot 'release\*.ps1') (Join-Path $stage 'scripts')
  if (-not $NoBinaries) {
    foreach ($f in 'albus-supervisor.exe', 'albus-gpu.exe', 'albus-cpu.exe') {
      $p = Join-Path $BinDir $f
      if (-not (Test-Path $p)) { throw "Fehlt: $p (zuerst fresh-worker\build.ps1 -Test, oder -NoBinaries fuer ein Release ohne Mining-Programme)" }
      Copy-Item $p (Join-Path $stage 'bin')
    }
  }
  $keyFull = (Resolve-Path $KeyFile).Path
  Push-Location $chain
  $env:RELEASE_KEY_FILE = $keyFull
  npx tsx src/update/release.ts build $stage $Out $Version $Notes
  if ($LASTEXITCODE) { throw 'Release bauen fehlgeschlagen' }
  # Erstinstallation: ein einzelnes Programm mit den fest eingebauten Schluesseln (liegt neben dem Manifest, nicht im Release)
  npx esbuild src/update/bootstrap.ts --bundle --platform=node --format=esm --target=node20 "--banner:js=$banner" --outfile="$Out\bootstrap.mjs" --log-level=warning
  if ($LASTEXITCODE) { throw 'esbuild (Bootstrap) fehlgeschlagen' }
  Pop-Location
} finally {
  if ((Get-Location).Path -like "$chain*") { Pop-Location }
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
Copy-Item (Join-Path $PSScriptRoot 'install-albus.ps1') $Out -Force
Write-Host "Fertig: $Out"
