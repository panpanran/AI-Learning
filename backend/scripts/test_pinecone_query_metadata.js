// Quick manual smoke-test for /api/pinecone/query-metadata
// Usage: node scripts/test_pinecone_query_metadata.js

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

async function postJson(path, body, { headers } = {}) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(headers || {}),
        },
        body: JSON.stringify(body),
    });

    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = { raw: text };
    }

    if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText} for ${path}`);
        err.details = json;
        throw err;
    }

    return json;
}

async function main() {
    const baseUsername = process.env.USERNAME || 'pinecone_query_test_user';
    const password = process.env.PASSWORD || 'test123';

    let token;
    try {
        const login = await postJson('/auth/mock-login', {
            username: baseUsername,
            password,
            mode: 'login',
        });
        token = login.token;
    } catch {
        const username = `${baseUsername}_${Date.now()}`;
        const register = await postJson('/auth/mock-login', {
            username,
            password,
            mode: 'register',
        });
        token = register.token;
    }

    if (!token) throw new Error('No token returned from /auth/mock-login');

    const metadata = {
        context: 'clear reasoning for addition',
        nums: [9, 6],
        type: 'addition',
    };

    const compareMode = (process.env.COMPARE_MODE || '').trim() || 'pinecone';
    const candidateLimit = process.env.CANDIDATE_LIMIT ? Number(process.env.CANDIDATE_LIMIT) : undefined;
    const gradeId = process.env.GRADE_ID ? Number(process.env.GRADE_ID) : 3;
    const subjectId = process.env.SUBJECT_ID ? Number(process.env.SUBJECT_ID) : 1;
    const knowledgePointId = process.env.KNOWLEDGE_POINT_ID ? Number(process.env.KNOWLEDGE_POINT_ID) : undefined;

    const resp = await postJson(
        '/api/pinecone/query-metadata',
        {
            topK: 5,
            metadata,
            includeQuestionRows: true,
            compareMode,
            grade_id: gradeId,
            subject_id: subjectId,
            ...(Number.isFinite(knowledgePointId) ? { knowledge_point_id: knowledgePointId } : {}),
            ...(Number.isFinite(candidateLimit) ? { candidateLimit } : {}),
        },
        { headers: { Authorization: `Bearer ${token}` } },
    );

    const matches = Array.isArray(resp.matches) ? resp.matches : [];
    const unexpectedKeys = [];

    for (const m of matches) {
        if (m && Object.prototype.hasOwnProperty.call(m, 'question_metadata')) {
            unexpectedKeys.push('question_metadata');
            break;
        }
        if (m && Object.prototype.hasOwnProperty.call(m, 'question_metadata_text_preview')) {
            unexpectedKeys.push('question_metadata_text_preview');
            break;
        }
    }

    console.log(
        JSON.stringify(
            {
                ok: true,
                topK: resp.topK,
                returnedMatches: matches.length,
                sampleMatchKeys: matches[0] ? Object.keys(matches[0]) : [],
                hasUnexpectedKeys: unexpectedKeys.length > 0,
                unexpectedKeys,
            },
            null,
            2,
        ),
    );

    if (unexpectedKeys.length > 0) {
        process.exitCode = 2;
    }
}

main().catch((e) => {
    console.error(e.message);
    if (e.details) console.error(JSON.stringify(e.details, null, 2));
    process.exitCode = 1;
});
