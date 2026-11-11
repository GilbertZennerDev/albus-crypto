# Builds the native workers. Source of truth stays on E:, the build happens on D:.
#   pwsh -File build.ps1            configure + build
#   pwsh -File build.ps1 -Test      also run the golden-vector runner and the GPU self-test
param([switch]$Test, [switch]$Clean)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dst = 'D:\app-builder\AlbusCrypto\fresh-worker'
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw 'No Visual Studio / Build Tools with the C++ x64 toolset found' }
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'

if ($Clean -and (Test-Path "$dst\build")) { Remove-Item -Recurse -Force "$dst\build" }
robocopy $src $dst /E /XD build /NFL /NDL /NJH /NJS | Out-Null
$cmd = "`"$vcvars`" >nul && cd /d `"$dst`" && cmake --preset release && cmake --build build"
cmd /c $cmd
if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }

if ($Test) {
  $bin = "$dst\build\bin"
  $vec = "$src\tests\golden\vectors.json"
  & "$bin\albus-tests.exe" $vec;      if ($LASTEXITCODE -ne 0) { throw 'CPU golden vectors failed' }
  & "$bin\albus-gpu.exe" --selftest;  if ($LASTEXITCODE -ne 0) { throw 'GPU self-test failed' }
  & "$bin\albus-gpu.exe" --vectors $vec; if ($LASTEXITCODE -ne 0) { throw 'GPU golden vectors failed' }
}
Write-Host "OK: $dst\build\bin"
