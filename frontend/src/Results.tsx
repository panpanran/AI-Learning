import React, { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import API from './api'
import TtsSpeakButton from './TtsSpeakButton'

type ResultItem = {
    questionId: number | string
    correct: boolean
    given: string
    correctAnswer: string
    explanation?: string
    content?: string
    content_cn?: string
    content_en?: string
    answer_cn?: string
    answer_en?: string
    explanation_cn?: string
    explanation_en?: string
    created_at?: string
}

type QuestionRow = {
    id: number
    content_cn?: string
    content_en?: string
    answer_cn?: string
    answer_en?: string
    explanation_cn?: string
    explanation_en?: string
}

function Results() {
    const location = useLocation()
    const navigate = useNavigate()
    const { t, i18n } = useTranslation()

    const setLang = (lng: 'zh' | 'en') => {
        try { localStorage.setItem('lang', lng) } catch { }
        i18n.changeLanguage(lng)
    }

    const lang = i18n.language === 'zh' ? 'zh' : 'en'

    const state = (location.state || {}) as any
    const lesson = state.lesson || null
    const answers: ResultItem[] = Array.isArray(state.answers) ? state.answers : []

    const selectionFromState = {
        gradeId: state && state.gradeId != null ? String(state.gradeId) : '',
        subjectId: state && state.subjectId != null ? String(state.subjectId) : '',
    }

    const selectionFromLast = (() => {
        try {
            const raw = localStorage.getItem('last_selection')
            const last = raw ? JSON.parse(raw) : null
            return {
                gradeId: last && last.gradeId != null ? String(last.gradeId) : '',
                subjectId: last && last.subjectId != null ? String(last.subjectId) : '',
            }
        } catch {
            return { gradeId: '', subjectId: '' }
        }
    })()

    const resumeGradeId = selectionFromState.gradeId || selectionFromLast.gradeId
    const resumeSubjectId = selectionFromState.subjectId || selectionFromLast.subjectId

    const [questionById, setQuestionById] = useState<Record<string, QuestionRow>>({})

    useEffect(() => {
        let cancelled = false
        const run = async () => {
            try {
                const token = localStorage.getItem('token')
                if (!token) return
                const ids = Array.from(
                    new Set(
                        (answers || [])
                            .map(a => (a && a.questionId != null ? Number(a.questionId) : null))
                            .filter(x => Number.isInteger(x)) as number[]
                    )
                )
                if (!ids.length) return
                const r = await API.get('/api/questions/by-ids', {
                    headers: { Authorization: `Bearer ${token}` },
                    params: { ids: ids.join(',') },
                })
                const rows: any[] = (r && r.data && r.data.questions) ? r.data.questions : []
                const map: Record<string, QuestionRow> = {}
                for (const row of rows) {
                    if (!row || row.id == null) continue
                    map[String(row.id)] = {
                        id: Number(row.id),
                        content_cn: row.content_cn != null ? String(row.content_cn) : '',
                        content_en: row.content_en != null ? String(row.content_en) : '',
                        answer_cn: row.answer_cn != null ? String(row.answer_cn) : '',
                        answer_en: row.answer_en != null ? String(row.answer_en) : '',
                        explanation_cn: row.explanation_cn != null ? String(row.explanation_cn) : '',
                        explanation_en: row.explanation_en != null ? String(row.explanation_en) : '',
                    }
                }
                if (!cancelled) setQuestionById(map)
            } catch {
                // fall back to values included in submit response
            }
        }
        run()
        return () => {
            cancelled = true
        }
    }, [answers])

    const dbLookup = useMemo(() => questionById || {}, [questionById])

    if (!answers.length) {
        return (
            <div className="container" style={{ justifyContent: 'center' }}>
                <div className="hero-card" style={{ maxWidth: 820 }}>
                    <h2 style={{ textAlign: 'center', marginTop: 0 }}>{t('results')}</h2>
                    <div className="placeholder">{t('no_results')}</div>
                    <div style={{ textAlign: 'center' }}>
                        <button className="btn primary" onClick={() => navigate('/app')}>{t('back')}</button>
                    </div>
                </div>
            </div>
        )
    }

    const allCorrect = answers.every(a => a && a.correct)

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
                            className="menu-icon-btn"
                            onClick={() => navigate('/scores')}
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
                    {(() => {
                        const title = (lang === 'zh'
                            ? (lesson?.title_cn || '诊断测试')
                            : (lesson?.title_en || 'Diagnostic Test')) || lesson?.title || t('results')
                        const explanation = (lang === 'zh'
                            ? (lesson?.explanation_cn || '请完成以下题目以评估学习水平。')
                            : (lesson?.explanation_en || 'Please complete these questions to assess your level.')) || ''
                        return (
                            <>
                                <h2 style={{ margin: 0 }}>{title}</h2>
                                {explanation ? <div className="meta" style={{ marginTop: 6 }}>{explanation}</div> : null}
                            </>
                        )
                    })()}
                    <div style={{ marginTop: 10 }}>
                        <span className={allCorrect ? 'badge badge-success' : 'badge badge-info'}>
                            {allCorrect ? t('all_correct') : t('submitted')}
                        </span>
                    </div>
                </div>

                <div style={{ marginTop: 16 }}>
                    {answers.map((a, idx) => (
                        <div key={String(a.questionId)} className="card" style={{ marginBottom: 12 }}>
                            {(() => {
                                const row = dbLookup[String(a.questionId)]

                                const contentFromDb = row ? (lang === 'zh' ? (row.content_cn || '') : (row.content_en || '')) : ''
                                const answerFromDb = row ? (lang === 'zh' ? (row.answer_cn || '') : (row.answer_en || '')) : ''
                                const expFromDb = row ? (lang === 'zh' ? (row.explanation_cn || '') : (row.explanation_en || '')) : ''

                                const content = contentFromDb || (lang === 'zh' ? (a.content_cn || '') : (a.content_en || '')) || a.content || ''
                                const correctAnswer = answerFromDb || (lang === 'zh' ? (a.answer_cn || '') : (a.answer_en || '')) || a.correctAnswer || ''
                                const explanation = expFromDb || (lang === 'zh' ? (a.explanation_cn || '') : (a.explanation_en || '')) || a.explanation || ''

                                return (
                                    <>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                            <div style={{ fontWeight: 700 }}>{idx + 1}.</div>
                                            <span className={a.correct ? 'badge badge-success' : 'badge badge-danger'}>
                                                {a.correct ? t('correct') : t('wrong')}
                                            </span>
                                        </div>

                                        {content ? (
                                            <div style={{ marginTop: 10 }}>
                                                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                                                    <div style={{ flex: 1 }}><strong>{t('question')}：</strong> {content}</div>
                                                    <TtsSpeakButton
                                                        lang={lang}
                                                        text={String(content || '')}
                                                        options={[]}
                                                        className="btn"
                                                        title={lang === 'zh' ? '朗读题目' : 'Read question'}
                                                    />
                                                </div>
                                            </div>
                                        ) : null}

                                        <div style={{ marginTop: 10 }}>
                                            <div><strong>{t('your_answer')}：</strong> {a.given || '-'}</div>
                                            <div><strong>{t('correct_answer')}：</strong> {correctAnswer || '-'}</div>
                                        </div>

                                        {explanation ? (
                                            <div style={{ marginTop: 10 }}>
                                                <div><strong>{t('explanation')}：</strong></div>
                                                <div className="ai-text">{explanation}</div>
                                            </div>
                                        ) : null}
                                    </>
                                )
                            })()}
                        </div>
                    ))}
                </div>

                <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14 }}>
                    <button
                        className="btn"
                        onClick={() => {
                            if (resumeGradeId && resumeSubjectId) {
                                navigate('/app', {
                                    state: {
                                        resume: true,
                                        practice: { gradeId: resumeGradeId, subjectId: resumeSubjectId },
                                    }
                                })
                                return
                            }
                            navigate('/app', { state: { resume: true } })
                        }}
                    >
                        {t('continue')}
                    </button>
                </div>
            </div>
        </div>
    )
}

export default Results
