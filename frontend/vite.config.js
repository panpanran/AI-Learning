import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
    // en-US hour12:false can yield "24" for midnight — normalize to "00"
    const hour = parts.hour === '24' ? '00' : parts.hour
    return `v${parts.year}.${parts.month}${parts.day}.${hour}${parts.minute}`
}

const appBuildVersion = process.env.VITE_APP_VERSION || buildAppVersion()

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    define: {
        __APP_BUILD_VERSION__: JSON.stringify(appBuildVersion),
    },
    server: {
        proxy: {
            '/auth': 'http://localhost:4000'
        }
    }
})
