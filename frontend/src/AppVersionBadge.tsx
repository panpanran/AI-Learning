/**
 * Build-time version badge (top-left). Value is injected by Vite at `npm run build`.
 */
declare const __APP_BUILD_VERSION__: string

export default function AppVersionBadge() {
    const version = typeof __APP_BUILD_VERSION__ !== 'undefined'
        ? __APP_BUILD_VERSION__
        : 'vdev'
    return (
        <div className="app-version-badge" title={`Build ${version}`} aria-label={`App version ${version}`}>
            {version}
        </div>
    )
}
