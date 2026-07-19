'use strict';

/**
 * HTTP client for Python agents service (Phase B).
 */

function getAgentsServiceUrl() {
    return String(process.env.AGENTS_SERVICE_URL || '').trim().replace(/\/$/, '');
}

function isAgentsServiceEnabled() {
    return Boolean(getAgentsServiceUrl());
}

function isAgentsDiagnosticRunEnabled() {
    return isAgentsServiceEnabled() && String(process.env.AGENTS_DIAGNOSTIC_RUN ?? '0').trim() !== '0';
}

async function agentsFetch(path, body, timeoutMs) {
    const baseUrl = getAgentsServiceUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 300000);
    try {
        const response = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Agents service returned ${response.status}: ${text}`);
        }
        return response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function runAgentsQualityAudit({ questions, kpList, lang, meta }) {
    const baseUrl = getAgentsServiceUrl();
    if (!baseUrl) return null;

        const result = await agentsFetch('/v1/diagnostic/quality/run', {
            questions,
            kp_list: kpList || [],
            lang: lang || 'en',
            knowledge_point_ids_plan: meta && meta.knowledgePointIdsPlan,
            grade_guidance: meta && meta.gradeGuidance ? meta.gradeGuidance : '',
            meta: {
                userId: meta && meta.userId,
                gradeId: meta && meta.gradeId,
                subjectId: meta && meta.subjectId,
            },
            max_refine_rounds: Number(process.env.DIAG_MAX_REFINE_ROUNDS) || 2,
            enable_refine: String(process.env.DIAG_REFINE_ENABLED ?? '1').trim() !== '0',
        }, Number(process.env.AGENTS_SERVICE_TIMEOUT_MS) || 300000);
        return {
            schema_version: 2,
            batch_id: result.batch_id,
            at: new Date().toISOString(),
            question_count: questions.length,
            lang: lang || 'en',
            meta: meta || {},
            batch: result.batch || {},
            rows: result.rows || [],
            questions: result.questions || questions,
            refine_rounds: result.refine_rounds || 0,
            status: result.status || 'ok',
            source: 'agents-service',
        };
}

function normalizeFeedbackContext(feedbackContext) {
    // loadFeedbackContextForPrompt returns a JSON string for Express prompt
    // templates; agents service expects an object. Accept either.
    if (!feedbackContext) return {};
    if (typeof feedbackContext === 'object' && !Array.isArray(feedbackContext)) {
        return feedbackContext;
    }
    if (typeof feedbackContext === 'string') {
        try {
            const parsed = JSON.parse(feedbackContext);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {
            // fall through
        }
    }
    return {};
}

async function runAgentsDiagnosticRun({
    numQuestions,
    kpList,
    lang,
    studentProfile,
    studentUserIds,
    gradeId,
    subjectId,
    gradeGuidance,
    feedbackContext,
    avoidMetadata,
    persist,
}) {
    if (!isAgentsDiagnosticRunEnabled()) return null;

    const result = await agentsFetch('/v1/diagnostic/run', {
        num_questions: numQuestions || 5,
        kp_list: kpList || [],
        lang: lang || 'en',
        student_profile: studentProfile || {},
        student_user_ids: studentUserIds || [],
        grade_id: gradeId,
        subject_id: subjectId,
        grade_guidance: gradeGuidance || '',
        feedback_context: normalizeFeedbackContext(feedbackContext),
        avoid_metadata: avoidMetadata || [],
        retrieval_snippets: [],
        use_db_planner: Boolean(gradeId && subjectId),
        check_db_hashes: Boolean(gradeId && subjectId),
        persist: Boolean(persist),
        max_refine_rounds: Number(process.env.DIAG_MAX_REFINE_ROUNDS) || 2,
        enable_refine: String(process.env.DIAG_REFINE_ENABLED ?? '1').trim() !== '0',
        meta: {
            userId: studentProfile && studentProfile.id,
            gradeId,
            subjectId,
        },
    }, Number(process.env.AGENTS_DIAGNOSTIC_TIMEOUT_MS) || 600000);

    return result;
}

module.exports = {
    isAgentsServiceEnabled,
    isAgentsDiagnosticRunEnabled,
    runAgentsQualityAudit,
    runAgentsDiagnosticRun,
};
