'use strict';

/**
 * Layer A — deterministic diagnostic question checks (no LLM).
 * See specs/diagnostic-quality-evaluation.md
 */

function normalizeText(value) {
    return String(value ?? '').trim();
}

function extractBilingualOptions(options) {
    if (!options) return null;
    if (typeof options === 'object' && !Array.isArray(options)) {
        const zh = Array.isArray(options.zh) ? options.zh.map((x) => normalizeText(x)) : null;
        const en = Array.isArray(options.en) ? options.en.map((x) => normalizeText(x)) : null;
        if (zh && en && zh.length && en.length) return { zh, en };
        if (en && !zh) return { zh: en, en };
        if (zh && !en) return { zh, en: zh };

        const keys = ['A', 'B', 'C', 'D'];
        const zh2 = [];
        const en2 = [];
        let ok = true;
        for (const k of keys) {
            const v = options[k];
            if (!v || typeof v !== 'object') { ok = false; break; }
            const z = normalizeText(v.zh);
            const e = normalizeText(v.en);
            if (!z || !e) { ok = false; break; }
            zh2.push(z);
            en2.push(e);
        }
        if (ok) return { zh: zh2, en: en2 };
    }

    if (Array.isArray(options)) {
        const arr = options.map((x) => normalizeText(x));
        return { zh: arr, en: arr };
    }
    return null;
}

function countMatchingOptions(options, answer) {
    const normAnswer = normalizeText(answer);
    if (!normAnswer || !Array.isArray(options)) return 0;
    return options.filter((opt) => normalizeText(opt) === normAnswer).length;
}

function checkSchemaValid(q) {
    const failures = [];
    const qType = normalizeText(q.type || 'mcq');
    if (qType !== 'mcq') failures.push('type must be mcq');

    const bilingual = extractBilingualOptions(q.options);
    if (!bilingual) {
        failures.push('options missing or invalid bilingual shape');
    } else {
        if (bilingual.zh.length !== 4) failures.push('options.zh must have 4 items');
        if (bilingual.en.length !== 4) failures.push('options.en must have 4 items');
    }

    for (const field of ['content_cn', 'content_en', 'answer_cn', 'answer_en', 'explanation_cn', 'explanation_en']) {
        if (!normalizeText(q[field])) failures.push(`${field} is required`);
    }

    return { pass: failures.length === 0, details: failures, bilingual };
}

function isDiagnosticRulesEnabled() {
    return String(process.env.DIAG_EVAL_RULES ?? '1').trim() !== '0';
}

/**
 * @param {object[]} questions
 * @param {object[]} kpList
 * @param {{ lang?: string, knowledgePointIdsPlan?: number[] }} [options]
 */
function runDiagnosticRules(questions, kpList, options = {}) {
    if (!Array.isArray(questions) || !questions.length) {
        return { rows: [], batch: { rule_pass_rate: 0, kp_coverage: 0, kp_plan_adherence: null } };
    }

    const lang = options.lang || 'en';
    const plan = options.knowledgePointIdsPlan;
    const allowedIds = new Set(
        (Array.isArray(kpList) ? kpList : [])
            .map((kp) => (kp && kp.id != null ? Number(kp.id) : null))
            .filter(Number.isInteger)
    );

    const rows = questions.map((q, index) => {
        const failures = [];
        const rules = {};

        const schema = checkSchemaValid(q);
        rules.schema_valid = schema.pass;
        if (!schema.pass) failures.push('schema_valid');

        const bilingual = schema.bilingual || extractBilingualOptions(q.options);
        const answerCn = normalizeText(q.answer_cn);
        const answerEn = normalizeText(q.answer_en);

        rules.answer_in_options = Boolean(
            bilingual
            && answerCn
            && answerEn
            && bilingual.zh.some((opt) => normalizeText(opt) === answerCn)
            && bilingual.en.some((opt) => normalizeText(opt) === answerEn)
        );
        if (!rules.answer_in_options) failures.push('answer_in_options');

        const zhMatches = bilingual ? countMatchingOptions(bilingual.zh, answerCn) : 0;
        const enMatches = bilingual ? countMatchingOptions(bilingual.en, answerEn) : 0;
        rules.single_correct = zhMatches === 1 && enMatches === 1;
        if (!rules.single_correct) failures.push('single_correct');

        const kpId = q.knowledge_point_id != null ? Number(q.knowledge_point_id) : null;
        rules.kp_assigned = Number.isInteger(kpId)
            && (allowedIds.size === 0 || allowedIds.has(kpId));
        if (!rules.kp_assigned) failures.push('kp_assigned');

        // kp_plan_match is informational only (feeds batch kp_plan_adherence).
        // It must NOT gate all_pass: questions selected from the DB, deduped,
        // refilled or refined never follow the audit-time plan by index, so a
        // strict slot comparison produces spurious negatives that poison the
        // feedback loop. Per-question KP correctness is covered by kp_assigned
        // plus the judge's kp_alignment score.
        if (Array.isArray(plan) && plan.length > index) {
            const planned = plan[index] != null ? Number(plan[index]) : null;
            rules.kp_plan_match = Number.isInteger(planned) && kpId === planned;
        } else {
            rules.kp_plan_match = null;
        }

        rules.metadata_present = Boolean(
            q.metadata
            && typeof q.metadata === 'object'
            && !Array.isArray(q.metadata)
            && Object.keys(q.metadata).length > 0
        );
        if (!rules.metadata_present) failures.push('metadata_present');

        rules.bilingual_present = Boolean(
            normalizeText(q.content_cn)
            && normalizeText(q.content_en)
            && answerCn
            && answerEn
            && normalizeText(q.explanation_cn)
            && normalizeText(q.explanation_en)
            && bilingual
            && bilingual.zh.length === 4
            && bilingual.en.length === 4
        );
        if (!rules.bilingual_present) failures.push('bilingual_present');

        const applicable = Object.entries(rules)
            .filter(([key, v]) => v !== null && key !== 'kp_plan_match');
        const allPass = applicable.every(([, v]) => v === true);

        return {
            index,
            knowledge_point_id: Number.isInteger(kpId) ? kpId : null,
            question: lang === 'zh'
                ? (q.content_cn || q.content_en || '')
                : (q.content_en || q.content_cn || ''),
            rules,
            rule_failures: failures,
            all_pass: allPass,
        };
    });

    const passCount = rows.filter((row) => row.all_pass).length;
    const uniqueKps = new Set(rows.map((row) => row.knowledge_point_id).filter(Number.isInteger));

    let kpPlanAdherence = null;
    if (Array.isArray(plan) && plan.length >= questions.length) {
        const matchCount = rows.filter((row) => row.rules.kp_plan_match === true).length;
        kpPlanAdherence = matchCount / questions.length;
    }

    return {
        rows,
        batch: {
            rule_pass_rate: passCount / questions.length,
            kp_coverage: uniqueKps.size / questions.length,
            kp_plan_adherence: kpPlanAdherence,
        },
    };
}

module.exports = {
    isDiagnosticRulesEnabled,
    runDiagnosticRules,
    extractBilingualOptions,
    normalizeText,
};
