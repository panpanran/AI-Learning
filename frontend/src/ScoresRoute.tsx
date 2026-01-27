import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
// ...existing code...
import API from './api'

type ScoreRow = {
    grade_id: number | null
    grade_name_zh: string
    grade_name_en: string
    subject_id: number | null
    subject_name_zh: string
    subject_name_en: string
    knowledge_point_id: number | null
    knowledge_point_name_cn: string
    knowledge_point_name_en: string
    total: number
    correct: number
    score_percent: number
}

function CollapsibleCard(props: {
    title: string
    meta?: string
    open: boolean
    onToggle: () => void
    children: React.ReactNode
}) {
    const { title, meta, open, onToggle, children } = props
    return (
        <div className="card" style={{ marginBottom: 12 }}>
            <div
                role="button"
                tabIndex={0}
                onClick={onToggle}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onToggle()
                    }
                }}
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    userSelect: 'none',
                }}
                aria-expanded={open}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{
                        display: 'inline-block',
                        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 120ms ease',
                        color: '#666',
                        fontSize: 14,
                        lineHeight: '14px',
                    }}>
                        ▶
                    </span>
                    <div style={{ fontWeight: 800 }}>{title}</div>
                </div>
                {meta ? <div className="meta">{meta}</div> : null}
            </div>
            {open ? (
                <div style={{ marginTop: 10 }}>
                    {children}
                </div>
            ) : null}
        </div>
    )
}

function CollapsibleSection(props: {
    title: string
    meta?: string
    open: boolean
    onToggle: () => void
    children: React.ReactNode
    indentPx?: number
    contentIndentPx?: number
}) {
    const { title, meta, open, onToggle, children, indentPx = 0, contentIndentPx = 0 } = props
    return (
        <div style={{ paddingTop: 10, borderTop: '1px solid #f2f2f2', marginLeft: indentPx }}>
            <div
                role="button"
                tabIndex={0}
                onClick={onToggle}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onToggle()
                    }
                }}
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    userSelect: 'none',
                }}
                aria-expanded={open}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{
                        display: 'inline-block',
                        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 120ms ease',
                        color: '#666',
                        fontSize: 12,
                        lineHeight: '12px',
                    }}>
                        ▶
                    </span>
                    <div style={{ fontWeight: 800 }}>{title}</div>
                </div>
                {meta ? <div className="meta">{meta}</div> : null}
            </div>

            {open ? (
                <div style={{ marginTop: 8, marginLeft: contentIndentPx }}>
                    {children}
                </div>
            ) : null}
        </div>
    )
}

function ScoresRoute() {
    const navigate = useNavigate()
    const { t, i18n } = useTranslation()

    const token = localStorage.getItem('token')

    const setLang = (lng: 'zh' | 'en') => {
        try { localStorage.setItem('lang', lng) } catch { }
        i18n.changeLanguage(lng)
    }

    const lang = i18n.language === 'zh' ? 'zh' : 'en'

    const [loading, setLoading] = useState(false)
    const [generatingKey, setGeneratingKey] = useState<string | null>(null)
    const [items, setItems] = useState<ScoreRow[]>([])
    const [openGrades, setOpenGrades] = useState<Record<string, boolean>>({})
    const [openSubjects, setOpenSubjects] = useState<Record<string, boolean>>({})

    const PRACTICE_NUM_QUESTIONS = 5

    useEffect(() => {
        let cancelled = false
        const run = async () => {
            if (!token) return
            setLoading(true)
            try {
                const r = await API.get('/api/scores/knowledge-points', {
                    headers: { Authorization: `Bearer ${token}` },
                })
                const rows: ScoreRow[] = (r && r.data && Array.isArray(r.data.items)) ? r.data.items : []
                if (!cancelled) setItems(rows)
            } catch {
                if (!cancelled) setItems([])
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        run()
        return () => { cancelled = true }
    }, [token])

    const grouped = useMemo(() => {
        type SubjectGroup = { key: string, subject: string, rows: ScoreRow[] }
        type GradeGroup = { key: string, grade: string, subjects: SubjectGroup[], total: number }

        const gradeMap = new Map<string, { key: string, grade: string, subjectMap: Map<string, SubjectGroup> }>()

        for (const row of items) {
            const grade = lang === 'zh' ? (row.grade_name_zh || '') : (row.grade_name_en || '')
            const subject = lang === 'zh' ? (row.subject_name_zh || '') : (row.subject_name_en || '')

            const gradeKey = String(row.grade_id ?? 'null')
            const subjectKey = String(row.subject_id ?? 'null')

            const gradeBucket = gradeMap.get(gradeKey) || { key: gradeKey, grade, subjectMap: new Map<string, SubjectGroup>() }
            const subjectBucket = gradeBucket.subjectMap.get(subjectKey) || { key: subjectKey, subject, rows: [] }
            subjectBucket.rows.push(row)
            gradeBucket.subjectMap.set(subjectKey, subjectBucket)
            gradeMap.set(gradeKey, gradeBucket)
        }

        const grades: GradeGroup[] = Array.from(gradeMap.values()).map(g => {
            const subjects = Array.from(g.subjectMap.values())
            subjects.sort((a, b) => (a.subject || '').localeCompare(b.subject || '', lang === 'zh' ? 'zh-CN' : 'en'))
            for (const s of subjects) {
                s.rows.sort((a, b) => {
                    const an = lang === 'zh' ? (a.knowledge_point_name_cn || '') : (a.knowledge_point_name_en || '')
                    const bn = lang === 'zh' ? (b.knowledge_point_name_cn || '') : (b.knowledge_point_name_en || '')
                    return an.localeCompare(bn, lang === 'zh' ? 'zh-CN' : 'en')
                })
            }
            const total = subjects.reduce((sum, s) => sum + s.rows.length, 0)
            return { key: g.key, grade: g.grade, subjects, total }
        })

        grades.sort((a, b) => (a.grade || '').localeCompare(b.grade || '', lang === 'zh' ? 'zh-CN' : 'en'))
        return grades
    }, [items, lang])

    if (!token) {
        return (
            <div className="container" style={{ justifyContent: 'center' }}>
                <div className="hero-card" style={{ maxWidth: 820 }}>
                    <h2 style={{ textAlign: 'center', marginTop: 0 }}>{t('kp_scores')}</h2>
                    <div className="placeholder">{t('please_login')}</div>
                    <div style={{ textAlign: 'center' }}>
                        <button className="btn primary" onClick={() => navigate('/')}>{t('login')}</button>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="container" style={{ justifyContent: 'center' }}>
            <div className="hero-card" style={{ maxWidth: 820 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div className="menu-bar" aria-label="Menu">
                        <button
                            type="button"
                            className="menu-icon-btn"
                            onClick={() => navigate('/app')}
                            aria-label={t('home')}
                            title={t('home')}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-9.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                            </svg>
                        </button>

                        <button
                            type="button"
                            className="menu-icon-btn"
                            onClick={() => navigate('/history')}
                            aria-label={t('history')}
                            title={t('history')}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 8v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M21 12a9 9 0 1 1-3.1-6.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M21 5v5h-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </button>

                        <button
                            type="button"
                            className="menu-icon-btn active"
                            onClick={() => { /* already here */ }}
                            aria-label={t('kp_scores')}
                            title={t('kp_scores')}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M5 20V10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                                <path d="M12 20V4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                                <path d="M19 20V14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                            </svg>
                        </button>
                    </div>

                    <div className="lang-controls" style={{ position: 'static', display: 'flex', gap: 6 }}>
                        <button className="btn" onClick={() => setLang('zh')}>中文</button>
                        <button className="btn" onClick={() => setLang('en')}>EN</button>
                    </div>
                </div>

                <div style={{ textAlign: 'center', marginBottom: 12 }}>
                    <h2 style={{ margin: 0 }}>{t('kp_scores')}</h2>
                    <div className="meta" style={{ marginTop: 6 }}>{t('kp_scores_note')}</div>
                </div>

                {loading ? (
                    <div style={{ textAlign: 'center', margin: '24px 0' }}>
                        <div className="loader" />
                    </div>
                ) : items.length === 0 ? (
                    <div className="placeholder" style={{ textAlign: 'center' }}>{t('kp_scores_empty')}</div>
                ) : (
                    <div style={{ marginTop: 16 }}>
                        {grouped.map(g => (
                            <CollapsibleCard
                                key={g.key}
                                title={g.grade || '-'}
                                meta={t('kp_scores_count', { count: g.total })}
                                open={!!openGrades[g.key]}
                                onToggle={() => setOpenGrades(prev => ({ ...prev, [g.key]: !prev[g.key] }))}
                            >
                                {g.subjects.map(s => {
                                    const subjectOpenKey = `${g.key}:${s.key}`
                                    return (
                                        <CollapsibleSection
                                            key={subjectOpenKey}
                                            title={s.subject || '-'}
                                            meta={t('kp_scores_count', { count: s.rows.length })}
                                            open={!!openSubjects[subjectOpenKey]}
                                            onToggle={() => setOpenSubjects(prev => ({ ...prev, [subjectOpenKey]: !prev[subjectOpenKey] }))}
                                            indentPx={24}
                                            contentIndentPx={24}
                                        >
                                            {s.rows.map((r, idx) => {
                                                const kpName = lang === 'zh' ? (r.knowledge_point_name_cn || '') : (r.knowledge_point_name_en || '')
                                                const label = kpName || `${t('kp')} #${r.knowledge_point_id ?? '-'}`
                                                const passed = (Number(r.score_percent) > 95) && (Number(r.total) > 20)
                                                const rowKey = `${String(r.grade_id)}:${String(r.subject_id)}:${String(r.knowledge_point_id)}:${idx}`
                                                return (
                                                    <div key={`${String(r.knowledge_point_id)}:${idx}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '6px 0', borderTop: '1px solid #f7f7f7' }}>
                                                        <div style={{ fontWeight: 600 }}>{label}</div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                            <button
                                                                type="button"
                                                                aria-label={lang === 'zh' ? '针对该知识点练习' : 'Practice this knowledge point'}
                                                                title={lang === 'zh' ? '专项练习' : 'Targeted practice'}
                                                                disabled={!!generatingKey}
                                                                onClick={async () => {
                                                                    if (!token) return
                                                                    if (!Number.isInteger(Number(r.grade_id)) || !Number.isInteger(Number(r.subject_id)) || !Number.isInteger(Number(r.knowledge_point_id))) return
                                                                    setGeneratingKey(rowKey)
                                                                    try {
                                                                        const resp = await API.post('/api/generate/practice', {
                                                                            token,
                                                                            grade_id: Number(r.grade_id),
                                                                            subject_id: Number(r.subject_id),
                                                                            knowledge_point_id: Number(r.knowledge_point_id),
                                                                            num_questions: PRACTICE_NUM_QUESTIONS,
                                                                            lang: i18n.language,
                                                                        })
                                                                        const diagnostic = {
                                                                            lessonId: null,
                                                                            lesson: resp.data?.lesson,
                                                                            questions: resp.data?.questions || [],
                                                                        }
                                                                        navigate('/app', {
                                                                            state: {
                                                                                practice: {
                                                                                    gradeId: String(r.grade_id),
                                                                                    subjectId: String(r.subject_id),
                                                                                    diagnostic,
                                                                                }
                                                                            }
                                                                        })
                                                                    } catch (e) {
                                                                        // keep quiet; user can retry
                                                                    } finally {
                                                                        setGeneratingKey(null)
                                                                    }
                                                                }}
                                                                style={{
                                                                    width: 32,
                                                                    height: 32,
                                                                    borderRadius: 999,
                                                                    border: '1px solid #eee',
                                                                    background: generatingKey === rowKey ? '#f7f7f7' : '#fff',
                                                                    cursor: generatingKey ? 'not-allowed' : 'pointer',
                                                                    display: 'flex',
                                                                    alignItems: 'center',
                                                                    justifyContent: 'center',
                                                                    padding: 0,
                                                                }}
                                                            >
                                                                {generatingKey === rowKey ? (
                                                                    <span className="meta">…</span>
                                                                ) : (
                                                                    <span role="img" aria-hidden>🎯</span>
                                                                )}
                                                            </button>
                                                            {passed ? <span className="badge badge-success">{t('pass')}</span> : null}
                                                            <span className="badge badge-info">{r.score_percent}%</span>
                                                            <span className="meta">{r.correct}/{r.total}</span>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </CollapsibleSection>
                                    )
                                })}
                            </CollapsibleCard>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

export default ScoresRoute
