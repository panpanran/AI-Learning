'use strict';

const {
    computeMathResult,
    answersMatch,
    canAutoApplyMath,
    canAutoApplyLlm,
    proposedAnswersConsistentWithOptions,
    buildMathProposedFix,
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
