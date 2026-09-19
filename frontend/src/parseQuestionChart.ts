export type QuestionChartKind = 'bar' | 'pie' | 'line'

export type QuestionChartSpec = {
    kind: QuestionChartKind
    labels: string[]
    values: number[]
    title?: string
    caption?: string
    illustrative?: boolean
}

export type ChartQuestionInput = {
    content?: string
    content_cn?: string
    content_en?: string
    metadata?: unknown
}

const KINDS = new Set<QuestionChartKind>(['bar', 'pie', 'line'])

const LABEL_STOP = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'by', 'with', 'from', 'at',
    'is', 'are', 'was', 'were', 'be', 'as', 'if', 'which', 'what', 'who', 'how', 'day', 'days',
    'student', 'students', 'chart', 'charts', 'graph', 'graphs', 'bar', 'bars', 'pie', 'line',
    'number', 'numbers', 'data', 'type', 'unit', 'units', 'over', 'than', 'most', 'look',
    'shows', 'show', 'showing', 'uses', 'using', 'read', 'books', 'book',
    '一个', '一种', '这个', '那个', '什么', '哪个', '哪些', '多少', '图表', '统计图', '柱状图',
    '条形图', '饼图', '折线', '折线图',
])

function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function isKind(v: unknown): v is QuestionChartKind {
    return typeof v === 'string' && KINDS.has(v as QuestionChartKind)
}

function toFiniteNumbers(raw: unknown): number[] | null {
    if (!Array.isArray(raw) || raw.length < 2) return null
    const out: number[] = []
    for (const x of raw) {
        const n = typeof x === 'number' ? x : Number(String(x).trim())
        if (!Number.isFinite(n)) return null
        out.push(n)
    }
    return out
}

function toLabels(raw: unknown): string[] | null {
    if (!Array.isArray(raw) || raw.length < 2) return null
    const out = raw.map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
    return out.length === raw.length ? out : null
}

function normalizeSpec(input: {
    kind?: unknown
    type?: unknown
    labels?: unknown
    values?: unknown
    title?: unknown
}): QuestionChartSpec | null {
    const kindRaw = input.kind != null ? input.kind : input.type
    if (!isKind(kindRaw)) return null
    const labels = toLabels(input.labels)
    const values = toFiniteNumbers(input.values)
    if (!labels || !values || labels.length !== values.length || labels.length < 2) return null
    const title = input.title != null && String(input.title).trim() ? String(input.title).trim() : undefined
    return title ? { kind: kindRaw, labels, values, title } : { kind: kindRaw, labels, values }
}

function chartFromMetadata(metadata: unknown): QuestionChartSpec | null {
    const meta = asRecord(metadata)
    if (!meta) return null
    return normalizeSpec(asRecord(meta.chart) || {})
}

function pickStem(q: ChartQuestionInput, lang?: 'zh' | 'en'): string {
    const cn = String(q.content_cn || '')
    const en = String(q.content_en || '')
    const fallback = String(q.content || '')
    if (lang === 'zh') return cn || en || fallback
    if (lang === 'en') return en || cn || fallback
    return en || cn || fallback
}

function detectKinds(text: string): QuestionChartKind[] {
    const t = String(text || '').toLowerCase()
    const out: QuestionChartKind[] = []
    if (/pie\s*chart|饼图/.test(t)) out.push('pie')
    if (/line\s*(graph|chart)|折线/.test(t)) out.push('line')
    if (/bar\s*(chart|graph)|柱状|条形图|条形/.test(t)) out.push('bar')
    return out
}

function bareNumbers(text: string): number[] {
    const out: number[] = []
    const re = /-?\d+(?:\.\d+)?/g
    let m: RegExpExecArray | null
    while ((m = re.exec(String(text || '')))) {
        const n = Number(m[0])
        if (Number.isFinite(n)) out.push(n)
    }
    return out
}

function hashStem(s: string): number {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 16777619)
    }
    return h >>> 0
}

function seededInt(seed: number, i: number, min: number, max: number): number {
    let x = (seed + i * 9973) >>> 0
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
    x = (x ^ (x >>> 16)) >>> 0
    const span = max - min + 1
    return min + (x % span)
}

function illustrativeLabels(stem: string, lang?: 'zh' | 'en'): string[] {
    const t = String(stem || '').toLowerCase()
    const monthly = /month|monthly|rainfall|rain|降水|降雨|月/.test(t)
    if (monthly) {
        return lang === 'zh' ? ['1月', '2月', '3月', '4月'] : ['Jan', 'Feb', 'Mar', 'Apr']
    }
    return lang === 'zh' ? ['甲', '乙', '丙', '丁'] : ['A', 'B', 'C', 'D']
}

function isTrueConceptStem(text: string): boolean {
    const t = String(text || '').toLowerCase()
    const hasConcreteScene = /show(?:s|ing)\s+\w+|look at|as shown|如图|看图|见下图|rainfall|降水|降雨|sales|temperature|monthly/.test(t)
    const asksMeaning =
        /what does .{0,80}represent/.test(t)
        || /what (does|do) (the )?(length|bars?|slices?)/.test(t)
        || /长度表示什么|表示什么(数量|数据|含义)/.test(t)
        || /which type of (chart|graph)/.test(t)
        || /what (is|are) (a |an )?(bar|pie|line) (chart|graph)/.test(t)
    if (!asksMeaning) return false
    if (hasConcreteScene && /tallest|highest|this chart|the chart shows/.test(t)) return false
    if (/in a (bar|pie|line) (chart|graph)/.test(t) && !hasConcreteScene) return true
    return !hasConcreteScene
}

function illustrativeChart(stem: string, kind: QuestionChartKind, lang?: 'zh' | 'en'): QuestionChartSpec {
    const labels = illustrativeLabels(stem, lang)
    const seed = hashStem(`${kind}|${stem}`)
    const values = labels.map((_, i) => seededInt(seed, i, 3, 12))
    const zh = lang === 'zh'
    return {
        kind,
        labels,
        values,
        illustrative: true,
        title: zh ? '示意图' : 'Example',
        caption: zh ? '示意图，数字仅供参考，不是题目数据' : 'Example chart; numbers are not part of the question',
    }
}

function cleanLabel(raw: string): string | null {
    const s = String(raw || '').replace(/^[,，、;；:：]+|[,，、;；:：]+$/g, '').trim()
    if (!s) return null
    if (LABEL_STOP.has(s.toLowerCase())) return null
    if (/^\d+$/.test(s)) return null
    if (s.length > 32) return null
    return s
}

function extractLabelNumberPairs(text: string): { labels: string[]; values: number[] } | null {
    const src = String(text || '')
    const labelFirst: { labels: string[]; values: number[] } = { labels: [], values: [] }
    const labelFirstRe = /([A-Za-z\u4e00-\u9fff][A-Za-z\u4e00-\u9fff'’\-]{0,24})\s*[：:=]?\s*(-?\d+(?:\.\d+)?)/g
    let m: RegExpExecArray | null
    while ((m = labelFirstRe.exec(src))) {
        const label = cleanLabel(m[1])
        const value = Number(m[2])
        if (!label || !Number.isFinite(value)) continue
        labelFirst.labels.push(label)
        labelFirst.values.push(value)
    }
    if (labelFirst.labels.length >= 2) return labelFirst

    const numberFirst: { labels: string[]; values: number[] } = { labels: [], values: [] }
    const numberFirstRe = /(-?\d+(?:\.\d+)?)\s+([A-Za-z\u4e00-\u9fff][A-Za-z\u4e00-\u9fff'’\-]{0,24})/g
    while ((m = numberFirstRe.exec(src))) {
        const value = Number(m[1])
        const label = cleanLabel(m[2])
        if (!label || !Number.isFinite(value)) continue
        numberFirst.labels.push(label)
        numberFirst.values.push(value)
    }
    if (numberFirst.labels.length >= 2) return numberFirst
    return null
}

export function parseQuestionChart(
    q: ChartQuestionInput | null | undefined,
    lang?: 'zh' | 'en'
): QuestionChartSpec | null {
    if (!q) return null
    const fromMeta = chartFromMetadata(q.metadata)
    if (fromMeta) return fromMeta

    const stem = pickStem(q, lang)
    const kinds = detectKinds(stem)
    const kind = kinds.length === 1 ? kinds[0] : null
    if (!kind) return null
    const pairs = extractLabelNumberPairs(stem)
    if (pairs) return { kind, labels: pairs.labels, values: pairs.values }
    if (bareNumbers(stem).length >= 2) return null
    if (isTrueConceptStem(stem)) return null
    return illustrativeChart(stem, kind, lang)
}
