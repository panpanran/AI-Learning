import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import HistoryPage from './HistoryPage'

export default function HistoryRoute() {
    const navigate = useNavigate()
    const { t, i18n } = useTranslation()
    const token = localStorage.getItem('token')

    const setLang = (lng: 'zh' | 'en') => {
        try { localStorage.setItem('lang', lng) } catch { }
        i18n.changeLanguage(lng)
    }

    if (!token) {
        return (
            <div className="container" style={{ justifyContent: 'center' }}>
                <div className="hero-card" style={{ maxWidth: 820 }}>
                    <h2 style={{ textAlign: 'center', marginTop: 0 }}>{t('history')}</h2>
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
                            className="menu-icon-btn active"
                            onClick={() => { /* already here */ }}
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

                <h2 style={{ marginTop: 0, textAlign: 'center' }}>{t('history')}</h2>
                <HistoryPage token={token} />
            </div>
        </div>
    )
}
