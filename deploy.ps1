# Builds both Docker images locally, ships them to the Hetzner server, and starts
# them there — avoids building on the low-RAM server. Run from the repo root in
# PowerShell. Same pattern as ../guess-pw/deploy.ps1.
#
# Requires a local .env (see .env.example) with VITE_ALBUS_API_URL — Vite bakes
# it into the client bundle at build time, so it's passed as --build-arg here
# rather than shipped as runtime env on the server.
#
# Usage: .\deploy.ps1

$ErrorActionPreference = "Stop"

$ServerUser  = "root"
$ServerHost  = "89.167.25.230"
$ServerPath  = "/opt/albus-crypto"
$ChainImage  = "albus-chain:latest"
$WebImage    = "albus-web:latest"
$EnvFile     = ".env"

function Invoke-Step {
    param([string]$Description, [scriptblock]$Command)
    Write-Host "==> $Description" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✘ Failed: $Description (exit code $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

if (-not (Test-Path $EnvFile)) {
    Write-Host "✘ $EnvFile not found — copy .env.example to $EnvFile and fill in real values first." -ForegroundColor Red
    exit 1
}

$envVars = @{}
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"]*)"?\s*$') {
        $envVars[$matches[1]] = $matches[2]
    }
}

if (-not $envVars.ContainsKey("VITE_ALBUS_API_URL") -or [string]::IsNullOrWhiteSpace($envVars["VITE_ALBUS_API_URL"])) {
    Write-Host "✘ VITE_ALBUS_API_URL missing or empty in $EnvFile" -ForegroundColor Red
    exit 1
}

Invoke-Step "Pulling latest code" { git pull }

Invoke-Step "Building chain image" {
    # --pull refreshes base layers so a stale local cache doesn't silently
    # skip security patches.
    docker build --pull -t $ChainImage ./chain
}
Invoke-Step "Building web image" {
    docker build --pull --build-arg VITE_ALBUS_API_URL=$($envVars["VITE_ALBUS_API_URL"]) -t $WebImage ./web
}

Invoke-Step "Deploying to server" {
    # Streams both images in one tar straight into the server's Docker
    # daemon over SSH — no local .tar files and no separate scp hop.
    # `docker image prune -f` clears the now-dangling previous `:latest`
    # layers so repeated deploys don't slowly fill the server's disk.
    docker save $ChainImage $WebImage | ssh "${ServerUser}@${ServerHost}" "cd $ServerPath && git pull && docker load && docker compose up -d --force-recreate && docker image prune -f"
}

Write-Host "==> Done — https://albus.workflowsolved.com" -ForegroundColor Green
