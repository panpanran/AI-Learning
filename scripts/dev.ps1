<#
.SYNOPSIS
  One-command local debugging for Max AI Learning.

.DESCRIPTION
  Runs everything needed to debug locally:
    1. Loads ..\.env.local (same file the backend reads)
    2. Verifies Postgres (DATABASE_URL) connectivity
    3. Verifies Pinecone (PINECONE_API_KEY / PINECONE_INDEX_NAME) connectivity
    4. Verifies OpenAI key presence
    5. Frees ports 8001 / 4000 / 5173 and starts:
         - Python agents  -> http://localhost:8001
         - Express backend -> http://localhost:4000
         - Vite frontend   -> http://localhost:5173
    6. Waits for health endpoints and prints a summary

.EXAMPLE
  .\scripts\dev.ps1              # full run: checks + start everything
  .\scripts\dev.ps1 -CheckOnly   # only run DB / Pinecone / OpenAI checks
  .\scripts\dev.ps1 -SkipChecks  # start services without connectivity checks
  .\scripts\dev.ps1 -SkipAgents  # start only backend + frontend
#>

[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$SkipChecks,
    [switch]$SkipAgents,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$RepoRoot    = Split-Path $PSScriptRoot -Parent
$BackendDir  = Join-Path $RepoRoot 'backend'
$FrontendDir = Join-Path $RepoRoot 'frontend'
$AgentsDir   = Join-Path $RepoRoot 'agents'
$EnvLocal    = Join-Path (Split-Path $RepoRoot -Parent) '.env.local'   # backend reads this exact file

$AgentsPort   = 8001
$BackendPort  = 4000
$FrontendPort = 5173

function Write-Title([string]$t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Write-Ok([string]$t)    { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Write-Bad([string]$t)   { Write-Host "  [FAIL] $t" -ForegroundColor Red }
function Write-Warn2([string]$t) { Write-Host "  [WARN] $t" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# 1. Load .env.local into this process so checks can use the same values
# ---------------------------------------------------------------------------
$EnvVars = @{}
function Import-DotEnv {
    Write-Title "Load env: $EnvLocal"
    if (-not (Test-Path $EnvLocal)) {
        Write-Warn2 ".env.local not found - backend will miss DATABASE_URL / API keys"
        return
    }
    Get-Content $EnvLocal | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { return }
        $key = $line.Substring(0, $idx).Trim()
        $val = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
        if ($val -ne '') { $EnvVars[$key] = $val }
    }
    Write-Ok ("loaded {0} variables" -f $EnvVars.Count)
}

# ---------------------------------------------------------------------------
# 2. Connectivity checks (DB / Pinecone / OpenAI)
# ---------------------------------------------------------------------------
function Test-Postgres {
    Write-Title 'Check Postgres (DATABASE_URL)'
    $url = $EnvVars['DATABASE_URL']
    if (-not $url) { Write-Bad 'DATABASE_URL not set in .env.local'; return $false }

    # Reuse backend's pg driver for a real SELECT 1 round-trip
    $js = @"
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DEV_DB_URL, ssl: process.env.DEV_DB_URL.includes('localhost') ? false : { rejectUnauthorized: false } });
c.connect()
  .then(() => c.query('SELECT current_database() AS db, version() AS v'))
  .then(r => { console.log('DB_OK ' + r.rows[0].db); return c.end(); })
  .catch(e => { console.error('DB_ERR ' + e.message); process.exit(1); });
"@
    if (-not (Test-Path (Join-Path $BackendDir 'node_modules\pg'))) {
        Write-Warn2 "backend/node_modules missing 'pg' - run npm install in backend first; skipping DB check"
        return $false
    }
    $env:DEV_DB_URL = $url
    Push-Location $BackendDir
    try {
        $out = & node -e $js 2>&1
        if ($LASTEXITCODE -eq 0 -and "$out" -match 'DB_OK (.+)') {
            Write-Ok "connected to database '$($Matches[1])'"
            return $true
        }
        Write-Bad "connection failed: $out"
        return $false
    } finally {
        Pop-Location
        Remove-Item Env:\DEV_DB_URL -ErrorAction SilentlyContinue
    }
}

function Test-Pinecone {
    Write-Title 'Check Pinecone'
    $key   = $EnvVars['PINECONE_API_KEY']
    $index = $EnvVars['PINECONE_INDEX_NAME']
    if (-not $key)   { Write-Bad 'PINECONE_API_KEY not set';   return $false }
    if (-not $index) { Write-Bad 'PINECONE_INDEX_NAME not set'; return $false }
    try {
        $resp = Invoke-RestMethod -Uri "https://api.pinecone.io/indexes/$index" `
                    -Headers @{ 'Api-Key' = $key; 'X-Pinecone-API-Version' = '2024-07' } `
                    -Method GET -TimeoutSec 20
        Write-Ok ("index '{0}' status={1} host={2}" -f $index, $resp.status.state, $resp.host)
        return $true
    } catch {
        Write-Bad "Pinecone check failed: $($_.Exception.Message)"
        return $false
    }
}

function Test-OpenAIKey {
    Write-Title 'Check OpenAI'
    if (-not $EnvVars['OPENAI_API_KEY']) {
        Write-Warn2 'OPENAI_API_KEY not set - AI question generation will be disabled'
        return $false
    }
    $model = if ($EnvVars['OPENAI_MODEL']) { $EnvVars['OPENAI_MODEL'] } else { 'default' }
    Write-Ok ("OPENAI_API_KEY present (model: {0})" -f $model)
    return $true
}

# ---------------------------------------------------------------------------
# 3. Start services
# ---------------------------------------------------------------------------
function Stop-PortListener([int]$Port) {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.OwningProcess -gt 0) {
            Write-Host "  freeing port $Port (PID $($_.OwningProcess))" -ForegroundColor Gray
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
}

function Ensure-Deps([string]$Dir, [string]$Label) {
    if ($SkipInstall) { return }
    if (-not (Test-Path (Join-Path $Dir 'node_modules'))) {
        Write-Host "  installing $Label deps..." -ForegroundColor Gray
        Push-Location $Dir; try { npm install } finally { Pop-Location }
    }
}

function Start-All {
    Write-Title 'Start services'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js not found (need Node 20+)' }

    Ensure-Deps $BackendDir 'backend'
    Ensure-Deps $FrontendDir 'frontend'

    Stop-PortListener $AgentsPort
    Stop-PortListener $BackendPort
    Stop-PortListener $FrontendPort

    if (-not $SkipAgents) {
        if (Get-Command python -ErrorAction SilentlyContinue) {
            $agentsCmd = "Set-Location '$AgentsDir'; python -m uvicorn app.main:app --host 127.0.0.1 --port $AgentsPort"
            Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $agentsCmd)
            Start-Sleep -Seconds 2
        } else {
            Write-Warn2 'python not found - skipping agents service'
        }
    }

    $backendCmd  = "Set-Location '$BackendDir'; npm run dev"
    $frontendCmd = "Set-Location '$FrontendDir'; `$env:VITE_BACKEND_URL='http://localhost:$BackendPort'; npm run dev"
    Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $backendCmd)
    Start-Sleep -Seconds 1
    Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $frontendCmd)
}

function Wait-Healthy([string]$Label, [string]$Url, [int]$TimeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -TimeoutSec 5 -UseBasicParsing
            Write-Ok "$Label -> $Url ($($r.StatusCode))"
            return $true
        } catch { Start-Sleep -Seconds 2 }
    }
    Write-Bad "$Label not responding at $Url after ${TimeoutSec}s (check its window for errors)"
    return $false
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
Import-DotEnv

if (-not $SkipChecks) {
    $dbOk = Test-Postgres
    $pcOk = Test-Pinecone
    Test-OpenAIKey | Out-Null
    if ($CheckOnly) {
        Write-Host ''
        if ($dbOk -and $pcOk) { Write-Host 'All connectivity checks passed.' -ForegroundColor Green }
        else { Write-Host 'Some checks failed - see above.' -ForegroundColor Yellow }
        return
    }
    if (-not $dbOk) { Write-Warn2 'Database unreachable - backend will start but DB routes will fail.' }
    if (-not $pcOk) { Write-Warn2 'Pinecone unreachable - vector search / dedupe will fail.' }
} elseif ($CheckOnly) {
    Write-Warn2 '-CheckOnly and -SkipChecks together do nothing.'
    return
}

Start-All

Write-Title 'Waiting for services'
if (-not $SkipAgents) { Wait-Healthy 'agents' "http://localhost:$AgentsPort/health" | Out-Null }
Wait-Healthy 'backend'  "http://localhost:$BackendPort/api/meta/grades" | Out-Null
Wait-Healthy 'frontend' "http://localhost:$FrontendPort" | Out-Null

Write-Host ''
Write-Host 'Local debug environment ready:' -ForegroundColor Green
Write-Host "  Frontend : http://localhost:$FrontendPort"
Write-Host "  Backend  : http://localhost:$BackendPort"
if (-not $SkipAgents) { Write-Host "  Agents   : http://localhost:$AgentsPort/health" }
Write-Host "  DB       : $(if ($EnvVars['DATABASE_URL']) { ($EnvVars['DATABASE_URL'] -replace '://.*@', '://***@') } else { '(not set)' })"
Write-Host "  Pinecone : index '$($EnvVars['PINECONE_INDEX_NAME'])'"
Write-Host ''
Write-Host "Stop everything: .\scripts\projectstart.ps1 -Action stop" -ForegroundColor Gray
