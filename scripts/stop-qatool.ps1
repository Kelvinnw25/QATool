<#
.SYNOPSIS
  Stops the QATOOL staging stack and its public tunnel, deliberately and safely.

.DESCRIPTION
  Runs `docker compose stop`. Containers, networks and every volume (including the Claude sign-in volume
  apayee-claude-config) are kept; .env, the Vercel link and .qatool-local\ are not touched. It never runs
  `down`, `down -v`, `rm` or `prune`.

  Run from anywhere:   .\scripts\stop-qatool.ps1

.PARAMETER TunnelOnly
  Stop only the public tunnel. The Vercel page then says the demo cannot be reached, while the local stack and
  the dashboard keep running.

.NOTES
  Bring everything back with  .\scripts\start-qatool.ps1
#>
[CmdletBinding()]
param(
    [switch]$TunnelOnly
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'FAILED: Node.js was not found on PATH.' -ForegroundColor Red
    exit 1
}

$arguments = @()
if ($TunnelOnly) { $arguments += '--tunnel-only' }

& node (Join-Path $root 'scripts\staging\stop.js') @arguments
exit $LASTEXITCODE
