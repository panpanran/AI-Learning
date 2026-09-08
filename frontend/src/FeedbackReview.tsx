import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import API from './api'

type ProposedFix = {
    content_cn?: string
    content_en?: string
    answer_cn?: string
    answer_en?: string
    explanation_cn?: string
    explanation_en?: string
    reason?: string
    confidence?: number
    source?: string
    human_decision?: string
    [key: string]: unknown
}

type FeedbackItem = {
    id: number
    question_id: number | null
    category: string
    comment: string
    given_answer: string
    status: string
    proposed_fix: ProposedFix | null
    created_at?: string
    question: {
        content_cn: string
        content_en: string
        answer_cn: string
        answer_en: string
        explanation_cn: string
        explanation_en: string
        options: unknown
    }
}

function pickLang(lang: 'zh' | 'en', cn: string, en: string) {
    return lang === 'zh' ? (cn || en) : (en || cn)
}

function hasProposedCae(p: ProposedFix | null | undefined) {
    if (!p) return false
    return Boolean(
        p.content_cn || p.content_en
        || p.answer_cn || p.answer_en
        || p.explanation_cn || p.explanation_en
    )
}

export default function FeedbackReview() {
    const navigate = useNavigate()
    const { t, i18n } = useTranslation()
    const token = localStorage.getItem('token')
    const lang: 'zh' | 'en' = i18n.language === 'zh' ? 'zh' : 'en'

    const setLang = (lng: 'zh' | 'en') => {
        try { localStorage.setItem('lang', lng) } catch { /* ignore */ }
        i18n.changeLanguage(lng)
    }

    const [loading, setLoading] = useState(false)
    const [items, setItems] = useState<FeedbackItem[]>([])
    const [busyId, setBusyId] = useState<number | null>(null)
    const [note, setNote] = useState('')

    const load = useCallback(async () => {
        if (!token) return
        setLoading(true)
        setNote('')
        try {
            const r = await API.get('/api/user-feedback', {
                headers: { Authorization: `Bearer ${token}` },
                params: { status: 'acknowledged,open', limit: 50 },
            })
            const rows: FeedbackItem[] = (r && r.data && Array.isArray(r.data.items)) ? r.data.items : []
            setItems(rows)
        } catch {
            setItems([])
            setNote(t('feedback_review_load_failed'))
        } finally {
            setLoading(false)
        }
    }, [token, t])

    useEffect(() => {
        if (!token) navigate('/', { replace: true })
    }, [token, navigate])

    useEffect(() => {
        load()
    }, [load])

    const decide = async (id: number, action: 'accept' | 'reject') => {
        if (!token || busyId != null) return
        setBusyId(id)
        setNote('')
        try {
            await API.post(
                `/api/user-feedback/${id}/decide`,
                { action },
                { headers: { Authorization: `Bearer ${token}` } }
            )
            setItems((prev) => prev.filter((x) => x.id !== id))
            setNote(action === 'accept' ? t('feedback_review_accepted') : t('feedback_review_rejected'))
        } catch (err: any) {
            const msg = err?.response?.data?.error || t('feedback_review_action_failed')
            setNote(String(msg))
        } finally {
            setBusyId(null)
        }
    }

    const reanalyze = async (id: number) => {
        if (!token || busyId != null) return
        setBusyId(id)
        setNote(t('feedback_review_reanalyzing'))
        try {
            await API.post(
                `/api/user-feedback/${id}/reanalyze`,
                {},
                { headers: { Authorization: `Bearer ${token}` } }
            )
            await load()
            setNote(t('feedback_review_reanalyzed'))
        } catch (err: any) {
            const msg = err?.response?.data?.error || t('feedback_review_action_failed')
            setNote(String(msg))
        } finally {
            setBusyId(null)
        }
    }

    if (!token) return null

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

                        <button
                            type="button"
                            className="menu-icon-btn active"
                            onClick={() => { /* already here */ }}
                            aria-label={t('feedback_review')}
                            title={t('feedback_review')}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M4 5h16v11H8l-4 3V5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                                <path d="M8 9h8M8 12h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                            </svg>
                        </button>
                    </div>

                    <div className="lang-controls" style={{ position: 'static', display: 'flex', gap: 6 }}>
                        <button className="btn" onClick={() => setLang('zh')}>中文</button>
                        <button className="btn" onClick={() => setLang('en')}>EN</button>
                    </div>
                </div>

                <h2 style={{ marginTop: 0, textAlign: 'center' }}>{t('feedback_review')}</h2>
                <div className="meta" style={{ textAlign: 'center', marginBottom: 12 }}>{t('feedback_review_note')}</div>

                {note ? <div className="meta" style={{ marginBottom: 10, textAlign: 'center' }}>{note}</div> : null}

                {loading ? (
                    <div className="placeholder">{t('loading') || '…'}</div>
                ) : items.length === 0 ? (
                    <div className="placeholder">{t('feedback_review_empty')}</div>
                ) : (
                    items.map((item) => {
                        const q = item.question || {
                            content_cn: '', content_en: '', answer_cn: '', answer_en: '',
                            explanation_cn: '', explanation_en: '', options: null,
                        }
                        const p = item.proposed_fix
                        const canAccept = hasProposedCae(p)
                        const busy = busyId === item.id
                        const conf = p && typeof p.confidence === 'number' ? p.confidence : null

                        return (
                            <div key={item.id} className="card" style={{ marginBottom: 12 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                                    <div style={{ fontWeight: 800 }}>
                                        #{item.id}
                                        {item.question_id != null ? ` · Q${item.question_id}` : ''}
                                    </div>
                                    <div className="meta">
                                        {item.status}
                                        {conf != null ? ` · ${(conf * 100).toFixed(0)}%` : ''}
                                    </div>
                                </div>

                                <div style={{ marginTop: 8 }}>
                                    <div className="meta">{t('feedback_review_your_comment')}</div>
                                    <div>{item.comment || '—'}</div>
                                    {item.given_answer ? (
                                        <div className="meta" style={{ marginTop: 4 }}>
                                            {t('your_answer')}: {item.given_answer}
                                        </div>
                                    ) : null}
                                </div>

                                <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                                    <div>
                                        <div className="meta">{t('feedback_review_current')}</div>
                                        <div style={{ fontWeight: 600 }}>
                                            {pickLang(lang, q.content_cn, q.content_en) || '—'}
                                        </div>
                                        <div className="meta" style={{ marginTop: 4 }}>
                                            {t('correct_answer')}: {pickLang(lang, q.answer_cn, q.answer_en) || '—'}
                                        </div>
                                        <div className="meta">
                                            {t('explanation')}: {pickLang(lang, q.explanation_cn, q.explanation_en) || '—'}
                                        </div>
                                    </div>

                                    <div>
                                        <div className="meta">{t('feedback_review_proposed')}</div>
                                        {canAccept ? (
                                            <>
                                                {(p?.content_cn || p?.content_en) ? (
                                                    <div style={{ fontWeight: 600 }}>
                                                        {pickLang(lang, p?.content_cn || '', p?.content_en || '')}
                                                    </div>
                                                ) : null}
                                                {(p?.answer_cn || p?.answer_en) ? (
                                                    <div className="meta" style={{ marginTop: 4 }}>
                                                        {t('correct_answer')}: {pickLang(lang, p?.answer_cn || '', p?.answer_en || '')}
                                                    </div>
                                                ) : null}
                                                {(p?.explanation_cn || p?.explanation_en) ? (
                                                    <div className="meta">
                                                        {t('explanation')}: {pickLang(lang, p?.explanation_cn || '', p?.explanation_en || '')}
                                                    </div>
                                                ) : null}
                                                {p?.reason ? (
                                                    <div className="meta" style={{ marginTop: 4 }}>{String(p.reason)}</div>
                                                ) : null}
                                            </>
                                        ) : (
                                            <div className="meta">{t('feedback_review_no_proposal')}</div>
                                        )}
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                                    <button
                                        type="button"
                                        className="btn primary"
                                        disabled={busy || !canAccept}
                                        onClick={() => decide(item.id, 'accept')}
                                    >
                                        {t('feedback_review_accept')}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn"
                                        disabled={busy}
                                        onClick={() => decide(item.id, 'reject')}
                                    >
                                        {t('feedback_review_reject')}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn"
                                        disabled={busy}
                                        onClick={() => reanalyze(item.id)}
                                    >
                                        {t('feedback_review_reanalyze')}
                                    </button>
                                </div>
                            </div>
                        )
                    })
                )}

                <div style={{ textAlign: 'center', marginTop: 8, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                    <button type="button" className="btn" onClick={() => load()} disabled={loading || busyId != null}>
                        {t('feedback_review_refresh')}
                    </button>
                    <button
                        type="button"
                        className="btn"
                        disabled={loading || busyId != null}
                        onClick={async () => {
                            if (!token || busyId != null) return
                            setBusyId(-1)
                            setNote(t('feedback_review_batch_running'))
                            try {
                                await API.post(
                                    '/api/user-feedback/triage-batch',
                                    { limit: 20, status: 'open,acknowledged' },
                                    { headers: { Authorization: `Bearer ${token}` } }
                                )
                                await load()
                                setNote(t('feedback_review_batch_done'))
                            } catch {
                                setNote(t('feedback_review_action_failed'))
                            } finally {
                                setBusyId(null)
                            }
                        }}
                    >
                        {t('feedback_review_batch')}
                    </button>
                </div>
            </div>
        </div>
    )
}
