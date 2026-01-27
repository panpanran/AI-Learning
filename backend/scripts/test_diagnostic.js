// Quick manual smoke-test for /api/generate/diagnostic
// Usage: node scripts/test_diagnostic.js

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

async function postJson(path, body) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
    const baseUsername = process.env.USERNAME || 'diagnostic_test_user';
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

    const diagnostic = await postJson('/api/generate/diagnostic', {
        token,
        numQuestions: 5,
        grade_id: 4,
        subject_id: 2,
        lang: 'en',
    });

    console.log(JSON.stringify(diagnostic, null, 2));
}

main().catch((e) => {
    console.error(e.message);
    if (e.details) console.error(JSON.stringify(e.details, null, 2));
    process.exitCode = 1;
});
