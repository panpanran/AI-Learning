'use strict';

/**
 * FS-20260907-user-feedback-phase2 + FS-20260907-feedback-ai-apply-cae
 * Triage parent/student feedback: AI may fix content / answer / explanation only.
 */

const AUTO_APPLY = String(process.env.USER_FEEDBACK_AUTO_APPLY ?? '1').trim() !== '0';
const APPLY_MIN_CONFIDENCE = Math.min(
    1,
    Math.max(0, Number(process.env.USER_FEEDBACK_APPLY_MIN_CONFIDENCE) || 0.75)
);

let triageChain = Promise.resolve();

function normalizeAnswerText(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/,/g, '')
        .replace(/\s+/g, ' ');
}

function answersMatch(a, b) {
    const x = normalizeAnswerText(a);
    const y = normalizeAnswerText(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny) && nx === ny) return true;
    // allow "800" vs "800 apples"
    if (x.startsWith(y) || y.startsWith(x)) return true;
    return false;
}

function parseMetadata(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(String(raw));
    } catch {
        return null;
    }
}

function computeMathResult(metadata) {
    const meta = metadata && typeof metadata === 'object' ? metadata : null;
    if (!meta) return null;
    const type = meta.type != null ? String(meta.type).toLowerCase() : '';
    const nums = Array.isArray(meta.nums)
        ? meta.nums.map((n) => Number(n)).filter((n) => Number.isFinite(n))
        : [];
    if (!nums.length) return null;

    let value = null;
    if (type === 'addition') value = nums.reduce((a, b) => a + b, 0);
    else if (type === 'subtraction' && nums.length >= 2) value = nums[0] - nums[1];
    else if (type === 'multiplication') value = nums.reduce((a, b) => a * b, 1);
    else if (type === 'division' && nums.length >= 2 && nums[1] !== 0) {
        value = nums[0] / nums[1];
        if (Number.isInteger(nums[0]) && Number.isInteger(nums[1]) && nums[0] % nums[1] === 0) {
            value = nums[0] / nums[1];
        }
    } else return null;

    if (!Number.isFinite(value)) return null;
    // Prefer integer string when exact
    if (Number.isInteger(value) || Math.abs(value - Math.round(value)) < 1e-9) {
        return String(Math.round(value));
    }
    return String(Number(value.toFixed(6)).toString());
}

function extractOptionTexts(options) {
    const out = [];
    if (!options) return out;
    let parsed = options;
    if (typeof options === 'string') {
        try { parsed = JSON.parse(options); } catch { return out; }
    }
    if (Array.isArray(parsed)) {
        for (const o of parsed) out.push(String(o));
        return out;
    }
    if (parsed && typeof parsed === 'object') {
        for (const lang of ['zh', 'en', 'cn']) {
            if (Array.isArray(parsed[lang])) {
                for (const o of parsed[lang]) out.push(String(o));
            }
        }
    }
    return out;
}

function findMatchingOption(options, expected) {
    const texts = extractOptionTexts(options);
    for (const t of texts) {
        if (answersMatch(t, expected)) return t;
    }
    // Prefer option that contains the numeric expected as whole token
    const exp = normalizeAnswerText(expected);
    for (const t of texts) {
        const n = normalizeAnswerText(t);
        if (n.includes(exp)) return t;
    }
    return null;
}

function safeParseJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(raw.slice(start, end + 1));
            } catch {
                return null;
            }
        }
    }
    return null;
}

async function llmProposeFix({ aiClient, createChatCompletionJson, question, feedback }) {
    if (!aiClient || typeof createChatCompletionJson !== 'function') {
        return null;
    }
    const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    const payload = {
        comment: feedback.comment,
        category_hint: feedback.category,
        given_answer: feedback.given_answer,
        question: {
            content_cn: question.content_cn,
            content_en: question.content_en,
            answer_cn: question.answer_cn,
            answer_en: question.answer_en,
            explanation_cn: question.explanation_cn,
            explanation_en: question.explanation_en,
            options: question.options,
            metadata: question.metadata,
        },
    };

    const completion = await createChatCompletionJson(aiClient, {
        model,
        temperature: 0,
        max_tokens: 1200,
        messages: [
            {
                role: 'system',
                content:
                    'You triage parent feedback on a multiple-choice question. Return strict JSON only. '
                    + 'You may fix ONLY these fields: question stem (content), correct answer, and explanation '
                    + '(both Chinese and English). Do NOT invent new options, change option lists, KP, or metadata. '
                    + 'If the correct answer changes, it MUST be exactly one of the existing options. '
                    + 'If feedback is about student difficulty (not a content bug), set dismiss=true.',
            },
            {
                role: 'user',
                content:
                    `Input:\n${JSON.stringify(payload)}\n\n`
                    + 'Return JSON:\n'
                    + '{\n'
                    + '  "category": "wrong_answer"|"wrong_explanation"|"wrong_question"|"too_hard"|"too_easy"|"other"|"not_a_bug",\n'
                    + '  "dismiss": boolean,\n'
                    + '  "reason": "short English reason",\n'
                    + '  "confidence": 0.0-1.0,\n'
                    + '  "proposed_fix": {\n'
                    + '     "content_cn": string|null,\n'
                    + '     "content_en": string|null,\n'
                    + '     "answer_cn": string|null,\n'
                    + '     "answer_en": string|null,\n'
                    + '     "explanation_cn": string|null,\n'
                    + '     "explanation_en": string|null\n'
                    + '  }|null\n'
                    + '}\n'
                    + 'Only include fields that should change. Omit or null fields that stay the same. '
                    + 'If unsure, set proposed_fix null and dismiss false with lower confidence.',
            },
        ],
    });

    const text = completion && completion.choices && completion.choices[0]
        && completion.choices[0].message
        ? completion.choices[0].message.content
        : '';
    return safeParseJsonObject(text);
}

function normalizeOptionsObject(options) {
    if (!options) return null;
    if (typeof options === 'string') {
        try { return JSON.parse(options); } catch { return null; }
    }
    return options;
}

function proposedAnswersConsistentWithOptions(question, proposed) {
    if (!proposed) return false;
    const opts = normalizeOptionsObject(question.options);
    const hasAnyAnswer = !!(proposed.answer_cn || proposed.answer_en);
    if (!hasAnyAnswer) {
        // content/explanation-only fix is OK
        return !!(proposed.content_cn || proposed.content_en
            || proposed.explanation_cn || proposed.explanation_en);
    }
    if (!opts) return false;

    if (Array.isArray(opts.zh) && proposed.answer_cn) {
        if (!findMatchingOption({ zh: opts.zh }, proposed.answer_cn)) return false;
    }
    if (Array.isArray(opts.en) && proposed.answer_en) {
        if (!findMatchingOption({ en: opts.en }, proposed.answer_en)) return false;
    }
    if (!Array.isArray(opts.zh) && !Array.isArray(opts.en)) {
        const a = proposed.answer_cn || proposed.answer_en;
        if (a && !findMatchingOption(opts, a)) return false;
    }
    // If only one language provided, still require it match some option text
    if (proposed.answer_cn && !Array.isArray(opts.zh) && Array.isArray(opts.en)) {
        if (!findMatchingOption(opts, proposed.answer_cn)) return false;
    }
    if (proposed.answer_en && !Array.isArray(opts.en) && Array.isArray(opts.zh)) {
        if (!findMatchingOption(opts, proposed.answer_en)) return false;
    }
    return true;
}

function fieldChanged(oldVal, newVal) {
    if (newVal == null || String(newVal).trim() === '') return false;
    return String(oldVal || '').trim() !== String(newVal).trim();
}

function hasCaeChange(question, proposed) {
    if (!proposed) return false;
    return fieldChanged(question.content_cn, proposed.content_cn)
        || fieldChanged(question.content_en, proposed.content_en)
        || fieldChanged(question.answer_cn, proposed.answer_cn)
        || fieldChanged(question.answer_en, proposed.answer_en)
        || fieldChanged(question.explanation_cn, proposed.explanation_cn)
        || fieldChanged(question.explanation_en, proposed.explanation_en);
}

function canAutoApplyLlm(question, proposed, confidence) {
    if (!AUTO_APPLY || !proposed) return false;
    const conf = Number(confidence);
    if (!Number.isFinite(conf) || conf < APPLY_MIN_CONFIDENCE) return false;
    if (!proposedAnswersConsistentWithOptions(question, proposed)) return false;
    if (!hasCaeChange(question, proposed)) return false;
    return true;
}

function buildMathProposedFix(question, expected) {
    const optZh = findMatchingOption(
        (question.options && question.options.zh) ? { zh: question.options.zh } : question.options,
        expected
    );
    const optEn = findMatchingOption(
        (question.options && question.options.en) ? { en: question.options.en } : question.options,
        expected
    );
    // Fall back: search all options
    const any = findMatchingOption(question.options, expected);
    const answer_cn = optZh || any || expected;
    const answer_en = optEn || any || expected;
    return {
        answer_cn,
        answer_en,
        explanation_cn: `正确答案是 ${answer_cn}。`,
        explanation_en: `The correct answer is ${answer_en}.`,
        reason: `Deterministic math check expects ${expected}`,
        confidence: 0.95,
        auto_applicable: true,
        source: 'math_verify',
    };
}

function canAutoApplyMath(question, proposed) {
    if (!proposed) return false;
    const expected = computeMathResult(parseMetadata(question.metadata));
    if (!expected) return false;

    const storedWrong =
        !answersMatch(question.answer_cn, expected) && !answersMatch(question.answer_en, expected);
    const proposedOk =
        answersMatch(proposed.answer_cn, expected) || answersMatch(proposed.answer_en, expected)
        || answersMatch(proposed.answer_cn, findMatchingOption(question.options, expected))
        || answersMatch(proposed.answer_en, findMatchingOption(question.options, expected));

    // Must have a matching option for MCQ banks
    const opt = findMatchingOption(question.options, expected);
    if (!opt) return false;

    if (storedWrong && proposedOk) return true;

    // Explanation-only: answer already correct, but explanation fields provided
    const answerAlreadyOk =
        answersMatch(question.answer_cn, expected) || answersMatch(question.answer_en, expected);
    if (answerAlreadyOk && (proposed.explanation_cn || proposed.explanation_en)) {
        return true;
    }
    return false;
}

async function applyProposedFix(pool, questionId, proposed) {
    const fields = [];
    const params = [];
    const setIf = (col, val) => {
        if (val == null || String(val).trim() === '') return;
        params.push(String(val));
        fields.push(`${col} = $${params.length}`);
    };
    setIf('content_cn', proposed.content_cn);
    setIf('content_en', proposed.content_en);
    setIf('answer_cn', proposed.answer_cn);
    setIf('answer_en', proposed.answer_en);
    setIf('explanation_cn', proposed.explanation_cn);
    setIf('explanation_en', proposed.explanation_en);
    if (!fields.length) return false;
    params.push(questionId);
    await pool.query(
        `UPDATE questions SET ${fields.join(', ')} WHERE id = $${params.length}`,
        params
    );
    return true;
}

/**
 * Triage one feedback row by id.
 */
async function triageUserFeedbackById(pool, feedbackId, deps = {}) {
    const id = Number(feedbackId);
    if (!pool || !Number.isInteger(id)) return { ok: false, error: 'bad_id' };

    const fbRes = await pool.query(
        `SELECT * FROM user_question_feedback WHERE id = $1 LIMIT 1`,
        [id]
    );
    const feedback = fbRes.rows[0];
    if (!feedback) return { ok: false, error: 'not_found' };
    if (feedback.status === 'applied' || feedback.status === 'dismissed') {
        return { ok: true, skipped: true, status: feedback.status };
    }

    const qRes = await pool.query(
        `SELECT id, content_cn, content_en, options, metadata,
                answer_cn, answer_en, explanation_cn, explanation_en,
                knowledge_point_id, grade_id, subject_id
         FROM questions WHERE id = $1 LIMIT 1`,
        [feedback.question_id]
    );
    const question = qRes.rows[0];
    if (!question) {
        await pool.query(
            `UPDATE user_question_feedback
             SET status = 'dismissed',
                 proposed_fix = $2::jsonb,
                 category = COALESCE(category, 'other')
             WHERE id = $1`,
            [id, JSON.stringify({ reason: 'question_missing', confidence: 1 })]
        );
        return { ok: true, status: 'dismissed', reason: 'question_missing' };
    }

    // Prefer deterministic math path first
    const expected = computeMathResult(parseMetadata(question.metadata));
    let proposed = null;
    let category = feedback.category || 'other';
    let dismiss = false;
    let llm = null;

    if (expected) {
        const storedOk =
            answersMatch(question.answer_cn, expected) || answersMatch(question.answer_en, expected);
        if (!storedOk) {
            proposed = buildMathProposedFix(question, expected);
            category = 'wrong_answer';
        }
    }

    // LLM for explanation / classification / non-math (or to refine explanation when math answer wrong)
    try {
        llm = await llmProposeFix({
            aiClient: deps.aiClient || null,
            createChatCompletionJson: deps.createChatCompletionJson,
            question,
            feedback,
        });
    } catch (err) {
        console.error('[user-feedback-triage] llm failed:', err && err.message ? err.message : err);
        llm = null;
    }

    if (llm && typeof llm === 'object') {
        if (llm.category) category = String(llm.category).slice(0, 64);
        if (llm.dismiss === true) dismiss = true;
        if (!proposed && llm.proposed_fix && typeof llm.proposed_fix === 'object') {
            proposed = {
                ...llm.proposed_fix,
                reason: llm.reason || null,
                confidence: llm.confidence != null ? Number(llm.confidence) : null,
                source: 'llm',
            };
        } else if (proposed && llm.proposed_fix) {
            // Keep math-verified answers; allow LLM content + explanations
            const pf = llm.proposed_fix;
            if (pf.content_cn) proposed.content_cn = pf.content_cn;
            if (pf.content_en) proposed.content_en = pf.content_en;
            if (pf.explanation_cn) proposed.explanation_cn = pf.explanation_cn;
            if (pf.explanation_en) proposed.explanation_en = pf.explanation_en;
            if (llm.reason) proposed.reason = `${proposed.reason || ''}; ${llm.reason}`.trim();
            if (llm.confidence != null && proposed.confidence == null) {
                proposed.confidence = Number(llm.confidence);
            }
            proposed.source = proposed.source || 'math_verify+llm';
        } else if (!proposed && llm.reason) {
            proposed = { reason: llm.reason, confidence: llm.confidence, source: 'llm' };
        }
    }

    if (dismiss || category === 'not_a_bug' || category === 'too_hard' || category === 'too_easy') {
        await pool.query(
            `UPDATE user_question_feedback
             SET status = 'dismissed',
                 category = $2,
                 proposed_fix = $3::jsonb
             WHERE id = $1`,
            [id, category, JSON.stringify(proposed || { reason: llm && llm.reason, dismiss: true })]
        );
        return { ok: true, status: 'dismissed', category };
    }

    const mathApplicable = expected && canAutoApplyMath(question, proposed);
    const llmConfidence = proposed && proposed.confidence != null
        ? Number(proposed.confidence)
        : (llm && llm.confidence != null ? Number(llm.confidence) : null);
    const llmApplicable = canAutoApplyLlm(question, proposed, llmConfidence);
    const shouldApply = AUTO_APPLY && proposed && (mathApplicable || llmApplicable)
        && (proposed.content_cn || proposed.content_en
            || proposed.answer_cn || proposed.answer_en
            || proposed.explanation_cn || proposed.explanation_en);

    if (shouldApply) {
        // Normalize math answers to option text
        if (expected && mathApplicable) {
            const zhList = question.options && question.options.zh;
            const enList = question.options && question.options.en;
            if (Array.isArray(zhList)) {
                const z = zhList.find((t) => answersMatch(t, expected));
                if (z) proposed.answer_cn = z;
            }
            if (Array.isArray(enList)) {
                const e = enList.find((t) => answersMatch(t, expected));
                if (e) proposed.answer_en = e;
            }
            if (!proposed.answer_cn || !proposed.answer_en) {
                const opt = findMatchingOption(question.options, expected);
                if (opt) {
                    proposed.answer_cn = proposed.answer_cn || opt;
                    proposed.answer_en = proposed.answer_en || opt;
                }
            }
        }

        // Snap LLM answers to exact option strings when close match
        if (proposed.answer_cn) {
            const z = findMatchingOption(
                (question.options && question.options.zh) ? { zh: question.options.zh } : question.options,
                proposed.answer_cn
            );
            if (z) proposed.answer_cn = z;
        }
        if (proposed.answer_en) {
            const e = findMatchingOption(
                (question.options && question.options.en) ? { en: question.options.en } : question.options,
                proposed.answer_en
            );
            if (e) proposed.answer_en = e;
        }

        await applyProposedFix(pool, question.id, proposed);
        await pool.query(
            `UPDATE user_question_feedback
             SET status = 'applied',
                 category = $2,
                 proposed_fix = $3::jsonb,
                 applied_at = NOW()
             WHERE id = $1`,
            [id, category, JSON.stringify({
                ...proposed,
                auto_applicable: true,
                apply_via: mathApplicable ? 'math_or_llm' : 'llm',
                confidence: llmConfidence,
            })]
        );
        console.log('[user-feedback-triage] applied', {
            feedback_id: id,
            question_id: question.id,
            category,
            via: mathApplicable ? 'math' : 'llm',
            confidence: llmConfidence,
        });
        return { ok: true, status: 'applied', category, proposed };
    }

    await pool.query(
        `UPDATE user_question_feedback
         SET status = 'acknowledged',
             category = $2,
             proposed_fix = $3::jsonb
         WHERE id = $1`,
        [id, category, JSON.stringify(proposed || { reason: 'needs_human_review' })]
    );
    return { ok: true, status: 'acknowledged', category, proposed };
}

function queueUserFeedbackTriage(opts) {
    const { pool, feedbackId, aiClient, createChatCompletionJson } = opts || {};
    if (!pool || feedbackId == null) return;

    triageChain = triageChain
        .then(() => triageUserFeedbackById(pool, feedbackId, { aiClient, createChatCompletionJson }))
        .catch((err) => {
            console.error('[user-feedback-triage] queue failed:', err && err.message ? err.message : err);
        });
}

async function triageOpenUserFeedback(pool, deps = {}, { limit = 50, includeAcknowledged = false } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const statuses = includeAcknowledged ? ['open', 'acknowledged'] : ['open'];
    const r = await pool.query(
        `SELECT id FROM user_question_feedback
         WHERE status = ANY($1::text[])
         ORDER BY created_at ASC
         LIMIT $2`,
        [statuses, lim]
    );
    const results = [];
    for (const row of r.rows) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await triageUserFeedbackById(pool, row.id, deps));
    }
    return results;
}

module.exports = {
    normalizeAnswerText,
    answersMatch,
    computeMathResult,
    canAutoApplyMath,
    canAutoApplyLlm,
    proposedAnswersConsistentWithOptions,
    hasCaeChange,
    buildMathProposedFix,
    triageUserFeedbackById,
    queueUserFeedbackTriage,
    triageOpenUserFeedback,
    AUTO_APPLY,
    APPLY_MIN_CONFIDENCE,
};
