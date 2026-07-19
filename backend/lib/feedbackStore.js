'use strict';

/**
 * Phase A — Feedback Store for diagnostic self-improvement.
 * See specs/multi-agent-architecture.md §5.2
 */

const THRESHOLDS = {
    positive_kp_alignment: Number(process.env.FEEDBACK_POSITIVE_KP_ALIGNMENT) || 0.85,
    negative_kp_alignment: Number(process.env.FEEDBACK_NEGATIVE_KP_ALIGNMENT) || 0.7,
    negative_distractor_quality: Number(process.env.FEEDBACK_NEGATIVE_DISTRACTOR) || 0.6,
    negative_response_relevancy: Number(process.env.FEEDBACK_NEGATIVE_RELEVANCY) || 0.5,
};

const FEW_SHOT_LIMIT = Number(process.env.FEEDBACK_FEW_SHOT_LIMIT) || 2;
const AVOID_PATTERN_LIMIT = Number(process.env.FEEDBACK_AVOID_LIMIT) || 3;

const AUTO_PATCH_ENABLED = String(process.env.FEEDBACK_AUTO_PATCHES ?? '1').trim() !== '0';
const AUTO_PATCH_MIN_COUNT = Math.max(2, Number(process.env.FEEDBACK_PATCH_MIN_COUNT) || 2);
const AUTO_PATCH_LOOKBACK = Math.max(AUTO_PATCH_MIN_COUNT, Number(process.env.FEEDBACK_PATCH_LOOKBACK) || 15);
const AUTO_PATCH_GS_MIN_KPS = Math.max(2, Number(process.env.FEEDBACK_PATCH_GS_MIN_KPS) || 3);

const AUTO_PATCH_TEMPLATES = {
    distractor_quality_low:
        'Write distractors that are clearly incorrect for this question. Avoid near-synonyms of the correct answer, and never reuse wording from the question stem as an option.',
    kp_alignment_low:
        'Every question must directly assess this knowledge point; do not drift into adjacent or loosely related topics.',
    response_relevancy_low:
        'Ensure the correct answer and one-sentence explanation directly address the question stem.',
    rule_failure:
        'Follow the required MCQ schema strictly: bilingual 4 options, exactly one correct answer in both languages, and include a stable metadata object.',
};

function isAutoPatchEnabled() {
    return AUTO_PATCH_ENABLED && isFeedbackStoreEnabled();
}

function autoPatchMarker(issue) {
    return `[auto:${issue}]`;
}

function buildAutoPatchText(issue, extraTip) {
    const base = AUTO_PATCH_TEMPLATES[issue] || `Avoid the recurring quality issue "${issue}" when generating questions for this scope.`;
    const tip = extraTip ? ` Recent judge tip: ${String(extraTip).slice(0, 160)}` : '';
    return `${autoPatchMarker(issue)} ${base}${tip}`.slice(0, 500);
}

function issuesFromFeedbackRow(row) {
    const issues = [];
    const critique = row && row.critique;
    if (critique && Array.isArray(critique.issues)) {
        for (const issue of critique.issues) {
            if (issue) issues.push(String(issue));
        }
    }
    // Also derive from scores when critique is missing (older rows / edge cases).
    if (!issues.length && row) {
        const derived = buildCritique(row);
        if (derived && Array.isArray(derived.issues)) issues.push(...derived.issues);
    }
    return [...new Set(issues)];
}

function pickJudgeTip(row, issue) {
    const reasons = row && row.judge_reasons ? row.judge_reasons : {};
    if (issue === 'distractor_quality_low' && reasons.distractor_quality) return reasons.distractor_quality;
    if (issue === 'kp_alignment_low' && reasons.kp_alignment) return reasons.kp_alignment;
    if (row && row.critique && row.critique.instruction) return row.critique.instruction;
    return null;
}

async function upsertAutoPatch(pool, {
    scope,
    scopeId,
    issue,
    sourceRunId,
    tip,
}) {
    const marker = autoPatchMarker(issue);
    const existing = await pool.query(
        `SELECT id FROM prompt_patches
         WHERE active = TRUE AND scope = $1 AND scope_id = $2 AND patch_text LIKE $3
         LIMIT 1`,
        [scope, String(scopeId), `${marker}%`]
    );
    if (existing.rows.length) return { inserted: false, id: existing.rows[0].id };

    const patchText = buildAutoPatchText(issue, tip);
    const ins = await pool.query(
        `INSERT INTO prompt_patches (scope, scope_id, patch_text, source_run_id, active)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING id`,
        [scope, String(scopeId), patchText, sourceRunId || null]
    );
    return { inserted: true, id: ins.rows[0] && ins.rows[0].id };
}

/**
 * After new question_feedback rows land, promote recurring negative issues
 * into prompt_patches so the next generation reads them as hard constraints.
 *
 * KP scope: same issue appears >= AUTO_PATCH_MIN_COUNT times in recent negatives.
 * grade_subject scope: same issue appears across >= AUTO_PATCH_GS_MIN_KPS distinct KPs.
 */
async function promoteFeedbackToPatches(pool, auditEntry) {
    if (!pool || !isAutoPatchEnabled() || !auditEntry) return { inserted: [] };

    const meta = auditEntry.meta || {};
    const gradeId = meta.gradeId != null ? Number(meta.gradeId) : null;
    const subjectId = meta.subjectId != null ? Number(meta.subjectId) : null;
    const runId = auditEntry.batch_id || null;
    const inserted = [];

    const kpIds = [...new Set(
        (Array.isArray(auditEntry.rows) ? auditEntry.rows : [])
            .map((row) => (row && row.knowledge_point_id != null ? Number(row.knowledge_point_id) : null))
            .filter(Number.isInteger)
    )];
    if (!kpIds.length) return { inserted };

    for (const kpId of kpIds) {
        const recent = await pool.query(
            `SELECT knowledge_point_id, scores, judge_reasons, critique, label
             FROM question_feedback
             WHERE knowledge_point_id = $1 AND label = 'negative'
             ORDER BY created_at DESC
             LIMIT $2`,
            [kpId, AUTO_PATCH_LOOKBACK]
        );

        const issueCounts = new Map();
        const issueTips = new Map();
        for (const row of recent.rows) {
            for (const issue of issuesFromFeedbackRow(row)) {
                if (!AUTO_PATCH_TEMPLATES[issue]) continue;
                issueCounts.set(issue, (issueCounts.get(issue) || 0) + 1);
                if (!issueTips.has(issue)) {
                    const tip = pickJudgeTip(row, issue);
                    if (tip) issueTips.set(issue, tip);
                }
            }
        }

        for (const [issue, count] of issueCounts.entries()) {
            if (count < AUTO_PATCH_MIN_COUNT) continue;
            const result = await upsertAutoPatch(pool, {
                scope: 'knowledge_point',
                scopeId: kpId,
                issue,
                sourceRunId: runId,
                tip: issueTips.get(issue),
            });
            if (result.inserted) {
                inserted.push({ scope: 'knowledge_point', scope_id: String(kpId), issue, id: result.id });
                console.log('[feedback] auto prompt_patch:', {
                    scope: 'knowledge_point',
                    scope_id: kpId,
                    issue,
                    count,
                });
            }
        }
    }

    if (Number.isInteger(gradeId) && Number.isInteger(subjectId)) {
        const gsRecent = await pool.query(
            `SELECT qf.knowledge_point_id, qf.scores, qf.judge_reasons, qf.critique
             FROM question_feedback qf
             JOIN diagnostic_runs dr ON dr.id = qf.run_id
             WHERE qf.label = 'negative'
               AND dr.grade_id = $1 AND dr.subject_id = $2
             ORDER BY qf.created_at DESC
             LIMIT $3`,
            [gradeId, subjectId, AUTO_PATCH_LOOKBACK * 3]
        );

        const GS_PROMOTE_ISSUES = new Set([
            'distractor_quality_low',
            'kp_alignment_low',
            'response_relevancy_low',
        ]);
        const issueKpSets = new Map();
        const issueTips = new Map();
        for (const row of gsRecent.rows) {
            const kpId = row.knowledge_point_id != null ? Number(row.knowledge_point_id) : null;
            for (const issue of issuesFromFeedbackRow(row)) {
                if (!GS_PROMOTE_ISSUES.has(issue)) continue;
                if (!issueKpSets.has(issue)) issueKpSets.set(issue, new Set());
                if (Number.isInteger(kpId)) issueKpSets.get(issue).add(kpId);
                if (!issueTips.has(issue)) {
                    const tip = pickJudgeTip(row, issue);
                    if (tip) issueTips.set(issue, tip);
                }
            }
        }

        const scopeId = `${gradeId}:${subjectId}`;
        for (const [issue, kpSet] of issueKpSets.entries()) {
            if (kpSet.size < AUTO_PATCH_GS_MIN_KPS) continue;
            const result = await upsertAutoPatch(pool, {
                scope: 'grade_subject',
                scopeId,
                issue,
                sourceRunId: runId,
                tip: issueTips.get(issue),
            });
            if (result.inserted) {
                inserted.push({ scope: 'grade_subject', scope_id: scopeId, issue, id: result.id });
                console.log('[feedback] auto prompt_patch:', {
                    scope: 'grade_subject',
                    scope_id: scopeId,
                    issue,
                    kp_count: kpSet.size,
                });
            }
        }
    }

    return { inserted };
}

function isFeedbackStoreEnabled() {
    return String(process.env.DIAG_FEEDBACK ?? '1').trim() !== '0';
}

function emptyFeedbackContext() {
    return {
        few_shot_good: [],
        avoid_patterns: [],
        prompt_patches: [],
    };
}

function scoreOf(scores, key) {
    if (!scores || scores[key] == null) return null;
    const n = Number(scores[key]);
    return Number.isFinite(n) ? n : null;
}

function labelQuestionRow(row) {
    const scores = row && row.scores ? row.scores : {};
    const allPass = row && row.all_pass === true;

    if (!allPass) return 'negative';

    const kp = scoreOf(scores, 'kp_alignment');
    const dist = scoreOf(scores, 'distractor_quality');
    const rel = scoreOf(scores, 'response_relevancy') ?? scoreOf(scores, 'answer_relevancy');

    if (kp != null && kp < THRESHOLDS.negative_kp_alignment) return 'negative';
    if (dist != null && dist < THRESHOLDS.negative_distractor_quality) return 'negative';
    if (rel != null && rel < THRESHOLDS.negative_response_relevancy) return 'negative';

    if (allPass && kp != null && kp >= THRESHOLDS.positive_kp_alignment) return 'positive';

    return 'neutral';
}

function buildCritique(row) {
    const scores = row && row.scores ? row.scores : {};
    const reasons = row && row.judge_reasons ? row.judge_reasons : {};
    const issues = [];
    const instructions = [];

    const kp = scoreOf(scores, 'kp_alignment');
    if (kp != null && kp < THRESHOLDS.negative_kp_alignment) {
        issues.push('kp_alignment_low');
        if (reasons.kp_alignment) instructions.push(reasons.kp_alignment);
    }

    const dist = scoreOf(scores, 'distractor_quality');
    if (dist != null && dist < THRESHOLDS.negative_distractor_quality) {
        issues.push('distractor_quality_low');
        if (reasons.distractor_quality) instructions.push(reasons.distractor_quality);
    }

    const rel = scoreOf(scores, 'response_relevancy') ?? scoreOf(scores, 'answer_relevancy');
    if (rel != null && rel < THRESHOLDS.negative_response_relevancy) {
        issues.push('response_relevancy_low');
    }

    if (row && row.all_pass === false && row.rule_failures && row.rule_failures.length) {
        issues.push('rule_failure');
        instructions.push(`Fix rule failures: ${row.rule_failures.join(', ')}`);
    }

    if (!issues.length) return null;

    return {
        issues,
        instruction: instructions.join(' '),
        severity: issues.includes('rule_failure') ? 'high' : 'medium',
    };
}

function buildQuestionSnapshot(question, lang) {
    if (!question || typeof question !== 'object') return null;
    return {
        type: question.type || 'mcq',
        content_cn: question.content_cn || '',
        content_en: question.content_en || '',
        answer_cn: question.answer_cn || '',
        answer_en: question.answer_en || '',
        explanation_cn: question.explanation_cn || '',
        explanation_en: question.explanation_en || '',
        options: question.options || null,
        knowledge_point_id: question.knowledge_point_id != null
            ? Number(question.knowledge_point_id)
            : null,
        metadata: question.metadata || null,
        lang: lang || 'en',
    };
}

function summarizeAvoidPattern(row) {
    const reasons = row && row.judge_reasons ? row.judge_reasons : {};
    const kpId = row && row.knowledge_point_id != null ? row.knowledge_point_id : '?';
    const parts = [];
    if (reasons.kp_alignment) parts.push(reasons.kp_alignment);
    if (reasons.distractor_quality) parts.push(reasons.distractor_quality);
    if (reasons.explanation_support) parts.push(reasons.explanation_support);
    if (!parts.length && row && row.question) {
        parts.push(String(row.question).slice(0, 120));
    }
    return `KP ${kpId}: ${parts.join(' | ')}`.slice(0, 500);
}

function compactFewShot(row, lang) {
    const snap = row.question_snapshot || {};
    const question = lang === 'zh'
        ? (snap.content_cn || row.question || '')
        : (snap.content_en || row.question || '');
    return {
        knowledge_point_id: row.knowledge_point_id,
        question: question.slice(0, 300),
        answer: lang === 'zh' ? (snap.answer_cn || '') : (snap.answer_en || ''),
        scores: row.scores || {},
    };
}

async function persistDiagnosticFeedback(pool, auditEntry, questions) {
    if (!pool || !auditEntry || !Array.isArray(auditEntry.rows) || !auditEntry.rows.length) {
        return null;
    }

    const runId = auditEntry.batch_id;
    const meta = auditEntry.meta || {};
    const lang = auditEntry.lang || 'en';
    const status = auditEntry.status || 'ok';

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `INSERT INTO diagnostic_runs (id, user_id, grade_id, subject_id, lang, batch_scores, status)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
             ON CONFLICT (id) DO UPDATE SET
               batch_scores = EXCLUDED.batch_scores,
               status = EXCLUDED.status`,
            [
                runId,
                meta.userId != null ? Number(meta.userId) : null,
                meta.gradeId != null ? Number(meta.gradeId) : null,
                meta.subjectId != null ? Number(meta.subjectId) : null,
                lang,
                JSON.stringify(auditEntry.batch || {}),
                status,
            ]
        );

        const feedbackIds = [];
        for (const row of auditEntry.rows) {
            const index = row.index != null ? Number(row.index) : 0;
            const question = Array.isArray(questions) ? questions[index] : null;
            const label = labelQuestionRow(row);
            const critique = buildCritique(row);

            const insertRes = await client.query(
                `INSERT INTO question_feedback
                    (run_id, knowledge_point_id, question_snapshot, scores, judge_reasons, critique, label)
                 VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7)
                 RETURNING id`,
                [
                    runId,
                    row.knowledge_point_id != null ? Number(row.knowledge_point_id) : null,
                    JSON.stringify(buildQuestionSnapshot(question, lang)),
                    JSON.stringify(row.scores || {}),
                    JSON.stringify(row.judge_reasons || {}),
                    critique ? JSON.stringify(critique) : null,
                    label,
                ]
            );
            if (insertRes.rows[0]) feedbackIds.push(insertRes.rows[0].id);
        }

        await client.query('COMMIT');

        console.log('[feedback] persisted diagnostic run:', {
            run_id: runId,
            feedback_count: feedbackIds.length,
            status,
        });

        // Adaptive loop: recurring negatives → prompt_patches for next generation.
        // Non-blocking for the audit chain; failures are logged only.
        promoteFeedbackToPatches(pool, auditEntry).catch((err) => {
            console.error('[feedback] auto prompt_patch failed:', err && err.message ? err.message : err);
        });

        return { run_id: runId, feedback_ids: feedbackIds };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function getPromptPatches(pool, { gradeId, subjectId, knowledgePointIds }) {
    const scopes = [{ scope: 'global', scope_id: 'all' }];
    if (Number.isInteger(gradeId) && Number.isInteger(subjectId)) {
        scopes.push({ scope: 'grade_subject', scope_id: `${gradeId}:${subjectId}` });
    }
    const kpIds = (Array.isArray(knowledgePointIds) ? knowledgePointIds : [])
        .map((id) => Number(id))
        .filter(Number.isInteger);
    for (const kpId of kpIds) {
        scopes.push({ scope: 'knowledge_point', scope_id: String(kpId) });
    }

    const patches = [];
    for (const { scope, scope_id } of scopes) {
        const res = await pool.query(
            `SELECT patch_text FROM prompt_patches
             WHERE active = TRUE AND scope = $1 AND scope_id = $2
             ORDER BY created_at DESC
             LIMIT 5`,
            [scope, scope_id]
        );
        for (const row of res.rows) {
            if (row.patch_text) patches.push(String(row.patch_text));
        }
    }
    return [...new Set(patches)].slice(0, 10);
}

async function getFewShotExamples(pool, { knowledgePointIds, lang, limit }) {
    const kpIds = (Array.isArray(knowledgePointIds) ? knowledgePointIds : [])
        .map((id) => Number(id))
        .filter(Number.isInteger);
    if (!kpIds.length) return { examples: [], ids: [] };

    const res = await pool.query(
        `SELECT id, knowledge_point_id, question_snapshot, scores, judge_reasons
         FROM question_feedback
         WHERE label = 'positive' AND knowledge_point_id = ANY($1::int[])
         ORDER BY created_at DESC
         LIMIT $2`,
        [kpIds, limit || FEW_SHOT_LIMIT]
    );

    return {
        examples: res.rows.map((row) => compactFewShot({
            knowledge_point_id: row.knowledge_point_id,
            question_snapshot: row.question_snapshot,
            scores: row.scores,
        }, lang)),
        ids: res.rows.map((row) => row.id),
    };
}

async function getAvoidPatterns(pool, { knowledgePointIds, limit }) {
    const kpIds = (Array.isArray(knowledgePointIds) ? knowledgePointIds : [])
        .map((id) => Number(id))
        .filter(Number.isInteger);
    if (!kpIds.length) return { patterns: [], ids: [] };

    const res = await pool.query(
        `SELECT id, knowledge_point_id, question_snapshot, scores, judge_reasons
         FROM question_feedback
         WHERE label = 'negative' AND knowledge_point_id = ANY($1::int[])
         ORDER BY created_at DESC
         LIMIT $2`,
        [kpIds, limit || AVOID_PATTERN_LIMIT]
    );

    const patterns = res.rows.map((row) => summarizeAvoidPattern({
        knowledge_point_id: row.knowledge_point_id,
        judge_reasons: row.judge_reasons,
        question: row.question_snapshot && row.question_snapshot.content_en
            ? row.question_snapshot.content_en
            : '',
    }));

    return {
        patterns: [...new Set(patterns)],
        ids: res.rows.map((row) => row.id),
    };
}

async function markFeedbackUsed(pool, ids) {
    const validIds = (Array.isArray(ids) ? ids : [])
        .map((id) => Number(id))
        .filter(Number.isInteger);
    if (!validIds.length) return;
    await pool.query(
        `UPDATE question_feedback
         SET used_in_prompt_at = NOW()
         WHERE id = ANY($1::int[])`,
        [validIds]
    );
}

async function getFeedbackContext(pool, { gradeId, subjectId, knowledgePointIds, lang }) {
    if (!pool || !isFeedbackStoreEnabled()) return emptyFeedbackContext();

    const [fewShot, avoid, patches] = await Promise.all([
        getFewShotExamples(pool, { knowledgePointIds, lang, limit: FEW_SHOT_LIMIT }),
        getAvoidPatterns(pool, { knowledgePointIds, limit: AVOID_PATTERN_LIMIT }),
        getPromptPatches(pool, { gradeId, subjectId, knowledgePointIds }),
    ]);

    const usedIds = [...fewShot.ids, ...avoid.ids];
    if (usedIds.length) {
        markFeedbackUsed(pool, usedIds).catch((err) => {
            console.error('[feedback] mark used failed:', err && err.message ? err.message : err);
        });
    }

    return {
        few_shot_good: fewShot.examples,
        avoid_patterns: avoid.patterns,
        prompt_patches: patches,
    };
}

async function loadFeedbackContextForPrompt(pool, opts) {
    if (!pool || !isFeedbackStoreEnabled()) {
        return JSON.stringify(emptyFeedbackContext());
    }
    try {
        const ctx = await getFeedbackContext(pool, opts);
        const hasContent = ctx.few_shot_good.length
            || ctx.avoid_patterns.length
            || ctx.prompt_patches.length;
        if (!hasContent) return JSON.stringify(emptyFeedbackContext());
        return JSON.stringify(ctx);
    } catch (err) {
        console.error('[feedback] load context failed:', err && err.message ? err.message : err);
        return JSON.stringify(emptyFeedbackContext());
    }
}

async function ensureFeedbackTables(pool) {
    if (!pool) return false;
    await pool.query(`CREATE TABLE IF NOT EXISTS diagnostic_runs (
        id UUID PRIMARY KEY,
        user_id INTEGER,
        grade_id INTEGER,
        subject_id INTEGER,
        lang TEXT,
        batch_scores JSONB,
        status TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS question_feedback (
        id SERIAL PRIMARY KEY,
        run_id UUID REFERENCES diagnostic_runs(id) ON DELETE CASCADE,
        knowledge_point_id INTEGER,
        question_snapshot JSONB,
        scores JSONB,
        judge_reasons JSONB,
        critique JSONB,
        label TEXT,
        used_in_prompt_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS prompt_patches (
        id SERIAL PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        patch_text TEXT NOT NULL,
        source_run_id UUID,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    try {
        await pool.query('CREATE INDEX IF NOT EXISTS question_feedback_kp_label_idx ON question_feedback(knowledge_point_id, label, created_at DESC)');
    } catch { /* ignore */ }
    try {
        await pool.query('CREATE INDEX IF NOT EXISTS prompt_patches_scope_idx ON prompt_patches(scope, scope_id, active, created_at DESC)');
    } catch { /* ignore */ }
    return true;
}

module.exports = {
    isFeedbackStoreEnabled,
    isAutoPatchEnabled,
    emptyFeedbackContext,
    labelQuestionRow,
    buildCritique,
    persistDiagnosticFeedback,
    promoteFeedbackToPatches,
    getFeedbackContext,
    loadFeedbackContextForPrompt,
    ensureFeedbackTables,
    THRESHOLDS,
    AUTO_PATCH_TEMPLATES,
};
