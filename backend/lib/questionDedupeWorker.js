'use strict';

const crypto = require('crypto');
const { extractBilingualOptions } = require('./diagnosticEvalRules');

function normalizeOptions(options) {
    if (!Array.isArray(options)) return null;
    const out = options.map((x) => (x != null ? String(x).trim() : '')).filter(Boolean);
    return out.length ? out : null;
}

function computeQuestionContentOptionsHash(contentEn, options) {
    const p = (contentEn ?? '').toString().trim();
    const o = normalizeOptions(options) || [];
    const payload = JSON.stringify({ content_en: p, options: o });
    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function ensureContentOptionsHash(question) {
    if (!question || typeof question !== 'object') return question;
    if (question.content_options_hash) return question;
    try {
        const opt = question.options_bilingual || question.optionsBilingual || question.options;
        const bilingual = extractBilingualOptions(opt);
        const optionsEn = bilingual ? bilingual.en : (Array.isArray(opt) ? opt : (opt && Array.isArray(opt.en) ? opt.en : []));
        question.content_options_hash = computeQuestionContentOptionsHash(question.content_en, optionsEn);
    } catch {
        // best-effort
    }
    return question;
}

function uniqueByContentOptionsHash(questions) {
    const seen = new Set();
    const out = [];
    for (const q of questions || []) {
        const h = (q && q.content_options_hash)
            ? String(q.content_options_hash)
            : computeQuestionContentOptionsHash(
                q && q.content_en,
                (q && q.options && Array.isArray(q.options))
                    ? q.options
                    : (q && q.options && q.options.en)
            );
        if (seen.has(h)) continue;
        seen.add(h);
        out.push(q);
    }
    return out;
}

async function filterHashesNotInDb(pool, questions) {
    if (!pool || !Array.isArray(questions) || !questions.length) return questions;
    const hashes = questions.map((q) => q.content_options_hash).filter(Boolean);
    if (!hashes.length) return questions;
    try {
        const r = await pool.query(
            'SELECT content_options_hash FROM questions WHERE content_options_hash = ANY($1::text[])',
            [hashes]
        );
        const inDb = new Set((r.rows || []).map((x) => x.content_options_hash));
        return questions.filter((q) => !inDb.has(q.content_options_hash));
    } catch {
        return questions;
    }
}

module.exports = {
    normalizeOptions,
    computeQuestionContentOptionsHash,
    ensureContentOptionsHash,
    uniqueByContentOptionsHash,
    filterHashesNotInDb,
};
