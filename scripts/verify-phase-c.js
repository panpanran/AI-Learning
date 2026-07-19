'use strict';

/**
 * Phase C verification: worker modules + optional agents /v1/diagnostic/run.
 * Usage: node scripts/verify-phase-c.js
 */

const path = require('path');
const crypto = require('crypto');
require(path.join(__dirname, '..', 'backend', 'node_modules', 'dotenv')).config({
    path: path.resolve(__dirname, '..', '..', '.env.local'),
});

const { buildKnowledgePointIdsPlan } = require('../backend/lib/knowledgePointPlanner');
const {
    computeQuestionContentOptionsHash,
    uniqueByContentOptionsHash,
} = require('../backend/lib/questionDedupeWorker');

const BASE = String(process.env.AGENTS_SERVICE_URL || 'http://localhost:8001').replace(/\/$/, '');

async function main() {
    const results = { ok: true, steps: [] };

    function step(name, pass, detail) {
        results.steps.push({ name, pass, detail });
        if (!pass) results.ok = false;
        console.log(pass ? `[PASS] ${name}` : `[FAIL] ${name}`, detail || '');
    }

    const plan = await buildKnowledgePointIdsPlan({
        knowledgePoints: [{ id: 1 }, { id: 2 }, { id: 3 }],
        desiredCount: 5,
        useDb: false,
    });
    step('planner returns 5 slots', plan.length === 5, JSON.stringify(plan));
    step('planner uses known ids', plan.every((id) => [1, 2, 3].includes(id)), plan.join(','));

    const q1 = {
        content_en: 'Test?',
        options: { en: ['A', 'B', 'C', 'D'], zh: ['甲', '乙', '丙', '丁'] },
    };
    const h = computeQuestionContentOptionsHash(q1.content_en, q1.options.en);
    step('dedupe hash stable', h.length === 64, h.slice(0, 16) + '...');
    const unique = uniqueByContentOptionsHash([q1, { ...q1 }]);
    step('dedupe unique by hash', unique.length === 1, String(unique.length));

    if (!process.env.OPENAI_API_KEY) {
        step('agents diagnostic run', true, 'skipped (no OPENAI_API_KEY)');
        console.log('\nSummary:', results.ok ? 'ALL PASSED (partial)' : 'SOME FAILED');
        process.exit(results.ok ? 0 : 1);
    }

    try {
        const health = await fetch(`${BASE}/health`);
        if (!health.ok) throw new Error('agents not running');
        const res = await fetch(`${BASE}/v1/diagnostic/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                num_questions: 1,
                kp_list: [{
                    id: 1,
                    name_cn: '光合作用',
                    name_en: 'Photosynthesis',
                    description: 'Plants convert light to chemical energy',
                }],
                lang: 'en',
                student_profile: { id: 1, grade: 'G5', subject: 'Science' },
                grade_guidance: 'Stay within elementary science scope.',
                feedback_context: {},
                use_db_planner: false,
                check_db_hashes: false,
                persist: false,
                enable_refine: false,
            }),
        });
        const body = await res.json();
        step('POST /v1/diagnostic/run', res.ok && body.run_id, `status=${body.status} questions=${(body.questions || []).length}`);
        step('planner rationale', Boolean(body.plan_rationale), body.plan_rationale || '');
    } catch (err) {
        step('agents diagnostic run', false, err.message);
    }

    console.log('\nSummary:', results.ok ? 'ALL PASSED' : 'SOME FAILED');
    process.exit(results.ok ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
