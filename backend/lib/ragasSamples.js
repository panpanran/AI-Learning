'use strict';

const { extractBilingualOptions } = require('./diagnosticEvalRules');

/**
 * Build diagnostic evaluation samples (Phase 2).
 * Extends legacy Ragas row shape with eval_context and bilingual fields.
 */
function buildDiagnosticEvalSamples(questions, kpList, lang, options = {}) {
    if (!Array.isArray(questions) || !questions.length) return [];

    const kpById = {};
    if (Array.isArray(kpList)) {
        for (const kp of kpList) {
            if (kp && kp.id != null) kpById[Number(kp.id)] = kp;
        }
    }

    return questions.map((q) => {
        const kpId = q.knowledge_point_id != null ? Number(q.knowledge_point_id) : null;
        const kp = kpId && kpById[kpId] ? kpById[kpId] : null;
        const bilingual = extractBilingualOptions(q.options);

        const question = lang === 'zh'
            ? (q.content_cn || q.content_en || '')
            : (q.content_en || q.content_cn || '');
        const answer = lang === 'zh'
            ? (q.answer_cn || q.answer_en || '')
            : (q.answer_en || q.answer_cn || '');
        const explanation = lang === 'zh'
            ? (q.explanation_cn || q.explanation_en || answer)
            : (q.explanation_en || q.explanation_cn || answer);

        const kpText = kp
            ? (lang === 'zh'
                ? [kp.name_cn, kp.description].filter(Boolean).join(': ')
                : [kp.name_en, kp.description].filter(Boolean).join(': '))
            : null;
        const contexts = kpText ? [kpText] : ['(no knowledge-point context)'];

        const evalContext = kp ? {
            kp_id: kpId,
            kp_name: lang === 'zh' ? (kp.name_cn || kp.name_en || '') : (kp.name_en || kp.name_cn || ''),
            unit_name: lang === 'zh'
                ? (kp.unit_name_cn || kp.unit_name_en || '')
                : (kp.unit_name_en || kp.unit_name_cn || ''),
            description: kp.description || '',
            grade_guidance: options.gradeGuidance || '',
        } : null;

        return {
            question,
            answer,
            explanation,
            ground_truth: explanation,
            contexts,
            knowledge_point_id: Number.isInteger(kpId) ? kpId : null,
            options: bilingual ? (lang === 'zh' ? bilingual.zh : bilingual.en) : [],
            options_zh: bilingual ? bilingual.zh : [],
            options_en: bilingual ? bilingual.en : [],
            content_cn: q.content_cn || '',
            content_en: q.content_en || '',
            answer_cn: q.answer_cn || '',
            answer_en: q.answer_en || '',
            explanation_cn: q.explanation_cn || '',
            explanation_en: q.explanation_en || '',
            eval_context: evalContext,
            metadata: q.metadata || null,
        };
    });
}

/** @deprecated alias — returns legacy Ragas JSONL shape */
function buildRagasSamples(questions, kpList, lang) {
    return buildDiagnosticEvalSamples(questions, kpList, lang).map((row) => ({
        question: row.question,
        answer: row.answer,
        contexts: row.contexts,
        ground_truth: row.ground_truth,
    }));
}

module.exports = { buildRagasSamples, buildDiagnosticEvalSamples };
