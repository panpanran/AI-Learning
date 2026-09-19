'use strict';

const {
    computeMathResult,
    answersMatch,
    canAutoApplyMath,
    canAutoApplyLlm,
    proposedAnswersConsistentWithOptions,
    buildMathProposedFix,
    historyAnswerIsCorrect,
    rescoreHistoryForQuestion,
    applyProposedFix,
} = require('../lib/userFeedbackTriage');

describe('userFeedbackTriage math helpers', () => {
    it('computes addition/multiplication/division', () => {
        expect(computeMathResult({ type: 'addition', nums: [299, 501] })).toBe('800');
        expect(computeMathResult({ type: 'multiplication', nums: [12, 4] })).toBe('48');
        expect(computeMathResult({ type: 'division', nums: [12, 3] })).toBe('4');
    });

    it('matches numeric answers loosely', () => {
        expect(answersMatch('800', '800')).toBe(true);
        expect(answersMatch('800', '800 apples')).toBe(true);
    });

    it('auto-applies when bank answer wrong and option exists', () => {
        const question = {
            answer_cn: '700',
            answer_en: '700',
            metadata: { type: 'addition', nums: [299, 501] },
            options: { zh: ['700', '800', '900', '600'], en: ['700', '800', '900', '600'] },
        };
        const proposed = buildMathProposedFix(question, '800');
        expect(canAutoApplyMath(question, proposed)).toBe(true);
        expect(proposed.answer_en).toBe('800');
    });

    it('does not auto-apply without matching option', () => {
        const question = {
            answer_cn: '700',
            answer_en: '700',
            metadata: { type: 'addition', nums: [299, 501] },
            options: { zh: ['1', '2', '3', '4'], en: ['1', '2', '3', '4'] },
        };
        const proposed = buildMathProposedFix(question, '800');
        expect(canAutoApplyMath(question, proposed)).toBe(false);
    });
});

describe('userFeedbackTriage LLM CAE apply gates', () => {
    const question = {
        content_cn: '旧题干',
        content_en: 'old stem',
        answer_cn: 'A',
        answer_en: 'A',
        explanation_cn: '旧解析',
        explanation_en: 'old expl',
        options: { zh: ['A', 'B', 'C', 'D'], en: ['A', 'B', 'C', 'D'] },
    };

    it('allows high-confidence content/answer/explanation fix in options', () => {
        const proposed = {
            content_cn: '新题干',
            content_en: 'new stem',
            answer_cn: 'B',
            answer_en: 'B',
            explanation_cn: '新解析',
            explanation_en: 'new expl',
        };
        expect(proposedAnswersConsistentWithOptions(question, proposed)).toBe(true);
        expect(canAutoApplyLlm(question, proposed, 0.9)).toBe(true);
    });

    it('rejects answer not in options', () => {
        const proposed = { answer_cn: 'Z', answer_en: 'Z' };
        expect(proposedAnswersConsistentWithOptions(question, proposed)).toBe(false);
        expect(canAutoApplyLlm(question, proposed, 0.99)).toBe(false);
    });

    it('rejects low confidence', () => {
        const proposed = { explanation_cn: '更好的解析', explanation_en: 'better' };
        expect(canAutoApplyLlm(question, proposed, 0.4)).toBe(false);
    });
});

function makeHistoryPool({ question, historyRows }) {
    const calls = [];
    const rows = (historyRows || []).map((r) => ({ ...r }));
    const q = { ...(question || {}) };
    const pool = {
        calls,
        rows,
        async query(sql, params) {
            const s = String(sql).replace(/\s+/g, ' ');
            calls.push({ sql: s, params });
            if (/UPDATE questions SET/i.test(s)) {
                return { rows: [], rowCount: 1 };
            }
            if (/FROM questions WHERE id/i.test(s)) {
                return { rows: q.id != null || q.answer_cn != null || q.answer_en != null ? [q] : [] };
            }
            if (/FROM history WHERE question_id/i.test(s)) {
                return { rows: rows.map((r) => ({ ...r })) };
            }
            if (/UPDATE history SET correct/i.test(s)) {
                const next = params[0];
                const ids = Array.isArray(params[1]) ? params[1] : [params[1]];
                for (const id of ids) {
                    const row = rows.find((r) => r.id === id);
                    if (row) row.correct = next;
                }
                return { rows: [], rowCount: ids.length };
            }
            throw new Error(`unexpected query: ${s}`);
        },
    };
    return pool;
}

describe('history rescore after bank answer fix', () => {
    it('treats 3/4 as matching the current bank answers (AC-1 matcher)', () => {
        expect(historyAnswerIsCorrect('3/4', '3/4', '3/4')).toBe(true);
        expect(historyAnswerIsCorrect('3/4', '3/4', 'three fourths')).toBe(true);
    });

    it('rescored matching given_answer becomes correct (AC-1)', async () => {
        const pool = makeHistoryPool({
            question: { id: 2345, answer_cn: '3/4', answer_en: '3/4' },
            historyRows: [
                { id: 11, given_answer: '3/4', correct: false },
            ],
        });
        const out = await rescoreHistoryForQuestion(pool, 2345);
        expect(pool.rows[0].correct).toBe(true);
        expect(out.correctTrue).toBe(1);
        expect(out.updated).toBe(1);
    });

    it('rescored mismatch becomes false even if previously true (AC-2)', async () => {
        const pool = makeHistoryPool({
            question: { id: 2345, answer_cn: '3/4', answer_en: '3/4' },
            historyRows: [
                { id: 12, given_answer: '2/3', correct: true },
            ],
        });
        const out = await rescoreHistoryForQuestion(pool, 2345);
        expect(historyAnswerIsCorrect('2/3', '3/4', '3/4')).toBe(false);
        expect(pool.rows[0].correct).toBe(false);
        expect(out.correctFalse).toBe(1);
        expect(out.updated).toBe(1);
    });

    it('applyProposedFix with answer fields rescored history (AC-3)', async () => {
        const pool = makeHistoryPool({
            question: { id: 2345, answer_cn: '3/4', answer_en: '3/4' },
            historyRows: [
                { id: 11, given_answer: '3/4', correct: false },
            ],
        });
        await applyProposedFix(pool, 2345, { answer_cn: '3/4', answer_en: '3/4' });
        expect(pool.rows[0].correct).toBe(true);
        expect(pool.calls.some((c) => /UPDATE history SET correct/i.test(c.sql))).toBe(true);
    });

    it('explanation-only apply does not rescore history (AC-3 / AC-4 skip)', async () => {
        const pool = makeHistoryPool({
            question: { id: 2345, answer_cn: '3/4', answer_en: '3/4' },
            historyRows: [
                { id: 11, given_answer: '3/4', correct: false },
            ],
        });
        await applyProposedFix(pool, 2345, {
            explanation_cn: '9/12 simplifies to 3/4',
            explanation_en: '9/12 simplifies to 3/4',
        });
        expect(pool.rows[0].correct).toBe(false);
        expect(pool.calls.some((c) => /FROM history/i.test(c.sql))).toBe(false);
        expect(pool.calls.some((c) => /UPDATE history/i.test(c.sql))).toBe(false);
    });
});
