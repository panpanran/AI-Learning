import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
    ArcElement,
    BarController,
    BarElement,
    CategoryScale,
    Chart,
    Legend,
    LinearScale,
    LineController,
    LineElement,
    PieController,
    PointElement,
    Tooltip,
} from 'chart.js'
import type { QuestionChartSpec } from './parseQuestionChart'

Chart.register(
    BarController,
    PieController,
    LineController,
    BarElement,
    ArcElement,
    PointElement,
    LineElement,
    CategoryScale,
    LinearScale,
    Legend,
    Tooltip,
)

const COLORS = ['#4c8bf5', '#f5a524', '#2bb673', '#e85d4c', '#7b61ff', '#00acc1']

export default function QuestionChart({ spec }: { spec: QuestionChartSpec | null }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const chartRef = useRef<Chart | null>(null)
    const [failed, setFailed] = useState(false)

    const aria = useMemo(() => {
        if (!spec) return ''
        return spec.labels.map((label, i) => `${label}: ${spec.values[i]}`).join(', ')
    }, [spec])

    const specKey = spec ? JSON.stringify(spec) : ''

    useEffect(() => {
        setFailed(false)
        const canvas = canvasRef.current
        const parsed: QuestionChartSpec | null = specKey ? JSON.parse(specKey) : null
        if (!parsed || !canvas) {
            if (chartRef.current) {
                chartRef.current.destroy()
                chartRef.current = null
            }
            return
        }

        try {
            if (chartRef.current) {
                chartRef.current.destroy()
                chartRef.current = null
            }
            const dataset = {
                label: parsed.title || parsed.kind,
                data: parsed.values,
                backgroundColor: parsed.kind === 'line' ? 'rgba(76, 139, 245, 0.18)' : COLORS.slice(0, parsed.values.length),
                borderColor: parsed.kind === 'line' ? '#4c8bf5' : COLORS.slice(0, parsed.values.length),
                borderWidth: parsed.kind === 'line' ? 2 : 1,
                fill: false,
                tension: parsed.kind === 'line' ? 0.25 : 0,
            }
            chartRef.current = new Chart(canvas, {
                type: parsed.kind,
                data: {
                    labels: parsed.labels,
                    datasets: [dataset],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { display: parsed.kind === 'pie' },
                    },
                    scales: parsed.kind === 'pie' ? undefined : {
                        x: { ticks: { maxRotation: 0 } },
                        y: { beginAtZero: true },
                    },
                },
            })
        } catch {
            setFailed(true)
            if (chartRef.current) {
                chartRef.current.destroy()
                chartRef.current = null
            }
        }

        return () => {
            if (chartRef.current) {
                chartRef.current.destroy()
                chartRef.current = null
            }
        }
    }, [specKey])

    if (!spec || failed) return null

    return (
        <div
            className="question-chart"
            style={{ marginTop: 10 }}
        >
            <div
                style={{ height: 220, position: 'relative' }}
                aria-label={aria}
                role="img"
            >
                <canvas ref={canvasRef} />
            </div>
            {spec.illustrative && spec.caption ? (
                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                    {spec.caption}
                </div>
            ) : null}
        </div>
    )
}
