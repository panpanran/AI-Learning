
import LocalAuth from './LocalAuth';
import { useTranslation } from 'react-i18next';

function OAuthLogin() {
    useTranslation();
    return (
        <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
            <LocalAuth />
        </div>
    );
}

export default OAuthLogin;
