import React from 'react'
import { useTranslation } from 'react-i18next'
import type { GenerationProgressState } from './generationProgress'

const stageKeys: Record<string, string> = {
    queued: 'generation_queued',
    planning: 'generation_planning',
    searching_db: 'generation_searching_db',
    generating: 'generation_generating',
    validating: 'generation_validating',
    deduplicating: 'generation_deduplicating',
    persisting: 'generation_persisting',
    evaluating: 'generation_evaluating',
    preparing: 'generation_preparing',
    completed: 'generation_completed',
    failed: 'generation_failed',
}

export default function GenerationProgressBar({ progress }: { progress: GenerationProgressState | null }) {
    const { t } = useTranslation()
    const percent = Math.max(2, Math.min(100, Math.round(progress?.percent ?? 4)))
    const label = progress ? t(stageKeys[progress.stage] || 'ai_generating') : t('ai_generating')

    return (
        <div className="generation-progress" role="status" aria-live="polite">
            <div className="generation-progress-label">
                <span>{label}</span>
                <strong>{percent}%</strong>
            </div>
            <div
                className="generation-progress-track"
                role="progressbar"
                aria-label={String(label)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
            >
                <div className="generation-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="generation-progress-note">{t('generation_wait_note')}</div>
        </div>
    )
}
