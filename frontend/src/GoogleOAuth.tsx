// ...existing code...

// 扩展window类型，避免TS报错
declare global {
    interface Window {
        onGoogleSignIn?: (response: any) => void;
        google?: any;
    }
}

// Vite 项目推荐的类型声明方式
// 只需在 vite-env.d.ts 或 src/global.d.ts 里声明一次即可
// 这里直接用类型断言消除TS报错
const GOOGLE_CLIENT_ID = (import.meta as any).env.VITE_GOOGLE_CLIENT_ID || '';
console.log('GOOGLE_CLIENT_ID:', GOOGLE_CLIENT_ID);
console.log("🔥 Google SDK 看到的 Origin 是:", window.location.origin);

export function loadGoogleScript(onLoad?: () => void) {
    if (document.getElementById('google-oauth')) {
        if (onLoad) onLoad();
        return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.id = 'google-oauth';
    if (onLoad) script.onload = onLoad;
    document.body.appendChild(script);
}

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

type Mode = 'login' | 'register';

export default function LocalAuth() {
    const { t } = useTranslation();
    const [mode, setMode] = useState<Mode>('login');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [password2, setPassword2] = useState('');
    const [error, setError] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        if (!username || !password) {
            setError(t('用户名和密码不能为空'));
            return;
        }
        if (mode === 'register') {
            if (password !== password2) {
                setError(t('两次输入的密码不一致'));
                return;
            }
            try {
                const resp = await fetch('/auth/mock-login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, mode: 'register' })
                });
                const data = await resp.json();
                if (!resp.ok) {
                    setError(t(data.error) || t('register_failed'));
                    return;
                }
                alert(t('register_success'));
            } catch (e) {
                setError(t('network_error'));
            }
        } else {
            try {
                const resp = await fetch('/auth/mock-login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, mode: 'login' })
                });
                const data = await resp.json();
                if (!resp.ok) {
                    setError(t(data.error) || t('login_failed'));
                    return;
                }
                alert(t('login_success'));
            } catch (e) {
                setError(t('network_error'));
            }
        }
    };

    return (
        <div className="hero-card" style={{ maxWidth: 420, margin: '48px auto' }}>
            <h2 style={{ textAlign: 'center', marginBottom: 32, fontWeight: 700, fontSize: 32, letterSpacing: 1 }}>maxailearning</h2>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginBottom: 32 }}>
                <button type="button" className={`btn primary large${mode === 'login' ? ' active' : ''}`} style={{ width: 120 }} onClick={() => setMode('login')}>{t('login')}</button>
                <button type="button" className={`btn primary large${mode === 'register' ? ' active' : ''}`} style={{ width: 120, background: 'linear-gradient(90deg,#06b6d4,#2563eb)' }} onClick={() => setMode('register')}>{t('register')}</button>
            </div>
            <form onSubmit={handleSubmit} className="hero-form">
                <div className="field">
                    <label className="label" style={{ fontWeight: 500 }}>{t('用户名') || '用户名'}</label>
                    <input
                        type="text"
                        className="input-large"
                        placeholder={t('请输入用户名') || '请输入用户名'}
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                    />
                </div>
                <div className="field">
                    <label className="label" style={{ fontWeight: 500 }}>{t('密码') || '密码'}</label>
                    <input
                        type="password"
                        className="input-large"
                        placeholder={t('请输入密码') || '请输入密码'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                    />
                </div>
                {mode === 'register' && (
                    <div className="field">
                        <label className="label" style={{ fontWeight: 500 }}>{t('请再次输入密码') || '请再次输入密码'}</label>
                        <input
                            type="password"
                            className="input-large"
                            placeholder={t('请再次输入密码') || '请再次输入密码'}
                            value={password2}
                            onChange={e => setPassword2(e.target.value)}
                        />
                    </div>
                )}
                {error && <div className="alert alert-danger py-2 mb-3" style={{ borderRadius: 8 }}>{error}</div>}
                <button type="submit" className="btn primary large" style={{ marginTop: 8 }}>
                    {mode === 'login' ? t('login') : t('register')}
                </button>
            </form>
        </div>
    );
}
