'use strict';

const {
    computeMathResult,
    answersMatch,
    canAutoApplyMath,
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
