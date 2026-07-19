$login = Invoke-RestMethod -Uri 'https://ai-learning-backend-vm34.onrender.com/auth/mock-login' -Method Post -ContentType 'application/json' -Body (@{ username = 'maxpan'; password = '123'; mode = 'login' } | ConvertTo-Json)
$token = $login.token

# Optional: set to $null to omit knowledge_point_id entirely
$knowledgePointId = $null

$payload = @{
    metadata            = @{
        nums    = @(5432，5)
        type    = 'other'
        context = 'place value of digit'
    }

    topK                = 5
    grade_id            = 3
    subject_id          = 1
    includeQuestionRows = $true

    # compareMode:
    # - 'pinecone'     : use Pinecone nearest-neighbor query (default)
    # - 'local_cosine' : fetch candidates from Postgres and compute cosineSimilarity locally
    compareMode         = 'local_cosine'
    candidateLimit      = 800

    # 如果你希望“完全按原始 metadata JSON”去 embed，而不是按系统的 canonical 文本：
    useRawMetadata      = $false
}

if ($null -ne $knowledgePointId) {
    $payload.knowledge_point_id = $knowledgePointId
}

$body = $payload | ConvertTo-Json -Depth 10

Invoke-RestMethod -Uri 'https://ai-learning-backend-vm34.onrender.com/api/pinecone/query-metadata' `
    -Method Post `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType 'application/json' `
    -Body $body | ConvertTo-Json -Depth 8


# Load OPENAI_API_KEY from ../.env.local if not already set (never hardcode keys here).
if (-not $env:OPENAI_API_KEY) {
    $envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env.local'
    if (-not (Test-Path $envFile)) { $envFile = Join-Path $PSScriptRoot '..\.env.local' }
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^\s*OPENAI_API_KEY=(.+)$') {
                $env:OPENAI_API_KEY = $Matches[1].Trim().Trim('"').Trim("'")
            }
        }
    }
}
if (-not $env:OPENAI_API_KEY) {
    throw 'OPENAI_API_KEY not set. Put it in ../.env.local or set the env var before running.'
}
python .\ragas\evaluate_ragas.py --input .\ragas\buffer.jsonl --output .\ragas\ragas_result.json
