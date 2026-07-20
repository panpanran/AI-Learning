/**
 * Build-time version badge (top-left).
 * Injected by Vite at `npm run build` / `npm run dev` start.
 */
import { useEffect } from 'react'

export function getAppVersion(): string {
    const fromEnv = import.meta.env.VITE_APP_VERSION
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
    try {
        if (typeof __APP_BUILD_VERSION__ === 'string' && __APP_BUILD_VERSION__) {
            return __APP_BUILD_VERSION__
        }
    } catch {
        // ignore
    }
    return 'vdev'
}

export default function AppVersionBadge() {
    const version = getAppVersion()

    useEffect(() => {
        const base = 'Max AI Learning'
        if (!document.title.includes(version)) {
            document.title = `${base} ${version}`
        }
    }, [version])

    return (
        <div
            className="app-version-badge"
            title={`Build ${version}`}
            aria-label={`App version ${version}`}
        >
            {version}
        </div>
    )
}
