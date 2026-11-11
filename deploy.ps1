# Builds the Docker images locally, ships them to the Hetzner server, and starts them
# there - avoids building on the low-RAM server. Run from the repo root in
# PowerShell after `git push`ing your changes.
# Requires a local .env (see .env.example) - its values are baked into the build
# via --build-arg.
#
# Usage: .\deploy.ps1          (Basis-Images aus Cache)
#        .\deploy.ps1 -Pull    (zusaetzlich Basis-Images aktualisieren)
#        .\deploy.ps1 -Force   (auch deployen, wenn das Image unveraendert ist)

param([switch]$Pull, [switch]$Force)

$ErrorActionPreference = "Stop"
$sw = [Diagnostics.Stopwatch]::StartNew()

$ServerUser = "root"
$ServerHost = $env:DEPLOY_HOST
if (-not $ServerHost) { throw "Set `$env:DEPLOY_HOST to the server address (see DEPLOYMENT.md)." }
$ServerPath = "/opt/albus-crypto"
$Images     = @("albus-chain:latest", "albus-web:latest")
$BuildArgs  = @("VITE_ALBUS_API_URL")

# Same script on Windows and Linux: $env:IDENTITY_FILE wins, otherwise the
# first key that exists in ~/.ssh.
$SshKey = $env:IDENTITY_FILE
if (-not $SshKey) {
    $SshKey = @("id_rsa") |
        ForEach-Object { Join-Path (Join-Path $HOME ".ssh") $_ } |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1
}
if (-not $SshKey) { throw "No SSH key found in ~/.ssh (set `$env:IDENTITY_FILE)." }

# BatchMode: fail instead of hanging on a prompt. Keepalive: survive long uploads.
$SshOpts = @("-i", $SshKey, "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30")
$Target  = "${ServerUser}@${ServerHost}"
$IsWin   = $IsWindows -or ($env:OS -eq "Windows_NT")

function Invoke-Step {
    param([string]$Description, [scriptblock]$Command)
    $t = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "==> $Description" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✘ Failed: $Description (exit code $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
    Write-Host ("    done in {0:n1}s" -f $t.Elapsed.TotalSeconds) -ForegroundColor DarkGray
}

# Raw byte pipe: PowerShell 5.1 would corrupt binary data in its own pipeline.
function Invoke-RawPipeline([string]$Pipeline) {
    if ($IsWin) { cmd /c $Pipeline } else { sh -c $Pipeline }
}

# --- .env -> process env (docker build doesn't read .env on its own) ---------
if (-not (Test-Path ".env")) {
    Write-Host "✘ .env not found - copy .env.example to .env and fill in the values first." -ForegroundColor Red
    exit 1
}
Get-Content ".env" | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"]*)"?\s*$') {
        Set-Item -Path "env:$($Matches[1])" -Value $Matches[2]
    }
}
$missing = $BuildArgs | Where-Object { -not (Test-Path "env:$_") }
if ($missing) { Write-Host "✘ Missing in .env: $($missing -join ', ')" -ForegroundColor Red; exit 1 }

# --- 1. Code ----------------------------------------------------------------
Invoke-Step "Pulling latest code" { git pull --ff-only }

# --- 2. Build ---------------------------------------------------------------
Invoke-Step "Building chain image" {
    $env:DOCKER_BUILDKIT = "1"
    $argv = @()
    if ($Pull) { $argv += "--pull" }
    docker build @argv -t albus-chain:latest ./chain
}
Invoke-Step "Building web image" {
    $argv = @()
    if ($Pull) { $argv += "--pull" }
    foreach ($n in $BuildArgs) { $argv += @("--build-arg", $n) }
    docker build @argv -t albus-web:latest ./web
}
# --- 3. Deploy (skip the upload if the server already has this image) --------
$localId = ((docker image inspect @Images --format "{{.Id}}") | Out-String).Trim()
$remoteId = ""
if (-not $Force) {
    $remoteId = ((ssh @SshOpts $Target "docker image inspect $($Images -join ' ') --format '{{.Id}}' 2>/dev/null") | Out-String).Trim()
}

if (-not $Force -and $localId -and $localId -eq $remoteId) {
    Invoke-Step "Image unchanged - syncing server and applying compose only" {
        ssh @SshOpts $Target "cd $ServerPath && git pull -q --ff-only && docker compose up -d"
    }
} else {
    Invoke-Step "Deploying to server" {
        # Streams the image straight into the server's Docker daemon over SSH
        # (compressed with ssh -C, no temp .tar). --force-recreate is required:
        # a mutable tag like `:latest` pointing at new content does not change
        # the resolved compose config. The git pull on the server runs first,
        # so a failed pull aborts before anything is replaced; prune clears the dangling
        # previous layers.
        $remoteCmd = "cd $ServerPath && git pull -q --ff-only && docker load -q && docker compose up -d --force-recreate && docker image prune -f"
        Invoke-RawPipeline "docker save $($Images -join ' ') | ssh -C -i `"$SshKey`" -o BatchMode=yes -o ServerAliveInterval=30 $Target `"$remoteCmd`""
    }
}

Write-Host ("==> Done in {0:n0}s - https://albus.workflowsolved.com" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
