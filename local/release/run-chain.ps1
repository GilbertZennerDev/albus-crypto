# Startet den Knoten dieser Version mit den Daten ausserhalb des Versionsordners.
param([string]$Node, [string]$Root, [string]$State)
$env:DATA_DIR = Join-Path $State 'chain-data'
Set-Location (Join-Path $Root 'chain')
& $Node 'index.mjs'
