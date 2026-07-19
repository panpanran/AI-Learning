'use strict';

const { buildDiagnosticEvalSamples } = require('./ragasSamples');
const { runDiagnosticRules } = require('./diagnosticEvalRules');
const { isDiagnosticJudgeEnabled, runDiagnosticJudge } = require('./diagnosticEvalJudge');

/**
 * LangWatch: one evaluation span per diagnostic question.
 * OUTPUT is a flat JSON of numeric scores only.
 */

const LANGWATCH_EVAL_ENDPOINT = 'https://app.langwatch.ai/api/evaluations';

let initialized = false;
let initPromise = null;
let tracer = null;

function isLangWatchEnabled() {
    return Boolean(String(process.env.LANGWATCH_API_KEY || '').trim());
}

async function ensureLangWatchInit() {
    if (!isLangWatchEnabled()) return false;
    if (initialized) return true;
    if (!initPromise) {
        initPromise = (async () => {
            const { setupObservability } = require('langwatch/observability/node');
            const { getLangWatchTracer } = require('langwatch');

            await setupObservability({
                serviceName: process.env.LANGWATCH_SERVICE_NAME || 'maxailearning-backend',
                langwatch: {
                    apiKey: process.env.LANGWATCH_API_KEY,
                },
            });

            tracer = getLangWatchTracer(process.env.LANGWATCH_SERVICE_NAME || 'maxailearning-backend');
            initialized = true;
        })();
    }
    await initPromise;
    return true;
}

function buildQuestionInput(sample, ruleRow) {
    const ctx = sample.eval_context || {};
    return {
        question: sample.question,
        answer: sample.answer,
        explanation: sample.explanation || sample.ground_truth,
        options: sample.options,
        knowledge_point: {
            id: ctx.kp_id,
            name: ctx.kp_name,
            unit: ctx.unit_name,
            description: ctx.description,
        },
        rules: ruleRow && ruleRow.rules ? ruleRow.rules : undefined,
    };
}

function collectQuestionScores(judgeRow, responseRelevancyScore) {
    const scores = {};
    const judgeScores = judgeRow && judgeRow.scores ? judgeRow.scores : {};

    if (Number.isFinite(Number(judgeScores.kp_alignment))) {
        scores.kp_alignment = Number(judgeScores.kp_alignment);
    }
    if (typeof judgeScores.explanation_support === 'boolean') {
        scores.explanation_support = judgeScores.explanation_support ? 1 : 0;
    }
    if (Number.isFinite(Number(judgeScores.distractor_quality))) {
        scores.distractor_quality = Number(judgeScores.distractor_quality);
    }
    if (Number.isFinite(Number(responseRelevancyScore))) {
        scores.response_relevancy = Number(responseRelevancyScore);
    }
    if (Number.isFinite(Number(judgeScores.answer_relevancy))) {
        scores.answer_relevancy = Number(judgeScores.answer_relevancy);
    }

    return scores;
}

/**
 * Call LangWatch evaluator API without creating a separate evaluation span.
 */
async function fetchResponseRelevancyScore(sample) {
    const apiKey = process.env.LANGWATCH_API_KEY;
    const judgeModel = process.env.LANGWATCH_EVAL_MODEL || 'openai/gpt-4o-mini';
    const slug = 'ragas/response_relevancy';

    const response = await fetch(`${LANGWATCH_EVAL_ENDPOINT}/${slug}/evaluate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Auth-Token': apiKey,
        },
        body: JSON.stringify({
            data: {
                input: sample.question,
                output: sample.answer,
            },
            settings: { model: judgeModel },
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Evaluation API returned ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    return result && result.score != null ? Number(result.score) : null;
}

async function reportQuestionEvaluation(sample, judgeRow, ruleRow, questionIndex) {
    let responseRelevancy = null;
    try {
        responseRelevancy = await fetchResponseRelevancyScore(sample);
    } catch (err) {
        console.error('[langwatch] response_relevancy failed:', err && err.message ? err.message : err);
    }

    const scores = collectQuestionScores(judgeRow, responseRelevancy);

    await tracer.withActiveSpan(`diagnostic-q${questionIndex + 1}`, async (span) => {
        span.setType('evaluation');
        span.setInput(buildQuestionInput(sample, ruleRow));
        span.setOutput(scores);
    });

    return scores;
}

async function reportDiagnosticEvaluations({
    questions, kpList, lang, userId, gradeId, subjectId, knowledgePointIdsPlan,
}) {
    if (!isLangWatchEnabled()) return;

    const samples = buildDiagnosticEvalSamples(questions, kpList, lang);
    if (!samples.length) return;

    const ruleResult = runDiagnosticRules(questions, kpList, { lang, knowledgePointIdsPlan });
    let judgeResult = { rows: [], batch: {} };
    if (isDiagnosticJudgeEnabled()) {
        judgeResult = await runDiagnosticJudge(samples);
    }

    const ok = await ensureLangWatchInit();
    if (!ok || !tracer) return;

    await tracer.withActiveSpan('diagnostic-generate', async (span) => {
        span.setType('rag');
        const attrs = {
            'langwatch.span.type': 'rag',
            'diagnostic.lang': lang || 'en',
            'diagnostic.question_count': samples.length,
            'diagnostic.rule_pass_rate': ruleResult.batch.rule_pass_rate,
        };
        if (judgeResult.batch.mean_kp_alignment != null) {
            attrs['diagnostic.mean_kp_alignment'] = judgeResult.batch.mean_kp_alignment;
        }
        if (judgeResult.batch.mean_distractor_quality != null) {
            attrs['diagnostic.mean_distractor_quality'] = judgeResult.batch.mean_distractor_quality;
        }
        if (userId != null) attrs['langwatch.user.id'] = String(userId);
        if (gradeId != null) attrs['diagnostic.grade_id'] = String(gradeId);
        if (subjectId != null) attrs['diagnostic.subject_id'] = String(subjectId);
        span.setAttributes(attrs);

        const questionScores = [];
        for (let i = 0; i < samples.length; i++) {
            const scores = await reportQuestionEvaluation(
                samples[i],
                judgeResult.rows[i] || {},
                ruleResult.rows[i],
                i
            );
            questionScores.push({ index: i, scores });
        }

        span.setOutput({
            evaluated_questions: samples.length,
            rule_batch: ruleResult.batch,
            judge_batch: judgeResult.batch,
            questions: questionScores,
        });
    });
}

function queueDiagnosticLangWatchEvaluations(opts) {
    if (!isLangWatchEnabled()) return;
    setImmediate(() => {
        reportDiagnosticEvaluations(opts).catch((err) => {
            console.error('[langwatch] async report failed:', err && err.message ? err.message : err);
        });
    });
}

module.exports = {
    isLangWatchEnabled,
    ensureLangWatchInit,
    queueDiagnosticLangWatchEvaluations,
    collectQuestionScores,
    buildQuestionInput,
};
