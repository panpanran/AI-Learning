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
 * Human decision on a triage proposal.
 * action: accept | reject
 */
async function decideUserFeedback(pool, {
    feedbackId,
    userIds,
    action,
}) {
    const id = Number(feedbackId);
    const act = String(action || '').toLowerCase();
    if (!pool || !Number.isInteger(id) || !['accept', 'reject'].includes(act)) {
        const err = new Error('feedback_id and action (accept|reject) required');
        err.status = 400;
        throw err;
    }
    const ids = (Array.isArray(userIds) ? userIds : [])
        .map((x) => Number(x))
        .filter(Number.isInteger);
    if (!ids.length) {
        const err = new Error('Unauthorized');
        err.status = 401;
        throw err;
    }

    const fbRes = await pool.query(
        `SELECT * FROM user_question_feedback WHERE id = $1 AND user_id = ANY($2::int[]) LIMIT 1`,
        [id, ids]
    );
    const feedback = fbRes.rows[0];
    if (!feedback) {
        const err = new Error('feedback not found');
        err.status = 404;
        throw err;
    }
    if (feedback.status === 'applied' || feedback.status === 'dismissed') {
        return { id, status: feedback.status, skipped: true };
    }

    if (act === 'reject') {
        await pool.query(
            `UPDATE user_question_feedback
             SET status = 'dismissed',
                 proposed_fix = COALESCE(proposed_fix, '{}'::jsonb) || $2::jsonb
             WHERE id = $1`,
            [id, JSON.stringify({ human_decision: 'reject' })]
        );
        return { id, status: 'dismissed' };
    }

    // accept
    const proposed = feedback.proposed_fix && typeof feedback.proposed_fix === 'object'
        ? feedback.proposed_fix
        : null;
    const hasCae = proposed && (
        proposed.content_cn || proposed.content_en
        || proposed.answer_cn || proposed.answer_en
        || proposed.explanation_cn || proposed.explanation_en
    );
    if (!hasCae) {
        const err = new Error('No proposed content/answer/explanation to apply. Re-analyze first.');
        err.status = 400;
        throw err;
    }

    const qRes = await pool.query(
        `SELECT id, options, answer_cn, answer_en, content_cn, content_en,
                explanation_cn, explanation_en, metadata
         FROM questions WHERE id = $1 LIMIT 1`,
        [feedback.question_id]
    );
    const question = qRes.rows[0];
    if (!question) {
        const err = new Error('question not found');
        err.status = 404;
        throw err;
    }

    // Soft gate: if answers present, prefer option consistency (human override still allowed if no options)
    if ((proposed.answer_cn || proposed.answer_en) && question.options) {
        if (!proposedAnswersConsistentWithOptions(question, proposed)) {
            const err = new Error('Proposed answer is not among existing options');
            err.status = 400;
            throw err;
        }
    }

    await applyProposedFix(pool, question.id, proposed);
    await pool.query(
        `UPDATE user_question_feedback
         SET status = 'applied',
             proposed_fix = COALESCE(proposed_fix, '{}'::jsonb) || $2::jsonb,
             applied_at = NOW()
         WHERE id = $1`,
        [id, JSON.stringify({ human_decision: 'accept', applied_by: 'review_ui' })]
    );
    return { id, status: 'applied', question_id: question.id };
}

async function listUserFeedback(pool, {
    userIds,
    status = 'acknowledged',
    limit = 50,
}) {
    const ids = (Array.isArray(userIds) ? userIds : [])
        .map((x) => Number(x))
        .filter(Number.isInteger);
    if (!pool || !ids.length) return [];

    const lim = Math.max(1, Math.min(100, Number(limit) || 50));
    const statuses = String(status || 'acknowledged')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const useStatuses = statuses.length ? statuses : ['acknowledged'];

    const r = await pool.query(
        `SELECT f.id, f.user_id, f.question_id, f.knowledge_point_id, f.grade_id, f.subject_id,
                f.category, f.comment, f.given_answer, f.status, f.proposed_fix, f.created_at, f.applied_at,
                q.content_cn, q.content_en, q.answer_cn, q.answer_en,
                q.explanation_cn, q.explanation_en, q.options
         FROM user_question_feedback f
         LEFT JOIN questions q ON q.id = f.question_id
         WHERE f.user_id = ANY($1::int[])
           AND f.status = ANY($2::text[])
         ORDER BY f.created_at DESC
         LIMIT $3`,
        [ids, useStatuses, lim]
    );

    return (r.rows || []).map((row) => ({
        id: Number(row.id),
        user_id: Number(row.user_id),
        question_id: row.question_id != null ? Number(row.question_id) : null,
        knowledge_point_id: row.knowledge_point_id != null ? Number(row.knowledge_point_id) : null,
        grade_id: row.grade_id != null ? Number(row.grade_id) : null,
        subject_id: row.subject_id != null ? Number(row.subject_id) : null,
        category: row.category || 'other',
        comment: row.comment || '',
        given_answer: row.given_answer || '',
        status: row.status,
        proposed_fix: row.proposed_fix || null,
        created_at: row.created_at,
        applied_at: row.applied_at,
        question: {
            content_cn: row.content_cn || '',
            content_en: row.content_en || '',
            answer_cn: row.answer_cn || '',
            answer_en: row.answer_en || '',
            explanation_cn: row.explanation_cn || '',
            explanation_en: row.explanation_en || '',
            options: row.options || null,
        },
    }));
}

/**
 * Triage one feedback row by id.
 * Prefers agents LangGraph workflow when enabled; falls back to local Express path.
 */
async function triageUserFeedbackById(pool, feedbackId, deps = {}) {
    const id = Number(feedbackId);
    if (!pool || !Number.isInteger(id)) return { ok: false, error: 'bad_id' };

    const loaded = await loadFeedbackItemsForTriage(pool, [id]);
    if (!loaded.length) {
        const fbRes = await pool.query(
            `SELECT id, status FROM user_question_feedback WHERE id = $1 LIMIT 1`,
            [id]
        );
        if (!fbRes.rows[0]) return { ok: false, error: 'not_found' };
        return { ok: true, skipped: true, status: fbRes.rows[0].status };
    }

    // Agents-first (FS-20260907-agents-feedback-triage-workflow)
    try {
        const { isAgentsFeedbackTriageEnabled, runAgentsFeedbackTriage } = require('./agentClient');
        if (isAgentsFeedbackTriageEnabled()) {
            const agentsResult = await runAgentsFeedbackTriage({
                items: loaded,
                autoApply: AUTO_APPLY,
                minConfidence: APPLY_MIN_CONFIDENCE,
                meta: { source: 'express_single', feedback_id: id },
            });
            if (agentsResult && Array.isArray(agentsResult.items) && agentsResult.items.length) {
                const applied = await applyAgentsTriageResults(pool, agentsResult.items);
                const one = applied[0] || { ok: true, status: agentsResult.items[0].status };
                return {
                    ok: true,
                    ...one,
                    source: 'agents-service',
                    batch_id: agentsResult.batch_id,
                };
            }
        }
    } catch (err) {
        console.error(
            '[user-feedback-triage] agents failed, falling back to Express:',
            err && err.message ? err.message : err
        );
    }

    return triageUserFeedbackLocally(pool, loaded[0], deps);
}

async function loadFeedbackItemsForTriage(pool, feedbackIds) {
    const ids = (Array.isArray(feedbackIds) ? feedbackIds : [])
        .map((x) => Number(x))
        .filter(Number.isInteger);
    if (!pool || !ids.length) return [];

    const r = await pool.query(
        `SELECT f.id AS feedback_id, f.question_id, f.category, f.comment, f.given_answer, f.status,
                q.id AS q_id, q.content_cn, q.content_en, q.options, q.metadata,
                q.answer_cn, q.answer_en, q.explanation_cn, q.explanation_en,
                q.knowledge_point_id, q.grade_id, q.subject_id
         FROM user_question_feedback f
         LEFT JOIN questions q ON q.id = f.question_id
         WHERE f.id = ANY($1::int[])
           AND f.status NOT IN ('applied', 'dismissed')`,
        [ids]
    );

    return (r.rows || []).map((row) => ({
        feedback_id: Number(row.feedback_id),
        question_id: row.question_id != null ? Number(row.question_id) : null,
        category: row.category || 'other',
        comment: row.comment || '',
        given_answer: row.given_answer || '',
        question: row.q_id == null ? null : {
            id: Number(row.q_id),
            content_cn: row.content_cn,
            content_en: row.content_en,
            options: row.options,
            metadata: row.metadata,
            answer_cn: row.answer_cn,
            answer_en: row.answer_en,
            explanation_cn: row.explanation_cn,
            explanation_en: row.explanation_en,
            knowledge_point_id: row.knowledge_point_id,
            grade_id: row.grade_id,
            subject_id: row.subject_id,
        },
    })).filter((item) => item.question);
}

async function applyAgentsTriageResults(pool, items) {
    const out = [];
    for (const row of (items || [])) {
        const id = Number(row.feedback_id);
        if (!Number.isInteger(id)) continue;
        const status = String(row.status || 'acknowledged');
        const category = String(row.category || 'other').slice(0, 64);
        const proposed = row.proposed_fix && typeof row.proposed_fix === 'object'
            ? row.proposed_fix
            : { reason: 'agents_empty' };
        const questionId = row.question_id != null ? Number(row.question_id) : null;

        if (status === 'applied' && row.apply !== false && questionId) {
            const hasCae = proposed.content_cn || proposed.content_en
                || proposed.answer_cn || proposed.answer_en
                || proposed.explanation_cn || proposed.explanation_en;
            if (hasCae) {
                await applyProposedFix(pool, questionId, proposed);
                await pool.query(
                    `UPDATE user_question_feedback
                     SET status = 'applied',
                         category = $2,
                         proposed_fix = $3::jsonb,
                         applied_at = NOW()
                     WHERE id = $1`,
                    [id, category, JSON.stringify(proposed)]
                );
                out.push({ ok: true, id, status: 'applied', category, proposed });
                continue;
            }
        }

        if (status === 'dismissed') {
            await pool.query(
                `UPDATE user_question_feedback
                 SET status = 'dismissed',
                     category = $2,
                     proposed_fix = $3::jsonb
                 WHERE id = $1`,
                [id, category, JSON.stringify(proposed)]
            );
            out.push({ ok: true, id, status: 'dismissed', category });
            continue;
        }

        await pool.query(
            `UPDATE user_question_feedback
             SET status = 'acknowledged',
                 category = $2,
                 proposed_fix = $3::jsonb
             WHERE id = $1`,
            [id, category, JSON.stringify(proposed)]
        );
        out.push({ ok: true, id, status: 'acknowledged', category, proposed });
    }
    return out;
}

/**
 * Local Express triage (fallback when agents off/unreachable).
 */
async function triageUserFeedbackLocally(pool, item, deps = {}) {
    const id = Number(item.feedback_id);
    const feedback = {
        comment: item.comment,
        category: item.category,
        given_answer: item.given_answer,
    };
    const question = item.question;
    if (!question) {
        await pool.query(
            `UPDATE user_question_feedback
             SET status = 'dismissed',
                 proposed_fix = $2::jsonb,
                 category = COALESCE(category, 'other')
             WHERE id = $1`,
            [id, JSON.stringify({ reason: 'question_missing', confidence: 1 })]
        );
        return { ok: true, status: 'dismissed', reason: 'question_missing', source: 'express' };
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
        return { ok: true, status: 'dismissed', category, source: 'express' };
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
            source: 'express',
        });
        return { ok: true, status: 'applied', category, proposed, source: 'express' };
    }

    await pool.query(
        `UPDATE user_question_feedback
         SET status = 'acknowledged',
             category = $2,
             proposed_fix = $3::jsonb
         WHERE id = $1`,
        [id, category, JSON.stringify(proposed || { reason: 'needs_human_review' })]
    );
    return { ok: true, status: 'acknowledged', category, proposed, source: 'express' };
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

/**
 * Batch triage open/acknowledged rows — one agents call when enabled.
 */
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
    const ids = (r.rows || []).map((row) => Number(row.id)).filter(Number.isInteger);
    if (!ids.length) return [];

    // Prefer a single agents batch (chunks of 20)
    try {
        const { isAgentsFeedbackTriageEnabled, runAgentsFeedbackTriage } = require('./agentClient');
        if (isAgentsFeedbackTriageEnabled()) {
            const all = [];
            for (let i = 0; i < ids.length; i += 20) {
                const chunk = ids.slice(i, i + 20);
                const loaded = await loadFeedbackItemsForTriage(pool, chunk);
                if (!loaded.length) continue;
                // eslint-disable-next-line no-await-in-loop
                const agentsResult = await runAgentsFeedbackTriage({
                    items: loaded,
                    autoApply: AUTO_APPLY,
                    minConfidence: APPLY_MIN_CONFIDENCE,
                    meta: { source: 'express_batch', chunk_start: i },
                });
                if (agentsResult && Array.isArray(agentsResult.items)) {
                    // eslint-disable-next-line no-await-in-loop
                    const applied = await applyAgentsTriageResults(pool, agentsResult.items);
                    all.push(...applied.map((x) => ({
                        ...x,
                        source: 'agents-service',
                        batch_id: agentsResult.batch_id,
                    })));
                }
            }
            if (all.length) return all;
        }
    } catch (err) {
        console.error(
            '[user-feedback-triage] agents batch failed, falling back:',
            err && err.message ? err.message : err
        );
    }

    const results = [];
    for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await triageUserFeedbackById(pool, id, deps));
    }
    return results;
}

/**
 * Batch triage for a set of user ids (review UI / API).
 */
async function triageUserFeedbackBatch(pool, deps = {}, {
    userIds,
    status = 'open,acknowledged',
    limit = 20,
} = {}) {
    const ids = (Array.isArray(userIds) ? userIds : [])
        .map((x) => Number(x))
        .filter(Number.isInteger);
    if (!pool || !ids.length) return { items: [], results: [] };

    const lim = Math.max(1, Math.min(20, Number(limit) || 20));
    const statuses = String(status || 'open,acknowledged')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const r = await pool.query(
        `SELECT id FROM user_question_feedback
         WHERE user_id = ANY($1::int[])
           AND status = ANY($2::text[])
         ORDER BY created_at ASC
         LIMIT $3`,
        [ids, statuses.length ? statuses : ['open', 'acknowledged'], lim]
    );
    const feedbackIds = (r.rows || []).map((row) => Number(row.id)).filter(Number.isInteger);
    if (!feedbackIds.length) return { items: [], results: [] };

    const loaded = await loadFeedbackItemsForTriage(pool, feedbackIds);
    if (!loaded.length) return { items: [], results: [] };

    try {
        const { isAgentsFeedbackTriageEnabled, runAgentsFeedbackTriage } = require('./agentClient');
        if (isAgentsFeedbackTriageEnabled()) {
            const agentsResult = await runAgentsFeedbackTriage({
                items: loaded,
                autoApply: AUTO_APPLY,
                minConfidence: APPLY_MIN_CONFIDENCE,
                meta: { source: 'express_user_batch' },
            });
            if (agentsResult && Array.isArray(agentsResult.items) && agentsResult.items.length) {
                const applied = await applyAgentsTriageResults(pool, agentsResult.items);
                return {
                    items: loaded,
                    results: applied.map((x) => ({
                        ...x,
                        source: 'agents-service',
                        batch_id: agentsResult.batch_id,
                    })),
                    batch_id: agentsResult.batch_id,
                };
            }
        }
    } catch (err) {
        console.error(
            '[user-feedback-triage] user batch agents failed:',
            err && err.message ? err.message : err
        );
    }

    const local = [];
    for (const item of loaded) {
        // eslint-disable-next-line no-await-in-loop
        local.push(await triageUserFeedbackLocally(pool, item, deps));
    }
    return { items: loaded, results: local };
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
    applyProposedFix,
    triageUserFeedbackById,
    queueUserFeedbackTriage,
    triageOpenUserFeedback,
    triageUserFeedbackBatch,
    loadFeedbackItemsForTriage,
    applyAgentsTriageResults,
    decideUserFeedback,
    listUserFeedback,
    AUTO_APPLY,
    APPLY_MIN_CONFIDENCE,
};
