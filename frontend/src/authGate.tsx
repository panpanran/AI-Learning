import React, { useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

function hasSession(): boolean {
    try {
        return Boolean(localStorage.getItem('token') && localStorage.getItem('user'))
    } catch {
        return false
    }
}

/** Protected pages: no session → login (/). */
export function RequireAuth({ children }: { children: React.ReactNode }) {
    const location = useLocation()
    if (!hasSession()) {
        return <Navigate to="/" replace state={{ from: location.pathname }} />
    }
    return <>{children}</>
}

/** Login routes: already logged in → main app. */
export function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
    if (hasSession()) {
        return <Navigate to="/app" replace />
    }
    return <>{children}</>
}

/** Unknown paths: session → /app, else → login. */
export function AuthAwareFallback() {
    return <Navigate to={hasSession() ? '/app' : '/'} replace />
}

/** Re-check session when storage changes (other tabs / logout). */
export function useSessionSync(onChange?: () => void) {
    useEffect(() => {
        const handler = () => onChange?.()
        window.addEventListener('storage', handler)
        return () => window.removeEventListener('storage', handler)
    }, [onChange])
}
