import { describe, expect, it } from 'vitest'
import { parseQuestionChart, stripLeakedUnitFromStem } from './parseQuestionChart'

describe('parseQuestionChart', () => {
    it('uses metadata.chart bar spec (AC-1)', () => {
        const spec = parseQuestionChart({
            content_en: 'Look at the chart.',
            metadata: {
                chart: {
                    type: 'bar',
                    labels: ['Monday', 'Tuesday', 'Wednesday'],
                    values: [30, 45, 40],
                    title: 'Sales',
                },
            },
        }, 'en')
        expect(spec).toEqual({
            kind: 'bar',
            labels: ['Monday', 'Tuesday', 'Wednesday'],
            values: [30, 45, 40],
            title: 'Sales',
        })
    })

    it('parses Q2292-style labeled bar stem (AC-1)', () => {
        const spec = parseQuestionChart({
            content_en: 'Look at a bar chart showing sales: Monday 30, Tuesday 45, Wednesday 40. Which day had the highest sales?',
        }, 'en')
        expect(spec?.kind).toBe('bar')
        expect(spec?.labels).toEqual(['Monday', 'Tuesday', 'Wednesday'])
        expect(spec?.values).toEqual([30, 45, 40])
    })

    it('parses pie metadata and line stems (AC-3)', () => {
        const pie = parseQuestionChart({
            metadata: {
                chart: {
                    kind: 'pie',
                    labels: ['Apple', 'Banana', 'Orange'],
                    values: [5, 3, 7],
                },
            },
        }, 'en')
        expect(pie?.kind).toBe('pie')
        expect(pie?.labels.length).toBe(3)
        expect(pie?.values).toEqual([5, 3, 7])
        expect(pie?.illustrative).toBeFalsy()

        const line = parseQuestionChart({
            content_en: 'A line graph shows temperature: Monday 18, Tuesday 21, Wednesday 19. Which day was warmest?',
        }, 'en')
        expect(line?.kind).toBe('line')
        expect(line?.labels.length).toBe(line?.values.length)
        expect(line!.labels.length).toBeGreaterThanOrEqual(2)
        expect(line?.values).toEqual([18, 21, 19])
        expect(line?.illustrative).toBeFalsy()
    })

    it('draws a stable example bar for rainfall-unit stems (illustrative AC-1)', () => {
        const q = {
            content_en: 'Which unit is used in a bar chart showing monthly rainfall in millimeters?',
        }
        const a = parseQuestionChart(q, 'en')
        const b = parseQuestionChart(q, 'en')
        expect(a?.kind).toBe('bar')
        expect(a?.illustrative).toBe(true)
        expect(a?.labels.length).toBeGreaterThanOrEqual(2)
        expect(a?.values.length).toBe(a?.labels.length)
        expect(b?.values).toEqual(a?.values)
        expect(a?.title).toMatch(/example/i)
        expect(a?.caption).toMatch(/not part of the question/i)
    })

    it('does not pick a kind when the stem lists bar, pie, and line (illustrative AC-2)', () => {
        const spec = parseQuestionChart({
            content_en: 'Which graph is best to show how many students like different fruits: bar graph, pie chart, or line graph?',
        }, 'en')
        expect(spec).toBeNull()
    })

    it('does not invent a chart from unlabeled number lists (illustrative AC-3)', () => {
        const spec = parseQuestionChart({
            content_en: 'A bar chart shows the number of books read by students: 5, 8, 12, 7. Which number is the largest?',
        }, 'en')
        expect(spec).toBeNull()
    })

    it('skips true concept stems such as bar-length meaning', () => {
        const spec = parseQuestionChart({
            content_en: 'In a bar chart, what does the length of the bar represent?',
        }, 'en')
        expect(spec).toBeNull()
    })

    it('strips leaked unit from English rainfall stem (AC-1)', () => {
        const shown = stripLeakedUnitFromStem(
            'Which unit is used in a bar chart showing monthly rainfall in millimeters?',
            'Millimeters'
        )
        expect(shown.toLowerCase()).not.toContain('millimeter')
        expect(shown.toLowerCase()).toContain('monthly rainfall')
        expect(stripLeakedUnitFromStem(
            'Which unit is used in a bar chart showing monthly rainfall in millimeters?'
        ).toLowerCase()).not.toContain('millimeter')
    })

    it('puts mm on the Y axis for rainfall unit questions (AC-2)', () => {
        const spec = parseQuestionChart({
            content_en: 'Which unit is used in a bar chart showing monthly rainfall in millimeters?',
            answer_en: 'Millimeters',
            answer_cn: '毫米',
        }, 'en')
        expect(spec?.yLabel).toBe('mm')
        expect(parseQuestionChart({
            content_cn: '条形图显示每月降雨量，单位是什么？',
            answer_cn: '毫米',
        }, 'zh')?.yLabel).toBe('毫米')
    })
})
