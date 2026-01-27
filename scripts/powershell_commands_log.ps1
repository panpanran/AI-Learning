# PowerShell commands executed during project setup and helpful commands
# This file is a log / cookbook — it does NOT contain your secrets.

# Firewall rules to allow Vite and backend ports (execute as admin if necessary):
# New-NetFirewallRule -DisplayName "Vite 5173" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow
# New-NetFirewallRule -DisplayName "AI Learning Backend 4000" -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow

# View node processes (helpful when cleaning up stray servers):
# Get-Process node | Format-Table Id,ProcessName,CPU,StartTime -AutoSize

# Kill a process by PID (example):
# taskkill /PID 7608 /F

# Set environment variables (user-level, persistent). Replace PLACEHOLDER with your actual key.
# setx OPENAI_API_KEY "PLACEHOLDER_OPENAI_KEY"
# setx OPENAI_MODEL "gpt-4.1-mini"
# setx PINECONE_API_KEY "PLACEHOLDER_PINECONE_KEY"
# setx PINECONE_ENVIRONMENT "us-west1-gcp"
# setx PINECONE_INDEX_NAME "your-index-name"

# To set env vars for current session only (do NOT persist):
# $env:OPENAI_API_KEY = "PLACEHOLDER_OPENAI_KEY"
# $env:PINECONE_API_KEY = "PLACEHOLDER_PINECONE_KEY"

# Helpful: Use the included script to interactively set the env vars (no secrets are stored in repo):
# .\set_openai_env.ps1
# If you prefer to write keys to a local .env.local (visible locally only), run:
# .\write_env_local.ps1  # Will write .env.local at repo root; ensure .env.local is in .gitignore
