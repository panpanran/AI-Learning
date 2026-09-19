/*
  FS-20260919-history-rescore-after-feedback
  Backfill history.correct from current questions.answer_*.

  Usage (from backend/):
    node scripts/rescore_history_from_bank.js
    node scripts/rescore_history_from_bank.js --question-id 2345
*/

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.local') });
const { Pool } = require('pg');
const { rescoreHistoryForQuestion } = require('../lib/userFeedbackTriage');

function argValue(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
    const cs = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
    if (!cs) {
        console.error('Missing DATABASE_URL (or PG_CONNECTION_STRING) in .env.local');
        process.exitCode = 2;
        return;
    }

    const qidArg = argValue('--question-id');
    const qidFilter = qidArg != null ? Number(qidArg) : null;
    if (qidArg != null && !Number.isInteger(qidFilter)) {
        console.error('Invalid --question-id');
        process.exitCode = 2;
        return;
    }

    const pool = new Pool({ connectionString: cs });
    try {
        let questionIds;
        if (Number.isInteger(qidFilter)) {
            questionIds = [qidFilter];
        } else {
            const r = await pool.query(
                `SELECT DISTINCT question_id
                 FROM history
                 WHERE question_id IS NOT NULL
                 ORDER BY question_id`
            );
            questionIds = (r.rows || [])
                .map((row) => Number(row.question_id))
                .filter(Number.isInteger);
        }

        const totals = { questions: 0, updated: 0, correctTrue: 0, correctFalse: 0 };
        for (const qid of questionIds) {
            // eslint-disable-next-line no-await-in-loop
            const out = await rescoreHistoryForQuestion(pool, qid);
            totals.questions += 1;
            totals.updated += out.updated || 0;
            totals.correctTrue += out.correctTrue || 0;
            totals.correctFalse += out.correctFalse || 0;
            if (out.updated) {
                console.log('rescored', qid, out);
            }
        }
        console.log('done', totals);
    } finally {
        await pool.end().catch(() => {});
    }
}

main().catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exitCode = 1;
});
