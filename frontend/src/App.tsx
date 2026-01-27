import React, { useState, useEffect, useMemo, useRef } from 'react'
import ScratchPad from './ScratchPad'
import Notification from './Notification'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import API from './api'
import MenuBar from './MenuBar'
import HistoryPage from './HistoryPage'
import './index.css'

function feDiagLog(...args: any[]) {
    try {
        if (localStorage.getItem('FE_DIAG_DEBUG') === '1') {
            // eslint-disable-next-line no-console
            console.log(...args)
        }
    } catch {
        // ignore
    }
}

function App() {
    const navigate = useNavigate();
    const location = useLocation();
    const { t, i18n } = useTranslation()
    const [token, setToken] = useState(() => localStorage.getItem('token'))
    const [user, setUser] = useState(() => {
        try {
            const u = localStorage.getItem('user');
            return u ? JSON.parse(u) : null;
        } catch { return null; }
    });
    const [diagnostic, setDiagnostic] = useState(null as any)
    const [grades, setGrades] = useState([] as any[])
    const [gradeId, setGradeId] = useState('')
    const [gradeSubjects, setGradeSubjects] = useState([] as any[])
    const [subjectId, setSubjectId] = useState('')
    const [showMenu, setShowMenu] = useState(false);
    const [homeTab, setHomeTab] = useState<'home' | 'history'>('home');

    // 写字板相关
    const [showScratchPad, setShowScratchPad] = useState(false);

    const setLang = (lng: 'zh' | 'en') => {
        try { localStorage.setItem('lang', lng); } catch { }
        i18n.changeLanguage(lng)
    }

    useEffect(() => {
        const s: any = (location && (location as any).state) || null;
        if (s && s.openHistory) setHomeTab('history');
    }, [location]);

    useEffect(() => {
        const s: any = (location && (location as any).state) || null;
        if (!s || !s.practice) return;
        const p = s.practice;
        if (p && p.gradeId != null) {
            const g = String(p.gradeId);
            const sub = p.subjectId != null ? String(p.subjectId) : '';
            const gi = Number(g);
            const si = Number(sub);
            const valid = Number.isInteger(gi) && gi > 0 && Number.isInteger(si) && si > 0;

            if (valid) {
                setGradeId(g);
                setSubjectId(sub);
                try { localStorage.setItem('last_selection', JSON.stringify({ gradeId: g, subjectId: sub })); } catch { }
                setHasSelected(true);
                setDiagnosticError(null);
            } else {
                const last = readLastSelection();
                if (last.valid) {
                    setGradeId(last.gradeId);
                    setSubjectId(last.subjectId);
                    setHasSelected(true);
                    setDiagnosticError(null);
                }
            }
        }
        if (p && p.diagnostic) {
            setDiagnostic(p.diagnostic);
        }
    }, [location]);

    useEffect(() => {
        const s: any = (location && (location as any).state) || null;
        if (s && s.resume) {
            try {
                const last = readLastSelection();
                if (last.valid) {
                    setGradeId(last.gradeId)
                    setSubjectId(last.subjectId)
                    setHasSelected(true)
                    setDiagnosticError(null)
                }
            } catch {
                // ignore
            }
        }
    }, [location]);

    useEffect(() => {
        // 只在/app下检查token，未登录不跳转，避免loop
        if (window.location.pathname.startsWith('/app')) {
            const t = localStorage.getItem('token');
            const u = localStorage.getItem('user');
            if (!token || !u) {
                if (t && u) {
                    setToken(t);
                    setUser(JSON.parse(u));
                    return;
                }
                navigate('/');
                return;
            }
            // 获取用户信息
            try {
                const p = (API as any).get ? (API as any).get('/me', { headers: { Authorization: `Bearer ${token}` } }) : Promise.resolve({ data: { user: null } })
                Promise.resolve(p).then((r: any) => {
                    setUser(r.data?.user);
                    localStorage.setItem('user', JSON.stringify(r.data?.user));
                }).catch(() => { })
            } catch (e) {
                // swallow
            }
        }
    }, [token, navigate])

    const doLogin = async () => {
        const resp = await API.post('/auth/mock-login', { email: 'user@example.com', name: 'Demo' })
        setToken(resp.data.token)
        setUser(resp.data.user)
    }

    const updatePrefs = async (nextGradeId: string, nextSubjectId: string) => {
        if (!token) return null;
        const payload = {
            token,
            grade_id: nextGradeId ? Number(nextGradeId) : null,
            subject_id: nextSubjectId ? Number(nextSubjectId) : null,
            lang: i18n.language
        };
        const resp = await API.post('/user/update', payload);
        const updatedUser = resp?.data?.user ?? null;
        if (updatedUser) {
            setUser(updatedUser);
            localStorage.setItem('user', JSON.stringify(updatedUser));
        }
        return updatedUser;
    }

    const [history, setHistory] = useState([] as any[])
    const [hasSelected, setHasSelected] = useState(false)
    const [loadingDiagnostic, setLoadingDiagnostic] = useState(false)
    const [loadingHistory, setLoadingHistory] = useState(false)
    const [diagnosticError, setDiagnosticError] = useState<string | null>(null)

    const prevGradeIdRef = useRef<string>('')

    const readLastSelection = () => {
        try {
            const raw = localStorage.getItem('last_selection')
            const last = raw ? JSON.parse(raw) : null
            const g = last && last.gradeId != null ? String(last.gradeId) : ''
            const sub = last && last.subjectId != null ? String(last.subjectId) : ''
            const gi = Number(g)
            const si = Number(sub)
            const valid = Number.isInteger(gi) && gi > 0 && Number.isInteger(si) && si > 0
            return { gradeId: g, subjectId: sub, valid }
        } catch {
            return { gradeId: '', subjectId: '', valid: false }
        }
    }

    // 只有选择完年级和学科后才查 history 并生成题目
    const fetchHistory = async () => {
        if (!token) return
        setLoadingHistory(true)
        try {
            const p = (API as any).get ? (API as any).get('/api/history', { headers: { Authorization: `Bearer ${token}` } }) : Promise.resolve({ data: { history: [] } })
            const r = await Promise.resolve(p)
            setHistory((r && r.data && r.data.history) || [])
        } catch (e) {
            setHistory([]) // 404 也视为无历史
        }
        setLoadingHistory(false)
    }

    // 只有 hasSelected=true 时才查 history 并生成题目
    const [notif, setNotif] = useState({ show: false, message: '', type: 'danger' })
    useEffect(() => {
        if (token && hasSelected) {
            fetchHistory()
        }
    }, [token, hasSelected])

    useEffect(() => {
        if (token && hasSelected && !diagnostic && !loadingDiagnostic) {
            if (diagnosticError) return;

            const parsedGradeId = Number(gradeId)
            const parsedSubjectId = Number(subjectId)
            const validGrade = Number.isInteger(parsedGradeId) && parsedGradeId > 0
            const validSubject = Number.isInteger(parsedSubjectId) && parsedSubjectId > 0

            if (!validGrade || !validSubject) {
                feDiagLog('[fe][diagnostic] skip auto-generate due to invalid selection', {
                    hasSelected,
                    gradeId,
                    subjectId,
                    parsedGradeId,
                    parsedSubjectId,
                    last_selection: (() => {
                        try { return localStorage.getItem('last_selection') } catch { return null }
                    })(),
                })
                const last = readLastSelection();
                if (last.valid) {
                    // restore previous selection and retry on next effect pass
                    setGradeId(last.gradeId)
                    setSubjectId(last.subjectId)
                    setHasSelected(true)
                    return;
                }
                // No valid stored selection: stop retrying to avoid loops.
                setDiagnosticError('missing_grade_subject')
                return;
            }

            setLoadingDiagnostic(true);
            (async () => {
                try {
                    // 这里可根据 history 推荐错题/知识点，否则生成诊断题
                    const payload = { token, numQuestions: 20, grade_id: parsedGradeId, subject_id: parsedSubjectId, lang: i18n.language }
                    feDiagLog('[fe][diagnostic] request /api/generate/diagnostic', {
                        hasSelected,
                        loadingDiagnostic,
                        gradeId,
                        subjectId,
                        grade_id: payload.grade_id,
                        subject_id: payload.subject_id,
                        lang: payload.lang,
                        last_selection: (() => {
                            try { return localStorage.getItem('last_selection') } catch { return null }
                        })(),
                        // do NOT log token
                        token: payload.token ? '<redacted>' : null,
                    })
                    const resp = await API.post('/api/generate/diagnostic', payload)
                    setDiagnostic({ lessonId: resp.data.lessonId, lesson: resp.data.lesson, questions: resp.data.questions })
                    setDiagnosticError(null)
                } catch (e: any) {
                    feDiagLog('[fe][diagnostic] error /api/generate/diagnostic', {
                        status: e?.response?.status,
                        data: e?.response?.data,
                        message: e?.message,
                    })
                    if (e?.response?.status === 400) {
                        const last = readLastSelection();
                        if (last.valid && (last.gradeId !== gradeId || last.subjectId !== subjectId)) {
                            // restore and let the effect re-run once with valid params
                            setGradeId(last.gradeId)
                            setSubjectId(last.subjectId)
                            setHasSelected(true)
                        }
                        // stop auto-retry loop; user can continue normal flow once restored
                        setDiagnosticError('bad_request')
                    }
                    if (e && e.response && e.response.status === 401) {
                        setNotif({
                            show: true,
                            message: i18n.language === 'zh' ? '登录已失效，请重新登录' : 'Session expired, please log in again.',
                            type: 'danger'
                        });
                        localStorage.clear();
                        // 不自动跳转，用户可手动点击退出或登录
                    }
                }
                setLoadingDiagnostic(false)
            })();
        }
    }, [token, hasSelected, diagnostic, loadingDiagnostic, gradeId, subjectId])

    // Clear diagnosticError when user changes selection (so it can auto-generate again).
    useEffect(() => {
        if (!diagnosticError) return
        setDiagnosticError(null)
    }, [gradeId, subjectId])

    // Load grades for DB-driven dropdown
    useEffect(() => {
        if (!token || hasSelected) return;
        (async () => {
            try {
                const r = await API.get('/api/meta/grades');
                setGrades((r && r.data && r.data.grades) || []);
            } catch (e) {
                setGrades([]);
            }
        })();
    }, [token, hasSelected])

    // When grade changes, reset subject and load allowed subjects for that grade
    useEffect(() => {
        if (!gradeId) {
            setSubjectId('');
            setGradeSubjects([]);
            prevGradeIdRef.current = '';
            return;
        }
        // Only reset subject while on the selection (home) screen AND when grade actually changes.
        // This avoids wiping a restored subjectId during resume/continue navigation.
        if (!hasSelected && prevGradeIdRef.current && prevGradeIdRef.current !== gradeId) {
            setSubjectId('');
        }
        prevGradeIdRef.current = gradeId;
        (async () => {
            try {
                const r = await API.get('/api/meta/grade-subjects', { params: { grade_id: gradeId } });
                setGradeSubjects((r && r.data && r.data.items) || []);
            } catch (e) {
                setGradeSubjects([]);
            }
        })();
    }, [gradeId, hasSelected])

    const gradeOptions = useMemo(() => grades || [], [grades])
    const subjectOptions = useMemo(() => gradeSubjects || [], [gradeSubjects])

    return (
        <div className="app-root">
            <main className="container">
                {!token ? (
                    <div className="hero-card" style={{ position: 'relative' }}>
                        <div className="lang-controls" style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 6, zIndex: 2 }}>
                            <button className="btn" onClick={() => setLang('zh')}>中文</button>
                            <button className="btn" onClick={() => setLang('en')}>EN</button>
                        </div>
                        <div style={{ textAlign: 'center', marginBottom: 16 }}>
                            <h2 style={{ fontWeight: 700, fontSize: 28, margin: 0, letterSpacing: 1 }}>Max AI Learning</h2>
                        </div>
                        <div className="placeholder" style={{ textAlign: 'center' }}>
                            {t('please_login') || '请先登录'}
                        </div>
                        <div style={{ marginTop: 16, textAlign: 'center' }}>
                            <button className="btn primary" type="button" onClick={() => navigate('/')}>{t('login') || '登录'}</button>
                        </div>
                    </div>
                ) : !hasSelected ? (
                    <div className="hero-card">
                        {/* 通知条放在 hero-card 顶部 */}
                        <Notification
                            show={notif.show}
                            message={i18n.language === 'zh' ? '请选择年级和学科后再开始学习' : 'Please select both grade and subject before starting.'}
                            type={notif.type as 'danger' | 'success' | 'warning' | 'info'}
                            onClose={() => setNotif({ ...notif, show: false })}
                        />
                        <div style={{ position: 'relative', marginBottom: 16, minHeight: 44 }}>
                            <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                                <div
                                    className="header-icon"
                                    aria-hidden
                                    style={{
                                        cursor: 'pointer',
                                        width: 44,
                                        height: 44,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        marginRight: 8,
                                        position: 'relative',
                                        left: 'auto',
                                        top: 'auto',
                                        flex: '0 0 auto',
                                    }}
                                    onClick={() => setShowMenu(v => !v)}
                                >
                                    {user && user.picture ? (
                                        <img src={user.picture} alt="avatar" style={{ width: 36, height: 36, borderRadius: '50%' }} />
                                    ) : (
                                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                            <circle cx="12" cy="12" r="10" fill="#fff3f0" />
                                            <path d="M8.5 9.5c.83 0 1.5-.67 1.5-1.5S9.33 6.5 8.5 6.5 7 7.17 7 8s.67 1.5 1.5 1.5zM15.5 9.5c.83 0 1.5-.67 1.5-1.5S16.33 6.5 15.5 6.5 14 7.17 14 8s.67 1.5 1.5 1.5z" fill="#111827" />
                                            <path d="M8 14c1.2 1.2 2.8 2 4 2s2.8-.8 4-2" stroke="#111827" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                                        </svg>
                                    )}
                                </div>
                                {user?.username && (
                                    <span style={{ fontWeight: 600, fontSize: 16, whiteSpace: 'nowrap', lineHeight: '36px', marginLeft: 2 }}>{user.username}</span>
                                )}
                                {showMenu && (
                                    <div style={{ position: 'absolute', top: 44, left: 0, background: '#fff', border: '1px solid #eee', borderRadius: 8, boxShadow: '0 2px 8px #0001', zIndex: 10 }}>
                                        <button className="btn" style={{ width: 120, textAlign: 'left' }} onClick={() => {
                                            localStorage.clear();
                                            window.location.href = '/';
                                        }}>{t('logout') || 'Logout'}</button>
                                    </div>
                                )}
                            </div>
                            <div className="lang-controls" style={{ position: 'absolute', top: 0, right: 0, display: 'flex', gap: 6 }}>
                                <button className="btn" onClick={() => setLang('zh')}>中文</button>
                                <button className="btn" onClick={() => setLang('en')}>EN</button>
                            </div>
                        </div>

                        {/* icon-only menu bar inside hero-card */}
                        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
                            <MenuBar active={homeTab} onChange={setHomeTab} />
                        </div>

                        <div style={{ textAlign: 'center', marginBottom: 24 }}>
                            <h2 style={{ fontWeight: 700, fontSize: 28, margin: 0, letterSpacing: 1 }}>Max AI Learning</h2>
                            <div style={{ color: 'var(--muted)', marginTop: 6 }}>{t('subtitle')}</div>
                        </div>

                        {homeTab === 'history' ? (
                            <HistoryPage token={token as string} />
                        ) : (
                            <div className="hero-form">
                                <div className="field">
                                    <label className="label">{t('grade_level')}</label>
                                    <select className="input-large" value={gradeId} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setGradeId(e.target.value)}>
                                        <option value="">{i18n.language === 'zh' ? '请选择年级' : 'Select Grade'}</option>
                                        {gradeOptions.map((g: any) => (
                                            <option key={g.id} value={String(g.id)}>
                                                {i18n.language === 'zh' ? (g.name_zh || g.code) : (g.name_en || g.code)}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div className="field">
                                    <label className="label">{t('subject')}</label>
                                    <select className="input-large" value={subjectId} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSubjectId(e.target.value)}>
                                        <option value="">{i18n.language === 'zh' ? '请选择学科' : 'Select Subject'}</option>
                                        {subjectOptions.map((s: any) => (
                                            <option key={s.subject_id} value={String(s.subject_id)}>
                                                {i18n.language === 'zh' ? (s.name_zh || s.subject_code) : (s.name_en || s.subject_code)}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div style={{ height: 12 }} />
                                <button className="btn primary large" style={{ width: '100%', fontSize: 20 }} onClick={() => {
                                    if (!gradeId || !subjectId) {
                                        setNotif({ show: true, message: '', type: 'danger' });
                                        return;
                                    }
                                    (async () => {
                                        try {
                                            await updatePrefs(gradeId, subjectId);
                                        } catch (e) {
                                            // Even if persisting prefs fails, allow user to continue
                                        }
                                        try {
                                            localStorage.setItem('last_selection', JSON.stringify({ gradeId, subjectId }))
                                        } catch { }
                                        setHasSelected(true)
                                    })();
                                }}>
                                    {t('start_learning')}
                                </button>
                                {/* Notification 已移到 hero-card 顶部 */}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="hero-card">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                            <div className="menu-bar" aria-label="Menu">
                                <button
                                    type="button"
                                    className="menu-icon-btn"
                                    onClick={() => {
                                        setDiagnostic(null)
                                        setHasSelected(false)
                                    }}
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

                        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12, textAlign: 'center' }}>
                            {t('diagnostic_intro')}
                        </div>
                        {loadingDiagnostic ? (
                            <div style={{ textAlign: 'center', margin: '32px 0' }}>
                                <div className="loader" />
                                <div style={{ marginTop: 12, color: 'var(--muted)' }}>{t('ai_generating')}</div>
                            </div>
                        ) : diagnostic ? (
                            <>
                                {/* 浮动写字板按钮，仅icon，居中覆盖 */}
                                <button
                                    aria-label="打开写字板"
                                    onClick={() => setShowScratchPad(true)}
                                    style={{
                                        position: 'fixed',
                                        right: 32,
                                        bottom: 32,
                                        zIndex: 1000,
                                        background: 'rgba(255, 200, 40, 0.95)',
                                        border: 'none',
                                        borderRadius: '50%',
                                        width: 56,
                                        height: 56,
                                        boxShadow: '0 2px 12px #0002',
                                        display: showScratchPad ? 'none' : 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: 32,
                                        cursor: 'pointer',
                                        transition: 'background 0.2s',
                                    }}
                                >
                                    <span role="img" aria-label="草稿板">📝</span>
                                </button>
                                {/* 写字板全屏弹窗 */}
                                <ScratchPad
                                    visible={showScratchPad}
                                    onClose={() => setShowScratchPad(false)}
                                />
                                {(() => {
                                    const lang = i18n.language === 'zh' ? 'zh' : 'en'
                                    const title = (lang === 'zh' ? diagnostic.lesson?.title_cn : diagnostic.lesson?.title_en) || diagnostic.lesson?.title
                                    const explanation = (lang === 'zh' ? diagnostic.lesson?.explanation_cn : diagnostic.lesson?.explanation_en) || diagnostic.lesson?.explanation
                                    return (
                                        <>
                                            <h2 style={{ textAlign: 'center' }}>{title}</h2>
                                            <div className="meta" style={{ textAlign: 'center' }}>{explanation}</div>
                                        </>
                                    )
                                })()}
                                <div style={{ marginTop: 16 }}>
                                    {(diagnostic.questions || []).map((q: any, idx: number) => (
                                        <div key={q.id} className="card" style={{ marginBottom: 12, position: 'relative' }}>
                                            {/* 语言切换按钮仅在主 hero-card 上显示 */}
                                            {(() => {
                                                const lang = i18n.language === 'zh' ? 'zh' : 'en'
                                                const hasBilingualContent = !!(q && (q.content_cn || q.content_en))
                                                const content = hasBilingualContent
                                                    ? (lang === 'zh' ? (q && q.content_cn) : (q && q.content_en)) || ''
                                                    : ((q && q.content != null ? String(q.content) : '') || '')

                                                const bilingualOpts = q && (q.options_bilingual || q.optionsBilingual || null)
                                                const options = (bilingualOpts && (lang === 'zh' ? bilingualOpts.zh : bilingualOpts.en)) ||
                                                    (q && q.options && !Array.isArray(q.options) && (lang === 'zh' ? q.options.zh : q.options.en)) ||
                                                    (Array.isArray(q.options) ? q.options : [])

                                                return (
                                                    <>
                                                        <div><strong>{idx + 1}.</strong> {content}</div>
                                                        {q.type === 'mcq' && options && (
                                                            <div style={{ marginTop: 8 }}>
                                                                {options.map((opt: any, i: number) => (
                                                                    <label key={i} style={{ display: 'block', marginTop: 6 }}>
                                                                        <input
                                                                            type="radio"
                                                                            name={String(q.id)}
                                                                            value={String(opt)}
                                                                            checked={q._answerIndex === i}
                                                                            onChange={() => {
                                                                                q._answerIndex = i;
                                                                                q._answer = String(opt);
                                                                                setDiagnostic((prev: any) => ({
                                                                                    ...prev,
                                                                                    questions: prev.questions.map((qq: any) =>
                                                                                        qq.id === q.id ? { ...qq, _answerIndex: i, _answer: String(opt) } : qq
                                                                                    )
                                                                                }));
                                                                            }}
                                                                        /> {String(opt)}
                                                                    </label>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </>
                                                )
                                            })()}
                                            {q.type === 'short' && (
                                                <div style={{ marginTop: 8 }}>
                                                    <input className="select" placeholder={t('answer')} onChange={(e: React.ChangeEvent<HTMLInputElement>) => (q._answer = e.target.value)} />
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                                <div style={{ marginTop: 12, textAlign: 'center' }}>
                                    <button className="btn primary large" onClick={async () => {
                                        if (!token) return alert(t('please_login'))
                                        const lang = i18n.language === 'zh' ? 'zh' : 'en'
                                        const answers = (diagnostic.questions || []).map((q: any) => {
                                            if (!q) return { questionId: null, answer: '' }
                                            if (q.type === 'mcq' && typeof q._answerIndex === 'number') {
                                                const bilingualOpts = q && (q.options_bilingual || q.optionsBilingual || null)
                                                const opts = (bilingualOpts && (lang === 'zh' ? bilingualOpts.zh : bilingualOpts.en)) ||
                                                    (q && q.options && !Array.isArray(q.options) && (lang === 'zh' ? q.options.zh : q.options.en)) ||
                                                    (Array.isArray(q.options) ? q.options : [])
                                                const chosen = opts && opts[q._answerIndex] != null ? String(opts[q._answerIndex]) : String(q._answer || '')
                                                return { questionId: q.id, answer: chosen }
                                            }
                                            return { questionId: q.id, answer: q._answer }
                                        })
                                        try {
                                            const lesson = diagnostic.lesson;
                                            const resp = await API.post('/api/submit/diagnostic', {
                                                token,
                                                lessonId: diagnostic.lessonId,
                                                answers,
                                                lang: i18n.language,
                                                // for in-memory mode compatibility
                                                lesson: { questions: diagnostic.questions }
                                            })
                                            fetchHistory()
                                            navigate('/results', { state: { lesson, answers: resp.data?.answers || [], gradeId, subjectId } })
                                            setDiagnostic(null)
                                        } catch (e) {
                                            alert('Submit failed')
                                        }
                                    }}>{t('submit_all')}</button>
                                </div>
                            </>
                        ) : (
                            <div className="placeholder">{t('welcome_note')}</div>
                        )}
                    </div>
                )}
            </main>

            <footer className="footer">© Max AI Learning</footer>
        </div>
    )
}

export default App
