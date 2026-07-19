import API from './api'

export type GenerationProgressState = {
    id?: string
    stage: string
    percent: number
    message?: string
    error?: string | null
}

export async function beginGenerationProgress(
    token: string,
    kind: 'diagnostic' | 'practice',
    onUpdate: (progress: GenerationProgressState) => void,
) {
    const created = await API.post('/api/generation-progress', { token, kind })
    const id = String(created.data.id)
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
        if (stopped) return
        try {
            const response = await API.get(`/api/generation-progress/${encodeURIComponent(id)}`, {
                headers: { Authorization: `Bearer ${token}` },
            })
            const progress = response.data as GenerationProgressState
            onUpdate(progress)
            if (progress.stage === 'completed' || progress.stage === 'failed') {
                stopped = true
                return
            }
        } catch {
            // A progress check must never interrupt question generation.
        }
        if (!stopped) timer = setTimeout(poll, 1200)
    }

    onUpdate({ ...created.data, id })
    timer = setTimeout(poll, 300)

    return {
        id,
        stop: () => {
            stopped = true
            if (timer) clearTimeout(timer)
        },
    }
}
