import axios from 'axios'

const API = axios.create({ baseURL: import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000' })

API.interceptors.response.use(
    (res) => res,
    (err) => {
        const status = err?.response?.status
        if (status === 401 || status === 403) {
            try {
                localStorage.removeItem('token')
                localStorage.removeItem('user')
            } catch { /* ignore */ }
            const path = window.location.pathname || ''
            if (path.startsWith('/app') || path.startsWith('/scores') || path.startsWith('/history') || path.startsWith('/results')) {
                window.location.replace('/')
            }
        }
        return Promise.reject(err)
    }
)

export default API
