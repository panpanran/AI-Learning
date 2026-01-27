import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import API from './api'

type HistoryItem = {
    questionId?: number
    givenAnswer?: string
    correct?: boolean
    created_at?: string
    content_cn?: string
    content_en?: string
    answer_cn?: string
    answer_en?: string
    explanation_cn?: string
    explanation_en?: string
    knowledge_point_id?: number
    knowledge_point_name_cn?: string
    knowledge_point_name_en?: string
}

function toDayKey(iso: string) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return 'Unknown'
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}

function formatLocalDateTime(iso: string, locale: string) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const tz = (() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone
        } catch {
            return undefined
        }
    })()
    try {
        return new Intl.DateTimeFormat(locale, {
            dateStyle: 'medium',
            timeStyle: 'medium',
            timeZoneName: 'short',
            ...(tz ? { timeZone: tz } : {}),
        }).format(d)
    } catch {
        return d.toLocaleString(locale)
    }
}

export default function HistoryPage({ token }: { token: string }) {
    const { i18n, t } = useTranslation()
    const [query, setQuery] = useState('')
    const [loading, setLoading] = useState(false)
    const [items, setItems] = useState<HistoryItem[]>([])
    // 新增：筛选类型 all/correct/wrong
    const [filter, setFilter] = useState<'all' | 'correct' | 'wrong'>('all')

    useEffect(() => {
        let cancelled = false
        const run = async () => {
            setLoading(true)
            try {
                const r = await API.get('/api/history/full', {
                    headers: { Authorization: `Bearer ${token}` },
                    params: query ? { q: query } : undefined,
                })
                if (!cancelled) setItems((r && r.data && r.data.history) || [])
            } catch (e) {
                if (!cancelled) setItems([])
            }
            if (!cancelled) setLoading(false)
        }

        const t = setTimeout(run, 250)
        return () => {
            cancelled = true
            clearTimeout(t)
        }
    }, [token, query])

    // 新增：根据 filter 过滤 items
    const filteredItems = useMemo(() => {
        if (filter === 'all') return items
        if (filter === 'correct') return items.filter(x => x.correct)
        if (filter === 'wrong') return items.filter(x => x.correct === false)
        return items
    }, [items, filter])

    const grouped = useMemo(() => {
        const byDay = new Map<string, HistoryItem[]>()
        for (const it of filteredItems) {
            const k = toDayKey(it.created_at || '')
            const arr = byDay.get(k) || []
            arr.push(it)
            byDay.set(k, arr)
        }
        const days = Array.from(byDay.keys()).sort((a, b) => (a < b ? 1 : -1))
        return days.map(day => {
            const list = byDay.get(day) || []
            const correctCount = list.filter(x => x.correct).length
            return { day, list, correctCount }
        })
    }, [filteredItems])

    const lang = i18n.language === 'zh' ? 'zh' : 'en'
    const locale = lang === 'zh' ? 'zh-CN' : 'en-US'

    return (
        <div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
                <input
                    className="input-large"
                    style={{ flex: 1, padding: '12px 14px', borderRadius: 12 }}
                    placeholder={lang === 'zh' ? '关键字搜索（题目/解析/答案/知识点）' : 'Search (question/explanation/answer/knowledge point)'}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                {/* 新增：筛选下拉菜单 */}
                <select
                    value={filter}
                    onChange={e => setFilter(e.target.value as 'all' | 'correct' | 'wrong')}
                    style={{ padding: '8px 10px', borderRadius: 8 }}
                >
                    <option value="all">{lang === 'zh' ? '全部' : 'All'}</option>
                    <option value="correct">{lang === 'zh' ? '只看做对' : 'Correct only'}</option>
                    <option value="wrong">{lang === 'zh' ? '只看做错' : 'Wrong only'}</option>
                </select>
                <span className="badge badge-info">{loading ? (lang === 'zh' ? '加载中' : 'Loading') : `${filteredItems.length}`}</span>
            </div>

            {grouped.length === 0 ? (
                <div className="placeholder">{lang === 'zh' ? '暂无历史记录' : 'No history yet.'}</div>
            ) : (
                grouped.map(g => (
                    <details key={g.day} className="card" style={{ marginBottom: 12 }}>
                        <summary className="summary-row">
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 10 }}>
                                <div style={{ fontWeight: 700 }}>{g.day}</div>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <span className="badge badge-info">{g.correctCount}/{g.list.length}</span>
                                </div>
                            </div>
                        </summary>

                        <div style={{ marginTop: 10 }}>
                            {g.list.map((it, idx) => {
                                const content = lang === 'zh' ? (it.content_cn || '') : (it.content_en || '')
                                const correctAnswer = lang === 'zh' ? (it.answer_cn || '') : (it.answer_en || '')
                                const explanation = lang === 'zh' ? (it.explanation_cn || '') : (it.explanation_en || '')
                                const kpName = lang === 'zh'
                                    ? (it.knowledge_point_name_cn || '')
                                    : (it.knowledge_point_name_en || '')
                                const kpLabel = kpName || (it.knowledge_point_id != null ? `${t('knowledge_point')} #${it.knowledge_point_id}` : '')
                                return (
                                    <div key={`${it.questionId || 'q'}:${it.created_at || idx}`} className="card" style={{ background: '#fbfdff', marginBottom: 10 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                                            <div className="muted">{formatLocalDateTime(it.created_at || '', locale) || '-'}</div>
                                            <span className={it.correct ? 'badge badge-success' : 'badge badge-danger'}>
                                                {it.correct ? (lang === 'zh' ? '正确' : 'Correct') : (lang === 'zh' ? '错误' : 'Wrong')}
                                            </span>
                                        </div>

                                        <div style={{ marginTop: 8 }}>
                                            <div><strong>{lang === 'zh' ? '题目：' : 'Q: '}</strong>{content || '-'}</div>
                                            <div style={{ marginTop: 6 }}><strong>{lang === 'zh' ? '你的答案：' : 'Your answer: '}</strong>{it.givenAnswer || '-'}</div>
                                            <div><strong>{lang === 'zh' ? '正确答案：' : 'Correct answer: '}</strong>{correctAnswer || '-'}</div>
                                            {kpLabel ? (
                                                <div><strong>{lang === 'zh' ? '知识点：' : 'Knowledge point: '}</strong>{kpLabel}</div>
                                            ) : null}
                                        </div>

                                        {explanation ? (
                                            <div style={{ marginTop: 8 }}>
                                                <div><strong>{lang === 'zh' ? '解析：' : 'Explanation: '}</strong></div>
                                                <div className="ai-text">{explanation}</div>
                                            </div>
                                        ) : null}
                                    </div>
                                )
                            })}
                        </div>
                    </details>
                ))
            )}
        </div>
    )
}
