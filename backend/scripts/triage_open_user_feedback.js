/*
  Backfill triage for open user_question_feedback rows.
  FS-20260907-user-feedback-phase2

  Usage (from backend/):
    node scripts/triage_open_user_feedback.js
    node scripts/triage_open_user_feedback.js --limit 20
*/

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.local') });
const OpenAI = require('openai');
const { Pool } = require('pg');
const { triageOpenUserFeedback } = require('../lib/userFeedbackTriage');

async function createChatCompletionJson(aiClient, params) {
    const temperature = (params && Number.isFinite(Number(params.temperature)))
        ? Number(params.temperature)
        : 0;
    const { temperature: _t, ...rest } = (params && typeof params === 'object') ? params : {};
    try {
        return await aiClient.chat.completions.create({
            ...rest,
            temperature,
            response_format: { type: 'json_object' },
        });
    } catch (e) {
        return await aiClient.chat.completions.create({ ...rest, temperature });
    }
}

async function main() {
    const limitArg = process.argv.indexOf('--limit');
    const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : 50;
    const cs = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
    if (!cs) {
        console.error('Missing DATABASE_URL');
        process.exitCode = 2;
        return;
    }
    if (!process.env.OPENAI_API_KEY) {
        console.warn('OPENAI_API_KEY missing — math-only path may still apply; LLM classify skipped.');
    }

    const pool = new Pool({ connectionString: cs });
    const aiClient = process.env.OPENAI_API_KEY
        ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        : null;

    try {
        const results = await triageOpenUserFeedback(pool, {
            aiClient,
            createChatCompletionJson,
        }, { limit: Number.isFinite(limit) ? limit : 50 });

        const counts = {};
        for (const r of results) {
            const k = (r && r.status) || (r && r.error) || 'unknown';
            counts[k] = (counts[k] || 0) + 1;
        }
        console.log('triaged', results.length, counts);
    } finally {
        await pool.end().catch(() => {});
    }
}

main().catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exitCode = 1;
});
