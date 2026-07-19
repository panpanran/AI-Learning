'use strict';

/**
 * Phase A verification: feedback store logic + DB tables.
 * Usage: node scripts/verify-phase-a.js
 */

const path = require('path');
const crypto = require('crypto');
const backendDir = path.resolve(__dirname, '..', 'backend');
require(path.join(backendDir, 'node_modules', 'dotenv')).config({
    path: path.resolve(__dirname, '..', '..', '.env.local'),
});
const { Pool } = require(path.join(backendDir, 'node_modules', 'pg'));
const {
    labelQuestionRow,
    buildCritique,
    emptyFeedbackContext,
    isFeedbackStoreEnabled,
    persistDiagnosticFeedback,
    getFeedbackContext,
    ensureFeedbackTables,
} = require('../backend/lib/feedbackStore');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
});

async function checkTables() {
    const res = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('diagnostic_runs', 'question_feedback', 'prompt_patches')
         ORDER BY table_name`
    );
    const found = res.rows.map((r) => r.table_name);
    const expected = ['diagnostic_runs', 'prompt_patches', 'question_feedback'];
    const missing = expected.filter((t) => !found.includes(t));
    return { found, missing };
}

async function main() {
    const results = { ok: true, steps: [] };

    function step(name, pass, detail) {
        results.steps.push({ name, pass, detail });
        if (!pass) results.ok = false;
        console.log(pass ? `[PASS] ${name}` : `[FAIL] ${name}`, detail || '');
    }

    step('DIAG_FEEDBACK enabled', isFeedbackStoreEnabled(), `DIAG_FEEDBACK=${process.env.DIAG_FEEDBACK ?? '1'}`);

    const pos = { all_pass: true, scores: { kp_alignment: 0.9, distractor_quality: 0.8 } };
    const neg = {
        all_pass: true,
        scores: { kp_alignment: 0.3 },
        judge_reasons: { kp_alignment: 'tests wrong skill' },
    };
    step('label positive', labelQuestionRow(pos) === 'positive', labelQuestionRow(pos));
    step('label negative', labelQuestionRow(neg) === 'negative', labelQuestionRow(neg));
    step('critique built', Boolean(buildCritique(neg)), JSON.stringify(buildCritique(neg)));

    if (!process.env.DATABASE_URL && !process.env.PG_CONNECTION_STRING) {
        step('database url', false, 'DATABASE_URL not set');
        console.log('\nSummary:', results.ok ? 'PARTIAL (no DB)' : 'FAILED');
        await pool.end();
        process.exit(results.ok ? 0 : 1);
    }

    try {
        await ensureFeedbackTables(pool);
        const { found, missing } = await checkTables();
        step('feedback tables exist', missing.length === 0, `found: ${found.join(', ') || '(none)'}`);
    } catch (err) {
        step('feedback tables exist', false, err.message);
    }

    try {
        const mockAudit = {
            batch_id: crypto.randomUUID(),
            lang: 'en',
            status: 'ok',
            batch: { rule_pass_rate: 1, mean_kp_alignment: 0.3 },
            meta: { userId: 1, gradeId: 1, subjectId: 1 },
            rows: [{
                index: 0,
                knowledge_point_id: 1,
                question: 'Test question?',
                all_pass: true,
                scores: { kp_alignment: 0.3, explanation_support: true, distractor_quality: 0.7 },
                judge_reasons: { kp_alignment: 'verify mock negative pattern' },
                rules: { schema_valid: true },
                rule_failures: [],
            }],
        };
        const mockQuestion = [{
            type: 'mcq',
            content_en: 'Test question?',
            content_cn: '测试题？',
            answer_en: 'A',
            answer_cn: 'A',
            explanation_en: 'Because',
            explanation_cn: '因为',
            options: { zh: ['A', 'B', 'C', 'D'], en: ['A', 'B', 'C', 'D'] },
            knowledge_point_id: 1,
            metadata: { type: 'vocabulary', word: 'test', context: 'verify' },
        }];
        const persisted = await persistDiagnosticFeedback(pool, mockAudit, mockQuestion);
        step('persist mock run', Boolean(persisted && persisted.run_id), persisted && persisted.run_id);

        const ctx = await getFeedbackContext(pool, {
            gradeId: 1,
            subjectId: 1,
            knowledgePointIds: [1],
            lang: 'en',
        });
        const hasAvoid = ctx.avoid_patterns.length > 0;
        step('read avoid_patterns', hasAvoid, JSON.stringify(ctx));

        await pool.query('DELETE FROM question_feedback WHERE run_id = $1', [mockAudit.batch_id]);
        await pool.query('DELETE FROM diagnostic_runs WHERE id = $1', [mockAudit.batch_id]);
    } catch (err) {
        step('persist/read roundtrip', false, err.message);
    }

    await pool.end();
    console.log('\nSummary:', results.ok ? 'ALL PASSED' : 'SOME FAILED');
    process.exit(results.ok ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
