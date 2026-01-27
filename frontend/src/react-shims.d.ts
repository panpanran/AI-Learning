// Minimal JSX IntrinsicElements fallback (removed react module shims to allow @types/react to work)
declare namespace JSX {
    interface IntrinsicElements { [key: string]: any }
}

// Add minimal typing for Vite import.meta.env used in api.ts
interface ImportMetaEnv {
    readonly VITE_BACKEND_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}