import React, { useCallback, useEffect, useMemo, useState } from 'react'
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

type QuestionSnapshot = {
    content_cn: string | null
    content_en: string | null
    answer_cn: string | null
    answer_en: string | null
    explanation_cn: string | null
    explanation_en: string | null
    options: unknown
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
    original: QuestionSnapshot | null
    question: QuestionSnapshot & { retired_at?: string | null; retired_reason?: string | null }
}

const STATUS_FILTERS = ['all', 'open', 'acknowledged', 'applied', 'dismissed'] as const
type StatusFilter = typeof STATUS_FILTERS[number]

function pickLang(lang: 'zh' | 'en', cn: string | null, en: string | null) {
    return lang === 'zh' ? (cn || en || '') : (en || cn || '')
}

function optionsForLang(options: unknown, lang: 'zh' | 'en'): string[] {
    if (!options) return []
    let parsed: any = options
    if (typeof options === 'string') {
        try { parsed = JSON.parse(options) } catch { return [] }
    }
    if (Array.isArray(parsed)) return parsed.map(String)
    if (parsed && typeof parsed === 'object') {
        const primary = lang === 'zh' ? (parsed.zh || parsed.cn) : parsed.en
        const fallback = lang === 'zh' ? parsed.en : (parsed.zh || parsed.cn)
        const list = Array.isArray(primary) ? primary : (Array.isArray(fallback) ? fallback : [])
        return list.map(String)
    }
    return []
}

function QuestionBlock({ title, q, lang, t, hint }: {
    title: string
    q: QuestionSnapshot
    lang: 'zh' | 'en'
    t: (key: string) => string
    hint?: string
}) {
    const opts = optionsForLang(q.options, lang)
    return (
        <div>
            <div className="meta">{title}</div>
            {hint ? <div className="meta" style={{ fontStyle: 'italic' }}>{hint}</div> : null}
            <div style={{ fontWeight: 600 }}>{pickLang(lang, q.content_cn, q.content_en) || '—'}</div>
            {opts.length ? (
                <div className="meta" style={{ marginTop: 4 }}>
                    {t('feedback_review_options')}: {opts.join(' / ')}
                </div>
            ) : null}
            <div className="meta" style={{ marginTop: 4 }}>
                {t('correct_answer')}: {pickLang(lang, q.answer_cn, q.answer_en) || '—'}
            </div>
            <div className="meta">
                {t('explanation')}: {pickLang(lang, q.explanation_cn, q.explanation_en) || '—'}
            </div>
        </div>
    )
}

function hasProposedCae(p: ProposedFix | null | undefined) {
    if (!p) return false
    return Boolean(
        p.content_cn || p.content_en
        || p.answer_cn || p.answer_en
        || p.explanation_cn || p.explanation_en
    )
}

function optionTexts(options: unknown): string[] {
    if (!options) return []
    let parsed: any = options
    if (typeof options === 'string') {
        try { parsed = JSON.parse(options) } catch { return [] }
    }
    const out: string[] = []
    if (Array.isArray(parsed)) {
        for (const o of parsed) out.push(String(o))
        return out
    }
    if (parsed && typeof parsed === 'object') {
        for (const lang of ['zh', 'en', 'cn']) {
            if (Array.isArray(parsed[lang])) {
                for (const o of parsed[lang]) out.push(String(o))
            }
        }
    }
    return out
}

// Must mirror findMatchingOption in backend/lib/userFeedbackTriage.js, or Accept is enabled but returns 400.
function normalizeAnswerText(s: string) {
    return String(s || '').trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ')
}

const NUMERIC_CONTINUATION = /[0-9./]/

function startsWithAtBoundary(long: string, short: string) {
    if (!long.startsWith(short)) return false
    const next = long.charAt(short.length)
    return !next || !NUMERIC_CONTINUATION.test(next)
}

function containsAtBoundary(hay: string, needle: string) {
    let i = hay.indexOf(needle)
    while (i >= 0) {
        const before = i > 0 ? hay.charAt(i - 1) : ''
        const after = hay.charAt(i + needle.length)
        if ((!before || !NUMERIC_CONTINUATION.test(before)) && (!after || !NUMERIC_CONTINUATION.test(after))) {
            return true
        }
        i = hay.indexOf(needle, i + 1)
    }
    return false
}

function optionMatchesGiven(option: string, given: string) {
    const x = normalizeAnswerText(option)
    const y = normalizeAnswerText(given)
    if (!x || !y) return false
    if (x === y) return true
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) return nx === ny
    return startsWithAtBoundary(x, y) || startsWithAtBoundary(y, x) || containsAtBoundary(x, y)
}

function canAcceptGivenAnswer(item: FeedbackItem): boolean {
    const given = String(item.given_answer || '').trim()
    if (!given) return false
    const options = item.question && item.question.options
    if (!options) return true
    return optionTexts(options).some((t) => optionMatchesGiven(t, given))
}

function isPending(status: string) {
    return status === 'open' || status === 'acknowledged'
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
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
    const [busyId, setBusyId] = useState<number | null>(null)
    const [note, setNote] = useState('')
    const [canRetire, setCanRetire] = useState(false)

    const load = useCallback(async () => {
        if (!token) return
        setLoading(true)
        setNote('')
        try {
            const r = await API.get('/api/user-feedback', {
                headers: { Authorization: `Bearer ${token}` },
                params: { status: 'all', limit: 100 },
            })
            const rows: FeedbackItem[] = (r && r.data && Array.isArray(r.data.items)) ? r.data.items : []
            setItems(rows)
            setCanRetire(Boolean(r && r.data && r.data.can_retire))
        } catch {
            setItems([])
            setCanRetire(false)
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

    const visible = useMemo(() => {
        if (statusFilter === 'all') return items
        return items.filter((x) => x.status === statusFilter)
    }, [items, statusFilter])

    const decide = async (id: number, action: 'accept' | 'reject') => {
        if (!token || busyId != null) return
        setBusyId(id)
        setNote('')
        try {
            const r = await API.post(
                `/api/user-feedback/${id}/decide`,
                { action },
                { headers: { Authorization: `Bearer ${token}` } }
            )
            await load()
            if (action === 'accept') setNote(t('feedback_review_accepted'))
            else setNote(r?.data?.reverted ? t('feedback_review_reverted') : t('feedback_review_rejected'))
        } catch (err: any) {
            const msg = err?.response?.data?.error || t('feedback_review_action_failed')
            setNote(String(msg))
        } finally {
            setBusyId(null)
        }
    }

    const setRetired = async (id: number, retire: boolean) => {
        if (!token || busyId != null) return
        if (retire && !window.confirm(t('feedback_review_retire_confirm'))) return
        setBusyId(id)
        setNote('')
        try {
            await API.post(
                `/api/user-feedback/${id}/${retire ? 'retire' : 'unretire'}`,
                {},
                { headers: { Authorization: `Bearer ${token}` } }
            )
            await load()
            setNote(retire ? t('feedback_review_retire_done') : t('feedback_review_unretire_done'))
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
            const r = await API.post(
                `/api/user-feedback/${id}/reanalyze`,
                {},
                { headers: { Authorization: `Bearer ${token}` } }
            )
            await load()
            const st = r?.data?.triage?.status
            setNote(
                st
                    ? t('feedback_review_reanalyzed_status', { status: st })
                    : t('feedback_review_reanalyzed')
            )
            if (st === 'acknowledged' || st === 'open') {
                setStatusFilter(st as StatusFilter)
            } else if (st) {
                setStatusFilter('all')
            }
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

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 12 }}>
                    {STATUS_FILTERS.map((s) => (
                        <button
                            key={s}
                            type="button"
                            className={statusFilter === s ? 'btn primary' : 'btn'}
                            onClick={() => setStatusFilter(s)}
                        >
                            {t(`feedback_status_${s}`)}
                            {s === 'all' ? ` (${items.length})` : ` (${items.filter((x) => x.status === s).length})`}
                        </button>
                    ))}
                </div>

                {note ? <div className="meta" style={{ marginBottom: 10, textAlign: 'center' }}>{note}</div> : null}

                {loading ? (
                    <div className="placeholder">{t('loading') || '…'}</div>
                ) : visible.length === 0 ? (
                    <div className="placeholder">{t('feedback_review_empty')}</div>
                ) : (
                    visible.map((item) => {
                        const q = item.question || {
                            content_cn: '', content_en: '', answer_cn: '', answer_en: '',
                            explanation_cn: '', explanation_en: '', options: null,
                        }
                        const p = item.proposed_fix
                        const givenOk = canAcceptGivenAnswer(item)
                        const canAccept = item.status !== 'applied' && (hasProposedCae(p) || givenOk)
                        const pending = isPending(item.status)
                        const busy = busyId === item.id
                        const conf = p && typeof p.confidence === 'number' ? p.confidence : null
                        const created = item.created_at
                            ? new Date(item.created_at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')
                            : ''
                        let acceptHint = ''
                        if (item.status === 'applied') {
                            acceptHint = t('feedback_review_accept_already')
                        } else if (!hasProposedCae(p) && givenOk) {
                            acceptHint = t('feedback_review_accept_given', { answer: item.given_answer })
                        } else if (!hasProposedCae(p) && !givenOk) {
                            acceptHint = t('feedback_review_no_proposal')
                        }
                        const retired = Boolean(q.retired_at)
                        if (!retired && item.category === 'wrong_question' && !hasProposedCae(p)) {
                            acceptHint = t('feedback_review_retire_suggest')
                        }

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
                                        {created ? ` · ${created}` : ''}
                                    </div>
                                </div>

                                {item.status === 'applied' ? (
                                    <div className="meta" style={{ marginTop: 8 }}>
                                        {t('feedback_review_applied_hint')}
                                    </div>
                                ) : null}
                                {retired ? (
                                    <div style={{ marginTop: 8, fontWeight: 700 }}>{t('feedback_review_retired_label')}</div>
                                ) : null}

                                <div style={{ marginTop: 8 }}>
                                    <div className="meta">{t('feedback_review_your_comment')}</div>
                                    <div>{item.comment || '—'}</div>
                                    {item.given_answer ? (
                                        <div className="meta" style={{ marginTop: 4 }}>
                                            {t('your_answer')}: {item.given_answer}
                                        </div>
                                    ) : null}
                                    {item.category ? (
                                        <div className="meta">{t('feedback_review_category')}: {item.category}</div>
                                    ) : null}
                                </div>

                                <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                                    {item.original ? (
                                        <>
                                            <QuestionBlock title={t('feedback_review_original')} q={item.original} lang={lang} t={t} />
                                            <QuestionBlock title={t('feedback_review_current')} q={q} lang={lang} t={t} />
                                        </>
                                    ) : (
                                        <QuestionBlock
                                            title={t('feedback_review_current')}
                                            q={q}
                                            lang={lang}
                                            t={t}
                                            hint={item.status === 'applied' ? t('feedback_review_no_original') : undefined}
                                        />
                                    )}

                                    {item.status === 'applied' ? null : <div>
                                        <div className="meta">{t('feedback_review_proposed')}</div>
                                        {hasProposedCae(p) || (p && p.reason) ? (
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
                                    </div>}
                                </div>

                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                                    {item.status === 'applied' ? (
                                        <button
                                            type="button"
                                            className="btn"
                                            disabled={busy || !item.original}
                                            onClick={() => decide(item.id, 'reject')}
                                            title={item.original ? undefined : t('feedback_review_reject_no_original')}
                                        >
                                            {t('feedback_review_reject_revert')}
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            className={canAccept ? 'btn primary' : 'btn'}
                                            disabled={busy || !canAccept}
                                            onClick={() => decide(item.id, 'accept')}
                                            title={acceptHint || undefined}
                                        >
                                            {t('feedback_review_accept')}
                                        </button>
                                    )}
                                    {pending ? (
                                        <button
                                            type="button"
                                            className="btn"
                                            disabled={busy}
                                            onClick={() => decide(item.id, 'reject')}
                                        >
                                            {t('feedback_review_reject')}
                                        </button>
                                    ) : null}
                                    {item.status === 'dismissed' ? (
                                        <span className="meta" style={{ alignSelf: 'center' }}>
                                            {t('feedback_review_already_rejected')}
                                        </span>
                                    ) : null}
                                    <button
                                        type="button"
                                        className="btn"
                                        disabled={busy}
                                        onClick={() => reanalyze(item.id)}
                                    >
                                        {t('feedback_review_reanalyze')}
                                    </button>
                                    {canRetire && item.question_id != null ? (
                                        <button
                                            type="button"
                                            className="btn"
                                            disabled={busy}
                                            onClick={() => setRetired(item.id, !retired)}
                                        >
                                            {retired ? t('feedback_review_unretire') : t('feedback_review_retire')}
                                        </button>
                                    ) : null}
                                </div>
                                {item.status === 'applied' ? (
                                    <div className="meta" style={{ marginTop: 8 }}>
                                        {item.original ? t('feedback_review_accept_already') : t('feedback_review_reject_no_original')}
                                    </div>
                                ) : (acceptHint ? (
                                    <div className="meta" style={{ marginTop: 8 }}>{acceptHint}</div>
                                ) : null)}
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
