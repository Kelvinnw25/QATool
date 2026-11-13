<#
.SYNOPSIS
  Brings public QATOOL staging up with one command.

.DESCRIPTION
  Starts the Docker stack (backend, Apayee, monitoring dashboard, Cloudflare Quick Tunnel), reuses a working
  tunnel or creates a new one, verifies it reaches the protected backend, and, only when the tunnel address
  changed, updates VITE_API_BASE_URL for Production in the Vercel project "qatool-staging" and deploys it.

  Run from anywhere:   .\scripts\start-qatool.ps1

  Safe to run again at any time: a healthy stack, a working tunnel and an up-to-date frontend are left alone.
  Nothing secret is read, printed or stored. Stop with  .\scripts\stop-qatool.ps1

.PARAMETER ForceTunnel
  Make a new tunnel even if the running one works (a new address, so Vercel is updated too).

.PARAMETER ForceDeploy
  Deploy the frontend even if it already uses the current tunnel address.

.PARAMETER NoDeploy
  Do everything except the Vercel step (the public page may then point at an older tunnel).

.NOTES
  If PowerShell refuses to run scripts:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  Documentation: docs/STAGING_DEPLOYMENT.md
#>
[CmdletBinding()]
param(
    [switch]$ForceTunnel,
    [switch]$ForceDeploy,
    [switch]$NoDeploy
)

$ErrorActionPreference = 'Stop'

# The repository root is the parent of this script's folder, wherever the command was typed.
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host 'FAILED: Node.js was not found on PATH. Install Node.js 22 (winget install OpenJS.NodeJS.LTS) and open a new terminal.' -ForegroundColor Red
    exit 1
}
$version = [version](& node -p 'process.versions.node')
if ($version -lt [version]'22.13.0') {
    Write-Host "FAILED: Node.js $version is too old; 22.13 or newer is required." -ForegroundColor Red
    exit 1
}

$arguments = @()
if ($ForceTunnel) { $arguments += '--force-tunnel' }
if ($ForceDeploy) { $arguments += '--force-deploy' }
if ($NoDeploy)    { $arguments += '--no-deploy' }

& node (Join-Path $root 'scripts\staging\start.js') @arguments
exit $LASTEXITCODE
