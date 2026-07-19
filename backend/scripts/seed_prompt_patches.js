'use strict';

/**
 * Seed prompt_patches from observed diagnostic feedback patterns.
 * Idempotent: skips rows that already have the same scope + patch_text.
 *
 * Usage (from backend/):
 *   node scripts/seed_prompt_patches.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.local') });
const { Pool } = require('pg');
const { ensureFeedbackTables } = require('../lib/feedbackStore');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
});

// Based on current Art (grade 2 / subject 5) feedback:
// - KP 377 Critique repeatedly failed on distractor_quality (near-synonyms,
//   stem-echo options, loosely related art terms that are not strong wrong answers).
const PATCHES = [
    {
        scope: 'global',
        scope_id: 'all',
        patch_text:
            'Distractors must be clearly incorrect for the question. Never use near-synonyms of the correct answer, and never reuse wording from the question stem as an option.',
    },
    {
        scope: 'global',
        scope_id: 'all',
        patch_text:
            'Prefer a short concrete scenario over a definition-only question when testing applied understanding. Keep explanations to one sentence.',
    },
    {
        scope: 'grade_subject',
        scope_id: '2:5',
        patch_text:
            'For Visual Arts MCQs, distractors should be plausible art terms that are wrong for THIS specific question—not loosely related vocabulary from elsewhere in the art curriculum.',
    },
    {
        scope: 'grade_subject',
        scope_id: '2:5',
        patch_text:
            'Do not ask the student to look at a picture or artwork image. Describe visual features in text only.',
    },
    {
        scope: 'knowledge_point',
        scope_id: '377',
        patch_text:
            'Critique questions must test judgment/evaluation of artistic choices (mood, effect, technique fit), not mere identification of elements or techniques.',
    },
    {
        scope: 'knowledge_point',
        scope_id: '377',
        patch_text:
            'For Critique mood/effect questions, avoid distractors that are near-synonyms of the correct answer (e.g. Exciting vs Energetic). Each wrong option must be clearly a different judgment.',
    },
];

async function main() {
    await ensureFeedbackTables(pool);

    let inserted = 0;
    let skipped = 0;
    for (const p of PATCHES) {
        const existing = await pool.query(
            `SELECT id FROM prompt_patches
             WHERE scope = $1 AND scope_id = $2 AND patch_text = $3
             LIMIT 1`,
            [p.scope, p.scope_id, p.patch_text]
        );
        if (existing.rows.length) {
            skipped += 1;
            console.log(`skip  [${p.scope}/${p.scope_id}] (already exists)`);
            continue;
        }
        await pool.query(
            `INSERT INTO prompt_patches (scope, scope_id, patch_text, active)
             VALUES ($1, $2, $3, TRUE)`,
            [p.scope, p.scope_id, p.patch_text]
        );
        inserted += 1;
        console.log(`add   [${p.scope}/${p.scope_id}] ${p.patch_text.slice(0, 80)}...`);
    }

    console.log(`\nDone. inserted=${inserted} skipped=${skipped}`);
    console.log('Verify with: node scripts/feedback_report.js --kp 377');
}

main()
    .catch((e) => {
        console.error('seed_prompt_patches failed:', e.message || e);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
