declare module '*.svg'

declare const __APP_BUILD_VERSION__: string

interface ImportMetaEnv {
    readonly VITE_APP_VERSION?: string
    readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
