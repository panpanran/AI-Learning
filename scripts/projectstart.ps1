<#
.SYNOPSIS
  Max AI Learning - local dev & Render deploy helper.

.DESCRIPTION
  Actions:
    menu    Interactive menu (default)
    local   Start backend + frontend + Python agents locally (three PowerShell windows)
    docker  Start via docker compose (hot reload)
    deploy  Push to GitHub and trigger Render deploy hooks
    stop    Stop local processes on ports 4000 / 5173 / 8001
    status  Check local + production health

.EXAMPLE
  .\scripts\projectstart.ps1
  .\scripts\projectstart.ps1 -Action local
  .\scripts\projectstart.ps1 -Action deploy -CommitMessage "fix diagnostic"
#>

[CmdletBinding()]
param(
    [ValidateSet('menu', 'local', 'docker', 'deploy', 'stop', 'status')]
    [string]$Action = 'menu',

    [string]$CommitMessage = '',

    [switch]$SkipGitPush,

    [switch]$SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- Paths (repo root = maxailearning) ---
$RepoRoot    = Split-Path $PSScriptRoot -Parent
$BackendDir  = Join-Path $RepoRoot 'backend'
$FrontendDir = Join-Path $RepoRoot 'frontend'
$AgentsDir   = Join-Path $RepoRoot 'agents'
$AgentsPort  = 8001
$EnvLocal    = Join-Path (Split-Path $RepoRoot -Parent) '.env.local'
$ComposeFile = Join-Path $RepoRoot 'docker-compose.yml'

# --- Render (production) ---
$RenderFrontendUrl        = 'https://www.maxaionline.org'
$RenderBackendUrl         = 'https://ai-learning-backend-vm34.onrender.com'
$RenderBackendUrlAlt      = 'https://ai-learning-car8.onrender.com'
$RenderFrontendServiceId  = 'srv-d5sjua7fte5s73cdo90g'
$RenderBackendServiceId   = 'srv-d5slfi49c44c739chmv0'
$RenderFrontendDashboard  = "https://dashboard.render.com/static/$RenderFrontendServiceId"
$RenderBackendDashboard   = "https://dashboard.render.com/web/$RenderBackendServiceId"

# Deploy hooks are OPTIONAL (git push already triggers Render). Set in .env.local if you want manual trigger.
$RenderBackendDeployHook  = $env:RENDER_BACKEND_DEPLOY_HOOK
$RenderFrontendDeployHook = $env:RENDER_FRONTEND_DEPLOY_HOOK

function Write-Title([string]$Text) {
    Write-Host ''
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Write-Info([string]$Text) {
    Write-Host $Text -ForegroundColor Gray
}

function Test-CommandExists([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Load-DeployHooksFromEnvFile {
    if (-not (Test-Path $EnvLocal)) { return }
    Get-Content $EnvLocal | ForEach-Object {
        $line = $_.Trim()
        if ($line -match '^\s*#' -or $line -eq '') { return }
        if ($line -match '^RENDER_BACKEND_DEPLOY_HOOK=(.+)$') {
            if (-not $RenderBackendDeployHook) { $script:RenderBackendDeployHook = $Matches[1].Trim().Trim('"').Trim("'") }
        }
        if ($line -match '^RENDER_FRONTEND_DEPLOY_HOOK=(.+)$') {
            if (-not $RenderFrontendDeployHook) { $script:RenderFrontendDeployHook = $Matches[1].Trim().Trim('"').Trim("'") }
        }
        if ($line -match '^RENDER_FRONTEND_URL=(.+)$') {
            $script:RenderFrontendUrl = $Matches[1].Trim().Trim('"').Trim("'")
        }
        if ($line -match '^RENDER_BACKEND_URL=(.+)$') {
            $script:RenderBackendUrl = $Matches[1].Trim().Trim('"').Trim("'")
        }
        if ($line -match '^RENDER_BACKEND_SERVICE_ID=(.+)$') {
            $script:RenderBackendServiceId = $Matches[1].Trim().Trim('"').Trim("'")
            $script:RenderBackendDashboard = "https://dashboard.render.com/web/$($script:RenderBackendServiceId)"
        }
        if ($line -match '^RENDER_FRONTEND_SERVICE_ID=(.+)$') {
            $script:RenderFrontendServiceId = $Matches[1].Trim().Trim('"').Trim("'")
            $script:RenderFrontendDashboard = "https://dashboard.render.com/static/$($script:RenderFrontendServiceId)"
        }
    }
}

function Stop-PortListener([int]$Port) {
    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($c in $conns) {
        $processId = $c.OwningProcess
        if ($processId -and $processId -gt 0) {
            Write-Info "Stopping PID $processId on port $Port"
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Ensure-NpmDependencies([string]$Dir, [string]$Label) {
    if ($SkipInstall) { return }
    $nm = Join-Path $Dir 'node_modules'
    if (Test-Path $nm) { return }
    Write-Info "Installing $Label dependencies..."
    Push-Location $Dir
    try { npm install } finally { Pop-Location }
}

function Ensure-PythonAgentsDependencies {
    if ($SkipInstall) { return }
    if (-not (Test-Path (Join-Path $AgentsDir 'requirements.txt'))) {
        throw "Missing agents/requirements.txt"
    }
    Write-Info 'Ensuring Python agents dependencies...'
    Push-Location $AgentsDir
    try {
        & python -m pip install -r requirements.txt -q
        if ($LASTEXITCODE -ne 0) { throw 'pip install failed for agents (is Python 3.10+ installed?)' }
    } finally {
        Pop-Location
    }
}

function Start-LocalServices {
    Write-Title "Local dev - agents :$AgentsPort + backend :4000 + frontend :5173"

    if (-not (Test-CommandExists 'node')) { throw 'Node.js not found. Install Node 20+ first.' }
    if (-not (Test-CommandExists 'npm'))  { throw 'npm not found.' }
    if (-not (Test-CommandExists 'python')) { throw 'Python not found. Install Python 3.10+ for agents service.' }

    Ensure-NpmDependencies $BackendDir  'backend'
    Ensure-NpmDependencies $FrontendDir 'frontend'
    Ensure-PythonAgentsDependencies

    if (-not (Test-Path $EnvLocal)) {
        Write-Host "Warning: $EnvLocal not found. Backend may miss DATABASE_URL / API keys." -ForegroundColor Yellow
    }

    Stop-PortListener $AgentsPort
    Stop-PortListener 4000
    Stop-PortListener 5173

    $agentsCmd = "Set-Location '$AgentsDir'; python -m uvicorn app.main:app --host 127.0.0.1 --port $AgentsPort"
    $backendCmd  = "Set-Location '$BackendDir'; npm run dev"
    $frontendCmd = "Set-Location '$FrontendDir'; `$env:VITE_BACKEND_URL='http://localhost:4000'; npm run dev"

    Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $agentsCmd)
    Start-Sleep -Seconds 2
    Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $backendCmd)
    Start-Sleep -Seconds 1
    Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $frontendCmd)

    Write-Host ''
    Write-Host 'Started in new windows:' -ForegroundColor Green
    Write-Host "  Agents   -> http://localhost:$AgentsPort/health"
    Write-Host '  Backend  -> http://localhost:4000'
    Write-Host '  Frontend -> http://localhost:5173'
    Write-Host ''
    Write-Host "Env file: $EnvLocal"
    Write-Host 'Agents mode: set AGENTS_SERVICE_URL=http://localhost:8001 in .env.local (backend loads on start)' -ForegroundColor Gray
}

function Start-DockerServices {
    Write-Title 'Docker dev - docker compose up'

    if (-not (Test-CommandExists 'docker')) { throw 'Docker not found. Install Docker Desktop first.' }
    if (-not (Test-Path $ComposeFile)) { throw "Missing $ComposeFile" }

    Push-Location $RepoRoot
    try {
        docker compose up --build
    } finally {
        Pop-Location
    }
}

function Invoke-RenderDeployHook([string]$Label, [string]$HookUrl) {
    if ([string]::IsNullOrWhiteSpace($HookUrl)) {
        $hookVar = "RENDER_${Label}_DEPLOY_HOOK"
        Write-Host "  [$Label] No deploy hook configured - skip (set $hookVar)" -ForegroundColor Yellow
        return $false
    }
    Write-Info "  [$Label] POST deploy hook..."
    try {
        $resp = Invoke-WebRequest -Uri $HookUrl -Method POST -TimeoutSec 120 -UseBasicParsing
        Write-Host "  [$Label] Triggered (HTTP $($resp.StatusCode))" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "  [$Label] Hook failed: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

function Publish-Render {
    Write-Title 'Deploy to Render (GitHub push + deploy hooks)'

    Load-DeployHooksFromEnvFile

    if (-not (Test-CommandExists 'git')) { throw 'git not found.' }

    Push-Location $RepoRoot
    try {
        $branch = (git branch --show-current 2>$null)
        if (-not $branch) { $branch = 'master' }

        Write-Info "Repo: $RepoRoot"
        Write-Info "Branch: $branch"
        Write-Info "Render backend dashboard: $RenderBackendDashboard"
        Write-Info "Render frontend dashboard: $RenderFrontendDashboard"
        Write-Info "Render backend URL: $RenderBackendUrl"
        Write-Info "Render frontend URL: $RenderFrontendUrl"

        git status --short
        Write-Host ''

        if (-not $SkipGitPush) {
            $dirty = git status --porcelain
            if ($dirty) {
                if (-not $CommitMessage) {
                    $CommitMessage = Read-Host 'Enter commit message (or Ctrl+C to cancel)'
                }
                if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
                    throw 'Commit message required when there are uncommitted changes.'
                }
                git add -A
                git commit -m $CommitMessage
            } else {
                Write-Info 'Working tree clean - will push existing commits only.'
            }

            Write-Info "Pushing to origin/$branch ..."
            git push origin $branch
            Write-Host 'Git push done. Render will auto-build connected services.' -ForegroundColor Green
        } else {
            Write-Info 'SkipGitPush set - not pushing to GitHub.'
        }

        Write-Host ''
        Write-Info 'Optional: trigger deploy hooks immediately (in addition to auto-deploy):'
        Invoke-RenderDeployHook 'BACKEND'  $RenderBackendDeployHook  | Out-Null
        Invoke-RenderDeployHook 'FRONTEND' $RenderFrontendDeployHook | Out-Null

        Write-Host ''
        Write-Host 'Production URLs:' -ForegroundColor Green
        Write-Host "  Backend : $RenderBackendUrl"
        if ($RenderFrontendUrl) {
            Write-Host "  Frontend: $RenderFrontendUrl"
        } else {
            Write-Host "  Frontend: (set RENDER_FRONTEND_URL or check dashboard)"
        }
        Write-Host "  Frontend dashboard: $RenderFrontendDashboard"
        Write-Host "  Backend dashboard : $RenderBackendDashboard"

        if (Test-CommandExists 'render') {
            Write-Info 'Render CLI detected - you can also run:'
            Write-Info "  render deploys create --service $RenderFrontendServiceId"
            if ($RenderBackendServiceId) {
                Write-Info "  render deploys create --service $RenderBackendServiceId"
            }
        }
    } finally {
        Pop-Location
    }
}

function Test-ServiceHealth([string]$Label, [string]$Url) {
    try {
        $r = Invoke-WebRequest -Uri $Url -Method GET -TimeoutSec 30 -UseBasicParsing
        Write-Host "  [$Label] OK  $($r.StatusCode)  $Url" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "  [$Label] FAIL $Url - $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

function Show-Status {
    Write-Title 'Health check'

    Write-Host 'Local:'
    $p8001 = (Test-NetConnection -ComputerName 127.0.0.1 -Port $AgentsPort -WarningAction SilentlyContinue).TcpTestSucceeded
    $p4000 = (Test-NetConnection -ComputerName 127.0.0.1 -Port 4000 -WarningAction SilentlyContinue).TcpTestSucceeded
    $p5173 = (Test-NetConnection -ComputerName 127.0.0.1 -Port 5173 -WarningAction SilentlyContinue).TcpTestSucceeded
    Write-Host "  Port $AgentsPort (agents)  : $(if ($p8001) { 'listening' } else { 'closed' })"
    Write-Host "  Port 4000 (backend) : $(if ($p4000) { 'listening' } else { 'closed' })"
    Write-Host "  Port 5173 (frontend): $(if ($p5173) { 'listening' } else { 'closed' })"
    if ($p8001) { Test-ServiceHealth 'local-agents' "http://localhost:$AgentsPort/health" | Out-Null }
    if ($p4000) { Test-ServiceHealth 'local-backend' 'http://localhost:4000/api/meta/grades' | Out-Null }

    Write-Host ''
    Write-Host 'Render (production):'
    Test-ServiceHealth 'render-backend' "$RenderBackendUrl/api/meta/grades" | Out-Null
    if ($RenderBackendUrlAlt -and $RenderBackendUrlAlt -ne $RenderBackendUrl) {
        Test-ServiceHealth 'render-backend-alt' "$RenderBackendUrlAlt/api/meta/grades" | Out-Null
    }
    Test-ServiceHealth 'render-frontend' $RenderFrontendUrl | Out-Null

    Write-Host ''
    Write-Host "Frontend dashboard: $RenderFrontendDashboard"
    Write-Host "Backend dashboard : $RenderBackendDashboard"
}

function Show-HookGuide {
    Write-Title 'Where to find Render Deploy Hook (optional)'
    Write-Host @'
Deploy Hook is NOT required. If your repo is connected to Render, "git push" already deploys.

If you still want a Deploy Hook URL (for script/manual trigger):

  FRONTEND (Static Site - AI-Learning):
    1. Open: https://dashboard.render.com/static/srv-d5sjua7fte5s73cdo90g
    2. Left sidebar click "Settings" (below Events, NOT the Events page)
    3. Scroll down to section "Deploy Hook"
    4. Click "Create Deploy Hook" or copy the existing URL
    5. Paste into .env.local as RENDER_FRONTEND_DEPLOY_HOOK=...

  BACKEND (Web Service):
    1. Open: https://dashboard.render.com/web/srv-d5slfi49c44c739chmv0
    2. Left sidebar click "Settings"
    3. Scroll to "Deploy Hook" -> copy URL
    4. Paste into .env.local as RENDER_BACKEND_DEPLOY_HOOK=...

Quick open dashboards now? (y/n)
'@
    $ans = Read-Host
    if ($ans -eq 'y') {
        Start-Process $RenderFrontendDashboard
        Start-Sleep -Milliseconds 500
        Start-Process $RenderBackendDashboard
    }
}

function Stop-LocalServices {
    Write-Title 'Stop local dev servers'
    Stop-PortListener $AgentsPort
    Stop-PortListener 4000
    Stop-PortListener 5173
    Write-Host "Ports $AgentsPort, 4000 and 5173 cleared." -ForegroundColor Green
}

function Show-Menu {
    Write-Title 'Max AI Learning - projectstart.ps1'
    Write-Host '  1) local   - Start agents + backend + frontend locally (new PowerShell windows)'
    Write-Host '  2) docker  - Start with docker compose (hot reload)'
    Write-Host '  3) deploy  - git push + Render deploy hooks'
    Write-Host '  4) stop    - Stop processes on ports 8001 / 4000 / 5173'
    Write-Host '  5) status  - Health check (local + Render)'
    Write-Host '  6) open    - Open Render dashboards in browser'
    Write-Host '  7) hooks    - Show where to find Deploy Hook (optional)'
    Write-Host '  q) quit'
    $choice = Read-Host 'Choose'
    switch ($choice) {
        '1' { Start-LocalServices }
        '2' { Start-DockerServices }
        '3' { Publish-Render }
        '4' { Stop-LocalServices }
        '5' { Show-Status }
        '6' {
            Start-Process $RenderFrontendDashboard
            Start-Sleep -Milliseconds 500
            Start-Process $RenderBackendDashboard
        }
        '7' { Show-HookGuide }
        'q' { return }
        default {
            Write-Host 'Unknown choice.' -ForegroundColor Yellow
            Show-Menu
        }
    }
}

# --- Main ---
Load-DeployHooksFromEnvFile

switch ($Action) {
    'local'  { Start-LocalServices }
    'docker' { Start-DockerServices }
    'deploy' { Publish-Render }
    'stop'   { Stop-LocalServices }
    'status' { Show-Status }
    'menu'   { Show-Menu }
}
