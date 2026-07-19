'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsPath = require('path');
const { spawn } = require('child_process');
const { buildDiagnosticEvalSamples } = require('./ragasSamples');
const { isDiagnosticRulesEnabled, runDiagnosticRules } = require('./diagnosticEvalRules');
const { isDiagnosticJudgeEnabled, runDiagnosticJudge } = require('./diagnosticEvalJudge');
const { isFeedbackStoreEnabled, persistDiagnosticFeedback } = require('./feedbackStore');
const { isAgentsServiceEnabled, runAgentsQualityAudit } = require('./agentClient');

const RAGAS_DIR = fsPath.resolve(__dirname, '..', '..', 'ragas');
const INBOX_DIR = fsPath.join(RAGAS_DIR, 'inbox');
const AUDIT_LOG = fsPath.join(RAGAS_DIR, 'audit_log.jsonl');
const EVALUATE_SCRIPT = fsPath.join(RAGAS_DIR, 'evaluate_ragas.py');

let auditChain = Promise.resolve();

function isRagasAuditEnabled() {
    if (String(process.env.RAGAS_AUDIT || '1').trim() === '0') return false;
    return Boolean(String(process.env.OPENAI_API_KEY || '').trim());
}

function isDiagnosticAuditEnabled() {
    return isDiagnosticRulesEnabled() || isRagasAuditEnabled() || isDiagnosticJudgeEnabled();
}

function resolvePythonExecutable() {
    if (process.env.RAGAS_PYTHON) return process.env.RAGAS_PYTHON;

    const candidates = [
        fsPath.join(RAGAS_DIR, '..', '.venv', 'Scripts', 'python.exe'),
        fsPath.join(RAGAS_DIR, '..', '.venv', 'bin', 'python'),
        fsPath.join(RAGAS_DIR, '.venv', 'Scripts', 'python.exe'),
        fsPath.join(RAGAS_DIR, '.venv', 'bin', 'python'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return 'python';
}

function runProcess(cmd, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            env: { ...process.env, ...env },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const err = new Error(`Ragas process exited with code ${code}`);
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            }
        });
    });
}

async function runPythonRagas(samples, batchId) {
    if (!isRagasAuditEnabled() || !samples.length) return { result: null, error: null };

    fs.mkdirSync(INBOX_DIR, { recursive: true });

    const inputPath = fsPath.join(INBOX_DIR, `${batchId}.jsonl`);
    const outputPath = fsPath.join(INBOX_DIR, `${batchId}.result.json`);

    const legacyRows = samples.map((row) => ({
        question: row.question,
        answer: row.answer,
        contexts: row.contexts,
        ground_truth: row.ground_truth,
    }));

    fs.writeFileSync(
        inputPath,
        legacyRows.map((row) => JSON.stringify(row)).join('\n') + '\n',
        'utf8'
    );

    const python = resolvePythonExecutable();
    const envLocal = fsPath.resolve(__dirname, '..', '..', '..', '.env.local');

    try {
        await runProcess(python, [
            EVALUATE_SCRIPT,
            '--input', inputPath,
            '--output', outputPath,
            '--quiet',
        ], {
            PYTHONIOENCODING: 'utf-8',
            DOTENV_PATH: envLocal,
        });

        let result = null;
        if (fs.existsSync(outputPath)) {
            result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        }
        return { result, error: null };
    } catch (err) {
        return { result: null, error: err };
    } finally {
        try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
        try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    }
}

function mergeAnswerRelevancy(rows, pythonRows) {
    if (!Array.isArray(rows) || !Array.isArray(pythonRows)) return rows;
    return rows.map((row, index) => {
        const pythonRow = pythonRows[index];
        if (!pythonRow || pythonRow.answer_relevancy == null) return row;
        const scores = { ...(row.scores || {}), answer_relevancy: pythonRow.answer_relevancy };
        return { ...row, scores };
    });
}

async function runAgentsAuditPath({ questions, kpList, lang, meta }) {
    const auditMeta = meta || {};
    const agentsResult = await runAgentsQualityAudit({ questions, kpList, lang, meta: auditMeta });
    if (!agentsResult) return null;

    const refinedQuestions = agentsResult.questions || questions;
    const samples = buildDiagnosticEvalSamples(refinedQuestions, kpList, lang, {
        gradeGuidance: auditMeta.gradeGuidance,
    });

    const pythonOutcome = await runPythonRagas(samples, agentsResult.batch_id);
    if (pythonOutcome.error) {
        console.error('[ragas] python relevancy failed (agents path):', pythonOutcome.error.message || pythonOutcome.error);
    }

    const pythonResult = pythonOutcome.result;
    let rows = agentsResult.rows || [];
    if (pythonResult && pythonResult.rows) {
        rows = mergeAnswerRelevancy(rows, pythonResult.rows);
    }

    const batch = { ...(agentsResult.batch || {}) };
    if (pythonResult && pythonResult.aggregate && pythonResult.aggregate.answer_relevancy != null) {
        batch.mean_answer_relevancy = pythonResult.aggregate.answer_relevancy;
    }

    let status = agentsResult.status || 'ok';
    if (pythonOutcome.error) status = 'partial';

    const auditEntry = {
        schema_version: 2,
        batch_id: agentsResult.batch_id,
        at: agentsResult.at || new Date().toISOString(),
        question_count: refinedQuestions.length,
        lang: lang || 'en',
        meta: auditMeta,
        batch,
        rows,
        aggregate: pythonResult && pythonResult.aggregate ? pythonResult.aggregate : null,
        status,
        refine_rounds: agentsResult.refine_rounds || 0,
        source: 'agents-service',
        questions: refinedQuestions,
    };

    fs.appendFileSync(AUDIT_LOG, JSON.stringify(auditEntry) + '\n', 'utf8');

    if (auditMeta.pool && isFeedbackStoreEnabled() && rows.length) {
        try {
            await persistDiagnosticFeedback(auditMeta.pool, auditEntry, refinedQuestions);
        } catch (err) {
            console.error('[feedback] persist failed:', err && err.message ? err.message : err);
        }
    }

    console.log('[agents] quality audit complete:', {
        batch_id: auditEntry.batch_id,
        questions: refinedQuestions.length,
        status: auditEntry.status,
        refine_rounds: auditEntry.refine_rounds,
        batch: auditEntry.batch,
        log: AUDIT_LOG,
    });

    return auditEntry;
}

function mergeAuditRows(ruleRows, pythonRows, judgeRows) {
    return ruleRows.map((row, index) => {
        const pythonRow = Array.isArray(pythonRows) ? pythonRows[index] : null;
        const judgeRow = Array.isArray(judgeRows) ? judgeRows[index] : null;
        const scores = {};

        if (pythonRow && pythonRow.answer_relevancy != null) {
            scores.answer_relevancy = pythonRow.answer_relevancy;
        }
        if (judgeRow && judgeRow.scores && typeof judgeRow.scores === 'object') {
            Object.assign(scores, judgeRow.scores);
        }

        const merged = { ...row };
        if (Object.keys(scores).length) merged.scores = scores;
        if (judgeRow && judgeRow.judge_reasons && Object.keys(judgeRow.judge_reasons).length) {
            merged.judge_reasons = judgeRow.judge_reasons;
        }
        if (judgeRow && judgeRow.error) merged.judge_error = judgeRow.error;
        return merged;
    });
}

async function runRagasAudit({ questions, kpList, lang, meta }) {
    if (!isDiagnosticAuditEnabled()) return null;
    if (!Array.isArray(questions) || !questions.length) return null;

    if (isAgentsServiceEnabled()) {
        try {
            return await runAgentsAuditPath({ questions, kpList, lang, meta });
        } catch (err) {
            console.error('[agents] audit failed, falling back to node path:', err && err.message ? err.message : err);
        }
    }

    const batchId = crypto.randomUUID();
    const auditMeta = meta || {};

    let ruleResult = null;
    if (isDiagnosticRulesEnabled()) {
        ruleResult = runDiagnosticRules(questions, kpList, {
            lang,
            knowledgePointIdsPlan: auditMeta.knowledgePointIdsPlan,
        });
    }

    const samples = buildDiagnosticEvalSamples(questions, kpList, lang, {
        gradeGuidance: auditMeta.gradeGuidance,
    });

    const [judgeOutcome, pythonOutcome] = await Promise.all([
        isDiagnosticJudgeEnabled() ? runDiagnosticJudge(samples) : Promise.resolve({ rows: [], batch: {} }),
        runPythonRagas(samples, batchId),
    ]);

    if (pythonOutcome.error) {
        console.error('[ragas] python audit failed:', pythonOutcome.error.message || pythonOutcome.error);
        if (pythonOutcome.error.stderr) {
            console.error('[ragas] stderr:', pythonOutcome.error.stderr.slice(0, 2000));
        }
    }

    const pythonResult = pythonOutcome.result;
    const judgeResult = judgeOutcome;

    const batch = {
        ...(ruleResult && ruleResult.batch ? ruleResult.batch : {}),
        ...(judgeResult && judgeResult.batch ? judgeResult.batch : {}),
    };
    if (pythonResult && pythonResult.aggregate && pythonResult.aggregate.answer_relevancy != null) {
        batch.mean_answer_relevancy = pythonResult.aggregate.answer_relevancy;
    }

    const rows = ruleResult
        ? mergeAuditRows(
            ruleResult.rows,
            pythonResult && pythonResult.rows,
            judgeResult && judgeResult.rows
        )
        : null;

    let status = 'ok';
    if (pythonOutcome.error && judgeResult.rows.some((r) => r.error)) {
        status = ruleResult ? 'partial' : 'error';
    } else if (pythonOutcome.error) {
        status = ruleResult ? 'partial' : 'error';
    } else if (judgeResult.rows.some((r) => r.error) && isDiagnosticJudgeEnabled()) {
        status = ruleResult ? 'partial' : 'ok';
    } else if (!pythonResult && isRagasAuditEnabled() && !judgeResult.rows.length) {
        status = ruleResult ? 'rules_only' : 'empty';
    } else if (!pythonResult && isRagasAuditEnabled() && judgeResult.rows.length) {
        status = ruleResult ? 'ok' : 'ok';
    }

    const auditEntry = {
        schema_version: 2,
        batch_id: batchId,
        at: new Date().toISOString(),
        question_count: questions.length,
        lang: lang || 'en',
        meta: auditMeta,
        batch,
        rows,
        aggregate: pythonResult && pythonResult.aggregate ? pythonResult.aggregate : null,
        status,
    };

    fs.appendFileSync(AUDIT_LOG, JSON.stringify(auditEntry) + '\n', 'utf8');

    if (meta.pool && isFeedbackStoreEnabled() && rows && rows.length) {
        try {
            await persistDiagnosticFeedback(meta.pool, auditEntry, questions);
        } catch (err) {
            console.error('[feedback] persist failed:', err && err.message ? err.message : err);
        }
    }

    console.log('[ragas] audit complete:', {
        batch_id: batchId,
        questions: questions.length,
        status: auditEntry.status,
        batch: auditEntry.batch,
        log: AUDIT_LOG,
    });

    return auditEntry;
}

/**
 * Queue diagnostic audit after diagnostic returns (non-blocking for HTTP response).
 */
function queueRagasAudit(opts) {
    if (!isDiagnosticAuditEnabled()) return;

    auditChain = auditChain
        .then(() => runRagasAudit(opts))
        .catch((err) => {
            console.error('[ragas] audit failed:', err && err.message ? err.message : err);
            if (err && err.stderr) console.error('[ragas] stderr:', err.stderr.slice(0, 2000));
        });
}

module.exports = {
    isRagasAuditEnabled,
    isDiagnosticRulesEnabled,
    isDiagnosticJudgeEnabled,
    isDiagnosticAuditEnabled,
    buildDiagnosticEvalSamples,
    queueRagasAudit,
    runRagasAudit,
    runDiagnosticRules,
    runDiagnosticJudge,
    AUDIT_LOG,
};
