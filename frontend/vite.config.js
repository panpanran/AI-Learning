import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Build-time version: vYYYY.MMDD.HHmm in America/New_York (publish clock). */
function buildAppVersion(date = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })
    const parts = Object.fromEntries(
        fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
    )
    const hour = parts.hour === '24' ? '00' : parts.hour
    return `v${parts.year}.${parts.month}${parts.day}.${hour}${parts.minute}`
}

/**
 * Render Static Sites ignore Netlify `_redirects`. Without a Dashboard rewrite,
 * deep links 404. Copying index.html into each client route folder makes
 * `/app/`, `/history/`, … real files the CDN can serve (SPA still boots).
 */
function spaRouteHtmlPlugin(routes = ['app', 'history', 'scores', 'results', 'login', 'mistakes', 'all-correct']) {
    return {
        name: 'spa-route-html',
        apply: 'build',
        closeBundle() {
            const outDir = path.resolve(__dirname, 'dist')
            const indexPath = path.join(outDir, 'index.html')
            if (!fs.existsSync(indexPath)) return
            const html = fs.readFileSync(indexPath, 'utf8')
            for (const route of routes) {
                const dir = path.join(outDir, route)
                fs.mkdirSync(dir, { recursive: true })
                fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8')
            }
        },
    }
}

const appBuildVersion = process.env.VITE_APP_VERSION || buildAppVersion()

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), spaRouteHtmlPlugin()],
    define: {
        // Prefer import.meta.env (reliable with Vite); keep legacy define as fallback.
        'import.meta.env.VITE_APP_VERSION': JSON.stringify(appBuildVersion),
        __APP_BUILD_VERSION__: JSON.stringify(appBuildVersion),
    },
    server: {
        proxy: {
            '/auth': 'http://localhost:4000'
        }
    }
})
