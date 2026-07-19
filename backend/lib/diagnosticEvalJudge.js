'use strict';

const OpenAI = require('openai');

const DEFAULT_METRICS = [
    'kp_alignment',
    'explanation_support',
    'distractor_quality',
];

let openaiClient = null;

function isDiagnosticJudgeEnabled() {
    if (String(process.env.DIAG_EVAL_LLM ?? '1').trim() === '0') return false;
    return Boolean(String(process.env.OPENAI_API_KEY || '').trim());
}

function parseEnabledMetrics(override) {
    if (Array.isArray(override) && override.length) {
        return override.filter(Boolean);
    }
    const raw = process.env.DIAG_EVAL_METRICS || DEFAULT_METRICS.join(',');
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function getJudgeClient() {
    if (!openaiClient && process.env.OPENAI_API_KEY) {
        openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiClient;
}

function getJudgeModel() {
    return process.env.DIAG_EVAL_MODEL
        || process.env.OPENAI_MODEL
        || 'gpt-4o-mini';
}

function parseJsonObject(text) {
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
        return null;
    }
}

function buildJudgePrompt(sample, metrics) {
    const ctx = sample.eval_context || {};
    const lines = [
        'Evaluate this diagnostic multiple-choice question.',
        '',
        `Question (${sample.question ? 'active lang' : 'n/a'}): ${sample.question || ''}`,
        `Correct answer: ${sample.answer || ''}`,
        `Explanation: ${sample.explanation || sample.ground_truth || ''}`,
        `Options: ${JSON.stringify(sample.options || [])}`,
        '',
        'Assigned knowledge point:',
        `- id: ${ctx.kp_id != null ? ctx.kp_id : 'unknown'}`,
        `- name: ${ctx.kp_name || ''}`,
        `- unit: ${ctx.unit_name || ''}`,
        `- description: ${ctx.description || ''}`,
    ];
    if (ctx.grade_guidance) {
        lines.push(`- grade guidance: ${ctx.grade_guidance}`);
    }

    lines.push('', 'Return JSON with this shape:');
    lines.push('{');

    if (metrics.includes('kp_alignment')) {
        lines.push('  "kp_alignment": { "score": 0.0-1.0, "reason": "..." },');
    }
    if (metrics.includes('explanation_support')) {
        lines.push('  "explanation_support": { "pass": true|false, "reason": "..." },');
    }
    if (metrics.includes('distractor_quality')) {
        lines.push('  "distractor_quality": { "score": 0.0-1.0, "reason": "..." }');
    }

    lines.push('}', '', 'Scoring guidance:');
    if (metrics.includes('kp_alignment')) {
        lines.push('- kp_alignment: 1 = question primarily tests the assigned KP; 0 = tests a different skill/topic.');
    }
    if (metrics.includes('explanation_support')) {
        lines.push('- explanation_support: pass if the explanation logically supports the marked correct answer.');
    }
    if (metrics.includes('distractor_quality')) {
        lines.push('- distractor_quality: 1 = three wrong options are plausible but clearly incorrect; penalize multiple correct or absurd distractors.');
    }

    return lines.join('\n');
}

function normalizeJudgePayload(parsed, metrics) {
    const scores = {};
    const judgeReasons = {};

    if (metrics.includes('kp_alignment') && parsed && parsed.kp_alignment) {
        const score = Number(parsed.kp_alignment.score);
        if (Number.isFinite(score)) scores.kp_alignment = Math.max(0, Math.min(1, score));
        if (parsed.kp_alignment.reason) judgeReasons.kp_alignment = String(parsed.kp_alignment.reason);
    }

    if (metrics.includes('explanation_support') && parsed && parsed.explanation_support) {
        scores.explanation_support = Boolean(parsed.explanation_support.pass);
        if (parsed.explanation_support.reason) {
            judgeReasons.explanation_support = String(parsed.explanation_support.reason);
        }
    }

    if (metrics.includes('distractor_quality') && parsed && parsed.distractor_quality) {
        const score = Number(parsed.distractor_quality.score);
        if (Number.isFinite(score)) scores.distractor_quality = Math.max(0, Math.min(1, score));
        if (parsed.distractor_quality.reason) {
            judgeReasons.distractor_quality = String(parsed.distractor_quality.reason);
        }
    }

    return { scores, judge_reasons: judgeReasons };
}

async function judgeOneSample(sample, metrics, model) {
    const client = getJudgeClient();
    if (!client) return { scores: null, judge_reasons: null, error: 'OpenAI not configured' };

    const judgeMetricIds = new Set(['kp_alignment', 'explanation_support', 'distractor_quality']);
    const activeMetrics = metrics.filter((m) => judgeMetricIds.has(m));
    if (!activeMetrics.length) return { scores: {}, judge_reasons: {} };

    const params = {
        model,
        temperature: 0,
        messages: [
            {
                role: 'system',
                content: 'You evaluate educational MCQ quality. Respond with valid JSON only.',
            },
            {
                role: 'user',
                content: buildJudgePrompt(sample, activeMetrics),
            },
        ],
    };

    let completion;
    try {
        completion = await client.chat.completions.create({
            ...params,
            response_format: { type: 'json_object' },
        });
    } catch (err) {
        const msg = (err && err.message) ? String(err.message) : String(err);
        if (msg.toLowerCase().includes('response_format')) {
            completion = await client.chat.completions.create(params);
        } else {
            throw err;
        }
    }

    const content = completion.choices && completion.choices[0] && completion.choices[0].message
        ? completion.choices[0].message.content
        : '';
    const parsed = parseJsonObject(content);
    if (!parsed) {
        return { scores: null, judge_reasons: null, error: 'Failed to parse judge JSON' };
    }

    return normalizeJudgePayload(parsed, activeMetrics);
}

function meanOf(rows, field) {
    const values = rows
        .map((row) => (row.scores && row.scores[field] != null ? Number(row.scores[field]) : NaN))
        .filter(Number.isFinite);
    if (!values.length) return null;
    return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10000) / 10000;
}

function computeJudgeBatch(rows) {
    return {
        mean_kp_alignment: meanOf(rows, 'kp_alignment'),
        mean_distractor_quality: meanOf(rows, 'distractor_quality'),
        explanation_support_rate: (() => {
            const vals = rows.filter((row) => row.scores && typeof row.scores.explanation_support === 'boolean');
            if (!vals.length) return null;
            const passCount = vals.filter((row) => row.scores.explanation_support).length;
            return passCount / vals.length;
        })(),
    };
}

/**
 * Run Layer B LLM judges for each diagnostic sample.
 * @param {object[]} samples from buildDiagnosticEvalSamples
 */
async function runDiagnosticJudge(samples, options = {}) {
    if (!isDiagnosticJudgeEnabled()) return { rows: [], batch: {} };
    if (!Array.isArray(samples) || !samples.length) return { rows: [], batch: {} };

    const metrics = parseEnabledMetrics(options.metrics);
    const model = getJudgeModel();
    const rows = [];

    for (const sample of samples) {
        try {
            const result = await judgeOneSample(sample, metrics, model);
            rows.push(result);
        } catch (err) {
            console.error('[diag-judge] sample failed:', err && err.message ? err.message : err);
            rows.push({
                scores: null,
                judge_reasons: null,
                error: err && err.message ? err.message : String(err),
            });
        }
    }

    return {
        rows,
        batch: computeJudgeBatch(rows),
    };
}

module.exports = {
    isDiagnosticJudgeEnabled,
    parseEnabledMetrics,
    runDiagnosticJudge,
    computeJudgeBatch,
};
