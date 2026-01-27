import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

type MenuKey = 'home' | 'history'

export default function MenuBar({ active, onChange }: { active: MenuKey, onChange: (k: MenuKey) => void }) {
    const navigate = useNavigate()
    const { t } = useTranslation()
    return (
        <div className="menu-bar" role="tablist" aria-label="Menu">
            <button
                type="button"
                className={active === 'home' ? 'menu-icon-btn active' : 'menu-icon-btn'}
                onClick={() => onChange('home')}
                aria-label={t('home')}
                title={t('home')}
            >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-9.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
            </button>

            <button
                type="button"
                className={active === 'history' ? 'menu-icon-btn active' : 'menu-icon-btn'}
                onClick={() => onChange('history')}
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
                className={'menu-icon-btn'}
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
    )
}
