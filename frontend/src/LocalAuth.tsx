import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

type Mode = 'login' | 'register';

export default function LocalAuth() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
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
                // 注册成功，保存 token/user 并跳转
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                navigate('/app');
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
                // 登录成功，保存 token/user 并跳转
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                navigate('/app');
            } catch (e) {
                setError(t('network_error'));
            }
        }
    };

    return (
        <div className="hero-card" style={{ maxWidth: 520, margin: '48px auto', position: 'relative', padding: 48 }}>
            <div className="lang-controls" style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 6 }}>
                <button type="button" className="btn" onClick={() => i18n.changeLanguage('zh')}>中文</button>
                <button type="button" className="btn" onClick={() => i18n.changeLanguage('en')}>EN</button>
            </div>
            <h2 style={{ textAlign: 'center', marginBottom: 32, fontWeight: 700, fontSize: 32, letterSpacing: 1 }}>Max AI Learning</h2>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginBottom: 32 }}>
                <button type="button" className={`btn primary large${mode === 'login' ? ' active' : ''}`} style={{ width: 120 }} onClick={() => setMode('login')}>{t('login')}</button>
                <button type="button" className={`btn primary large${mode === 'register' ? ' active' : ''}`} style={{ width: 120, background: 'linear-gradient(90deg,#06b6d4,#2563eb)' }} onClick={() => setMode('register')}>{t('register')}</button>
            </div>
            <form onSubmit={handleSubmit} className="hero-form">
                <div className="field" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <label className="label" style={{ fontWeight: 500, alignSelf: 'flex-start' }}>{t('用户名') || '用户名'}</label>
                    <input
                        type="text"
                        className="input-large"
                        style={{ marginBottom: 12, maxWidth: 420, width: '100%' }}
                        placeholder={t('请输入用户名') || '请输入用户名'}
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                    />
                </div>
                <div className="field" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <label className="label" style={{ fontWeight: 500, alignSelf: 'flex-start' }}>{t('密码') || '密码'}</label>
                    <input
                        type="password"
                        className="input-large"
                        style={{ marginBottom: 12, maxWidth: 420, width: '100%' }}
                        placeholder={t('请输入密码') || '请输入密码'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                    />
                </div>
                {mode === 'register' && (
                    <div className="field" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <label className="label" style={{ fontWeight: 500, alignSelf: 'flex-start' }}>{t('请再次输入密码') || '请再次输入密码'}</label>
                        <input
                            type="password"
                            className="input-large"
                            style={{ marginBottom: 12, maxWidth: 420, width: '100%' }}
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


