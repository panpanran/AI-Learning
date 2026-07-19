'use strict';

/**
 * Phase B verification: agents service health + quality/run endpoint.
 * Usage: node scripts/verify-phase-b.js
 * Requires agents service at AGENTS_SERVICE_URL (default http://localhost:8001).
 */

const path = require('path');
require(path.join(__dirname, '..', 'backend', 'node_modules', 'dotenv')).config({
    path: path.resolve(__dirname, '..', '..', '.env.local'),
});

const BASE = String(process.env.AGENTS_SERVICE_URL || 'http://localhost:8001').replace(/\/$/, '');

const MOCK_QUESTION = {
    type: 'mcq',
    content_en: 'What is photosynthesis?',
    content_cn: '什么是光合作用？',
    answer_en: 'Light conversion',
    answer_cn: '光能转化',
    explanation_en: 'Plants use chlorophyll to capture light and convert it to chemical energy.',
    explanation_cn: '植物利用叶绿素吸收光能并转化为化学能。',
    options: {
        zh: ['光能转化', '呼吸作用', '蒸腾作用', '分解作用'],
        en: ['Light conversion', 'Respiration', 'Transpiration', 'Decomposition'],
    },
    knowledge_point_id: 1,
    metadata: { type: 'vocabulary', word: 'photosynthesis', context: 'biology' },
};

const MOCK_KP = [{
    id: 1,
    name_cn: '光合作用',
    name_en: 'Photosynthesis',
    description: '植物利用光能合成有机物的过程',
}];

async function main() {
    const results = { ok: true, steps: [] };

    function step(name, pass, detail) {
        results.steps.push({ name, pass, detail });
        if (!pass) results.ok = false;
        console.log(pass ? `[PASS] ${name}` : `[FAIL] ${name}`, detail || '');
    }

    step('AGENTS_SERVICE_URL', Boolean(BASE), BASE);

    let health;
    try {
        const res = await fetch(`${BASE}/health`);
        health = await res.json();
        step('GET /health', res.ok && health.status === 'ok', JSON.stringify(health));
    } catch (err) {
        step('GET /health', false, err.message);
        console.log('\nSummary: FAILED (start agents: python -m uvicorn app.main:app --port 8001)');
        process.exit(1);
    }

    try {
        const res = await fetch(`${BASE}/v1/diagnostic/quality/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                questions: [MOCK_QUESTION],
                kp_list: MOCK_KP,
                lang: 'en',
                enable_refine: false,
            }),
        });
        const body = await res.json();
        const hasBatch = Boolean(body.batch_id);
        const hasRows = Array.isArray(body.rows) && body.rows.length === 1;
        const hasRules = hasRows && body.rows[0].rules;
        step('POST /v1/diagnostic/quality/run', res.ok && hasBatch && hasRows, `status=${body.status} batch_id=${body.batch_id}`);
        step('quality rows have rules', hasRules, hasRows ? JSON.stringify(body.rows[0].rules) : 'no rows');
        if (process.env.OPENAI_API_KEY) {
            const hasScores = hasRows && body.rows[0].scores && body.rows[0].scores.kp_alignment != null;
            step('judge scores present', hasScores, hasScores ? JSON.stringify(body.rows[0].scores) : 'skipped or no scores');
        } else {
            step('judge scores present', true, 'skipped (no OPENAI_API_KEY)');
        }
    } catch (err) {
        step('POST /v1/diagnostic/quality/run', false, err.message);
    }

    console.log('\nSummary:', results.ok ? 'ALL PASSED' : 'SOME FAILED');
    process.exit(results.ok ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
