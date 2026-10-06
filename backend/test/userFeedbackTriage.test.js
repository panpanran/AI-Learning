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
    resolveGivenAnswerForOptions,
    decideUserFeedback,
    listUserFeedback,
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
        expect(answersMatch('500个', '500')).toBe(true);
    });

    it('does not treat a numeric prefix as the same number', () => {
        expect(answersMatch('500', '50')).toBe(false);
        expect(answersMatch('50', '5')).toBe(false);
        expect(answersMatch('3/4', '3')).toBe(false);
        expect(answersMatch('0.5', '0')).toBe(false);
        expect(answersMatch('500个', '50')).toBe(false);
    });

    it('picks the exact place-value option, not a prefix of it', () => {
        const options = { zh: ['5', '50', '500', '5000'], en: ['5', '50', '500', '5000'] };
        expect(resolveGivenAnswerForOptions(options, '500')).toEqual({ answer_cn: '500', answer_en: '500' });
        expect(resolveGivenAnswerForOptions({ zh: ['5000', '5'] }, '50')).toBeNull();
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

function makeDecidePool({ question, feedback }) {
    const calls = [];
    const pool = {
        calls,
        async query(sql, params) {
            const s = String(sql).replace(/\s+/g, ' ');
            calls.push({ sql: s, params });
            if (/FROM user_question_feedback WHERE id/i.test(s)) return { rows: [{ ...feedback }] };
            if (/UPDATE user_question_feedback/i.test(s)) return { rows: [], rowCount: 1 };
            if (/UPDATE questions SET/i.test(s)) return { rows: [], rowCount: 1 };
            if (/FROM questions WHERE id/i.test(s)) return { rows: [{ ...question }] };
            if (/FROM history WHERE question_id/i.test(s)) return { rows: [] };
            throw new Error(`unexpected query: ${s}`);
        },
    };
    return pool;
}

describe('accept with the given answer on bilingual options', () => {
    const fruitQuestion = {
        id: 7,
        answer_cn: '苹果',
        answer_en: 'apple',
        options: { zh: ['苹果', '香蕉', '橙子'], en: ['apple', 'banana', 'orange'] },
    };

    it('pairs a zh given answer with the en option at the same index', () => {
        expect(resolveGivenAnswerForOptions(fruitQuestion.options, '香蕉'))
            .toEqual({ answer_cn: '香蕉', answer_en: 'banana' });
    });

    it('pairs an en given answer with the zh option at the same index', () => {
        expect(resolveGivenAnswerForOptions(fruitQuestion.options, 'orange'))
            .toEqual({ answer_cn: '橙子', answer_en: 'orange' });
    });

    it('returns null when the given answer matches no option', () => {
        expect(resolveGivenAnswerForOptions(fruitQuestion.options, '西瓜')).toBeNull();
    });

    it('keeps the given answer when the question has no options', () => {
        expect(resolveGivenAnswerForOptions(null, '42')).toEqual({ answer_cn: '42', answer_en: '42' });
    });

    it('decide accept applies a zh given answer when zh and en options differ', async () => {
        const pool = makeDecidePool({
            question: fruitQuestion,
            feedback: { id: 9, user_id: 1, question_id: 7, status: 'acknowledged', given_answer: '香蕉', proposed_fix: { reason: 'x' } },
        });
        const out = await decideUserFeedback(pool, { feedbackId: 9, userIds: [1], action: 'accept' });
        expect(out.status).toBe('applied');
        const update = pool.calls.find((c) => /UPDATE questions SET/i.test(c.sql));
        expect(update.params).toContain('香蕉');
        expect(update.params).toContain('banana');
    });

    it('decide accept still applies numeric answers shared by both languages', async () => {
        const pool = makeDecidePool({
            question: { id: 8, answer_cn: '500个', answer_en: '500', options: { zh: ['500个', '600个'], en: ['500', '600'] } },
            feedback: { id: 10, user_id: 1, question_id: 8, status: 'open', given_answer: '600个', proposed_fix: null },
        });
        const out = await decideUserFeedback(pool, { feedbackId: 10, userIds: [1], action: 'accept' });
        expect(out.status).toBe('applied');
    });

    it('decide accept still rejects a given answer outside the options', async () => {
        const pool = makeDecidePool({
            question: fruitQuestion,
            feedback: { id: 11, user_id: 1, question_id: 7, status: 'acknowledged', given_answer: '西瓜', proposed_fix: null },
        });
        await expect(decideUserFeedback(pool, { feedbackId: 11, userIds: [1], action: 'accept' }))
            .rejects.toMatchObject({ status: 400 });
    });
});

describe('original snapshot and reject-revert (FS-20260927-feedback-original-and-revert)', () => {
    const original = {
        id: 7,
        content_cn: '原题干',
        content_en: 'original stem',
        answer_cn: '苹果',
        answer_en: 'apple',
        explanation_cn: '',
        explanation_en: '',
        options: { zh: ['苹果', '香蕉'], en: ['apple', 'banana'] },
    };

    it('accept stores the pre-fix question before updating it, guarded by IS NULL (AC-1, AC-2)', async () => {
        const pool = makeDecidePool({
            question: original,
            feedback: { id: 20, user_id: 1, question_id: 7, status: 'acknowledged', given_answer: '香蕉', proposed_fix: null },
        });
        await decideUserFeedback(pool, { feedbackId: 20, userIds: [1], action: 'accept' });
        const snapIdx = pool.calls.findIndex((c) => /SET original_snapshot/i.test(c.sql));
        const updIdx = pool.calls.findIndex((c) => /UPDATE questions SET/i.test(c.sql));
        expect(snapIdx).toBeGreaterThanOrEqual(0);
        expect(snapIdx).toBeLessThan(updIdx);
        expect(pool.calls[snapIdx].sql).toMatch(/original_snapshot IS NULL/i);
        const snap = JSON.parse(pool.calls[snapIdx].params[1]);
        expect(snap.answer_cn).toBe('苹果');
        expect(snap.answer_en).toBe('apple');
        expect(snap.options).toEqual(original.options);
    });

    it('list returns original_snapshot as original (AC-3)', async () => {
        const pool = {
            async query() {
                return {
                    rows: [{
                        id: 20, user_id: 1, question_id: 7, status: 'applied',
                        original_snapshot: { answer_cn: '苹果', answer_en: 'apple', options: original.options },
                        answer_cn: '香蕉', answer_en: 'banana',
                    }, {
                        id: 21, user_id: 1, question_id: 7, status: 'applied', original_snapshot: null,
                    }],
                };
            },
        };
        const items = await listUserFeedback(pool, { userIds: [1] });
        expect(items[0].original.answer_cn).toBe('苹果');
        expect(items[0].question.answer_cn).toBe('香蕉');
        expect(items[1].original).toBeNull();
    });

    it('reject on applied restores every CAE field from the snapshot and dismisses (AC-4)', async () => {
        const pool = makeDecidePool({
            question: { ...original, answer_cn: '香蕉', answer_en: 'banana', explanation_cn: '新解析' },
            feedback: {
                id: 22, user_id: 1, question_id: 7, status: 'applied', given_answer: '香蕉',
                proposed_fix: { answer_cn: '香蕉' },
                original_snapshot: { ...original },
            },
        });
        const out = await decideUserFeedback(pool, { feedbackId: 22, userIds: [1], action: 'reject' });
        expect(out).toMatchObject({ status: 'dismissed', reverted: true });
        const restore = pool.calls.find((c) => /UPDATE questions SET content_cn = \$1/i.test(c.sql));
        expect(restore.params).toEqual(['原题干', 'original stem', '苹果', 'apple', '', '', 7]);
        expect(pool.calls.some((c) => /FROM history WHERE question_id/i.test(c.sql))).toBe(true);
        const status = pool.calls.find((c) => /SET status = 'dismissed'/i.test(c.sql));
        expect(JSON.parse(status.params[1])).toMatchObject({ human_decision: 'reject', reverted: true });
    });

    it('reject on applied without a snapshot returns 409 and writes nothing (AC-5)', async () => {
        const pool = makeDecidePool({
            question: original,
            feedback: { id: 23, user_id: 1, question_id: 7, status: 'applied', proposed_fix: {}, original_snapshot: null },
        });
        await expect(decideUserFeedback(pool, { feedbackId: 23, userIds: [1], action: 'reject' }))
            .rejects.toMatchObject({ status: 409 });
        expect(pool.calls.some((c) => /^\s*UPDATE/i.test(c.sql))).toBe(false);
    });
});
