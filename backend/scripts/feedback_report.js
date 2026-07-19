'use strict';

/**
 * Feedback report — inspect the Ragas/judge feedback loop per knowledge point.
 *
 * Usage (from backend/):
 *   node scripts/feedback_report.js                 # summary of all KPs with feedback
 *   node scripts/feedback_report.js --kp 12         # detail for knowledge_point_id 12
 *   node scripts/feedback_report.js --kp 12 --limit 10
 *   node scripts/feedback_report.js --runs          # recent diagnostic_runs batches
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.local') });

const { Pool } = require('pg');

function arg(name, fallback = null) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
}

const kpId = arg('kp') ? Number(arg('kp')) : null;
const limit = Number(arg('limit', 5)) || 5;
const showRuns = process.argv.includes('--runs');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
});

function fmtScores(scores) {
    if (!scores || typeof scores !== 'object') return '-';
    return Object.entries(scores)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
        .join(' ');
}

async function summary() {
    const r = await pool.query(`
        SELECT qf.knowledge_point_id,
               COALESCE(kp.name_en, kp.name_cn, '?') AS kp_name,
               COUNT(*) FILTER (WHERE qf.label = 'positive') AS positive,
               COUNT(*) FILTER (WHERE qf.label = 'negative') AS negative,
               COUNT(*) FILTER (WHERE qf.label = 'neutral')  AS neutral,
               COUNT(*) FILTER (WHERE qf.used_in_prompt_at IS NOT NULL) AS used_in_prompt,
               MAX(qf.created_at) AS last_feedback_at
        FROM question_feedback qf
        LEFT JOIN knowledge_points kp ON kp.id = qf.knowledge_point_id
        GROUP BY qf.knowledge_point_id, kp.name_en, kp.name_cn
        ORDER BY MAX(qf.created_at) DESC
        LIMIT 50`);
    if (!r.rows.length) {
        console.log('No feedback rows yet. Generate some questions first (diagnostic or practice).');
        return;
    }
    console.log('Feedback summary by knowledge point (latest 50):\n');
    console.log('  kp_id | name                            | pos | neg | neu | used | last_feedback');
    console.log('  ------+---------------------------------+-----+-----+-----+------+---------------------');
    for (const row of r.rows) {
        console.log(
            `  ${String(row.knowledge_point_id ?? '?').padStart(5)} | ` +
            `${String(row.kp_name).slice(0, 31).padEnd(31)} | ` +
            `${String(row.positive).padStart(3)} | ${String(row.negative).padStart(3)} | ${String(row.neutral).padStart(3)} | ` +
            `${String(row.used_in_prompt).padStart(4)} | ` +
            `${row.last_feedback_at ? new Date(row.last_feedback_at).toISOString().slice(0, 19) : '-'}`
        );
    }
    console.log('\nTip: node scripts/feedback_report.js --kp <id> for details.');
}

async function detail(id) {
    const kp = await pool.query(
        'SELECT id, name_cn, name_en FROM knowledge_points WHERE id = $1', [id]);
    const kpName = kp.rows[0] ? (kp.rows[0].name_en || kp.rows[0].name_cn) : '(unknown KP)';
    console.log(`Knowledge point ${id}: ${kpName}\n`);

    for (const label of ['positive', 'negative']) {
        const r = await pool.query(`
            SELECT id, run_id, scores, judge_reasons, critique, question_snapshot,
                   used_in_prompt_at, created_at
            FROM question_feedback
            WHERE knowledge_point_id = $1 AND label = $2
            ORDER BY created_at DESC
            LIMIT $3`, [id, label, limit]);

        console.log(`--- ${label.toUpperCase()} (${r.rows.length} most recent, limit ${limit}) ---`);
        if (!r.rows.length) console.log('  (none)');
        for (const row of r.rows) {
            const snap = row.question_snapshot || {};
            const q = (snap.content_en || snap.content_cn || '').slice(0, 100);
            console.log(`  #${row.id}  ${new Date(row.created_at).toISOString().slice(0, 19)}`);
            console.log(`    question : ${q}`);
            console.log(`    scores   : ${fmtScores(row.scores)}`);
            if (row.critique && row.critique.issues) {
                console.log(`    critique : ${row.critique.issues.join(', ')}`);
            }
            if (row.judge_reasons && Object.keys(row.judge_reasons).length) {
                const first = Object.entries(row.judge_reasons)[0];
                console.log(`    reason   : [${first[0]}] ${String(first[1]).slice(0, 140)}`);
            }
            console.log(`    used_in_prompt: ${row.used_in_prompt_at ? new Date(row.used_in_prompt_at).toISOString().slice(0, 19) : 'no'}`);
        }
        console.log('');
    }

    const patches = await pool.query(`
        SELECT pp.scope, pp.scope_id, pp.patch_text, pp.active, pp.created_at
        FROM prompt_patches pp
        WHERE pp.active = TRUE
          AND (
            pp.scope = 'global'
            OR (pp.scope = 'knowledge_point' AND pp.scope_id = $1)
            OR (
              pp.scope = 'grade_subject'
              AND pp.scope_id = (
                SELECT gs.grade_id::text || ':' || gs.subject_id::text
                FROM knowledge_points kp
                JOIN grade_subjects gs ON gs.id = kp.grade_subject_id
                WHERE kp.id = $2
              )
            )
          )
        ORDER BY
          CASE pp.scope
            WHEN 'knowledge_point' THEN 1
            WHEN 'grade_subject' THEN 2
            ELSE 3
          END,
          pp.created_at DESC
        LIMIT 20`, [String(id), id]);
    console.log(`--- PROMPT PATCHES (${patches.rows.length}) ---`);
    if (!patches.rows.length) console.log('  (none — run: node scripts/seed_prompt_patches.js)');
    for (const p of patches.rows) {
        console.log(`  [${p.scope}/${p.scope_id}] active=${p.active} ${String(p.patch_text).slice(0, 160)}`);
    }
}

async function recentRuns() {
    const r = await pool.query(`
        SELECT id, user_id, grade_id, subject_id, lang, status, batch_scores, created_at
        FROM diagnostic_runs ORDER BY created_at DESC LIMIT ${Math.min(20, limit * 2)}`);
    console.log('Recent diagnostic_runs:\n');
    for (const row of r.rows) {
        console.log(`  ${new Date(row.created_at).toISOString().slice(0, 19)}  status=${row.status}  grade=${row.grade_id} subject=${row.subject_id} lang=${row.lang}`);
        console.log(`    batch: ${fmtScores(row.batch_scores)}`);
    }
}

(async () => {
    try {
        if (showRuns) await recentRuns();
        else if (Number.isInteger(kpId)) await detail(kpId);
        else await summary();
    } catch (e) {
        console.error('feedback_report failed:', e.message || e);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
