$login = Invoke-RestMethod -Uri 'http://localhost:4000/auth/mock-login' -Method Post -ContentType 'application/json' -Body (@{ username = 'panpanr'; password = '123'; mode = 'login' } | ConvertTo-Json)
$token = $login.token

# Optional: set to $null to omit knowledge_point_id entirely
$knowledgePointId = $null

$payload = @{
    metadata            = @{
        # nums    = @(7)
        type    = 'vocabulary'
        context = 'fruit'
        word    = "苹果"
    }

    topK                = 5
    grade_id            = 4
    subject_id          = 2
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

Invoke-RestMethod -Uri 'http://localhost:4000/api/pinecone/query-metadata' `
    -Method Post `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType 'application/json' `
    -Body $body | ConvertTo-Json -Depth 8