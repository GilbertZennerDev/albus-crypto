# Startet die lokale Oberflaeche dieser Version (nur auf 127.0.0.1).
param([string]$Node, [string]$Root, [string]$State)
$env:ALBUS_HOME = $State
$env:ALBUS_NO_BROWSER = '1'
$env:ALBUS_UI_TASK = '1'
if (-not $env:ALBUS_UPDATE_URL) { $env:ALBUS_UPDATE_URL = 'https://albus.workflowsolved.com/releases' }
Set-Location (Join-Path $Root 'ui')
& $Node 'ui.mjs'
