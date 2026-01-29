import React, { useEffect, useMemo, useState } from 'react'

type Lang = 'zh' | 'en'

type Props = {
    lang: Lang
    text: string
    options?: Array<string>
    className?: string
    title?: string
}

function pickBestVoice(voices: SpeechSynthesisVoice[], lang: Lang): SpeechSynthesisVoice | null {
    if (!voices || !voices.length) return null

    const preferredPrefixes = lang === 'zh' ? ['zh-CN', 'zh-TW', 'zh'] : ['en-US', 'en-GB', 'en']

    for (const prefix of preferredPrefixes) {
        const v = voices.find(v => (v.lang || '').toLowerCase().startsWith(prefix.toLowerCase()))
        if (v) return v
    }

    return voices[0] || null
}

function buildSpeechText(lang: Lang, text: string, options?: Array<string>) {
    const cleanText = (text || '').toString().trim()
    const cleanOptions = (options || []).map(o => (o ?? '').toString().trim()).filter(Boolean)

    if (!cleanOptions.length) return cleanText

    const letters = ['A', 'B', 'C', 'D']
    const optLines = cleanOptions.map((o, idx) => `${letters[idx] || String(idx + 1)}. ${o}`)

    if (lang === 'zh') {
        return `题目：${cleanText}。选项：${optLines.join('。')}`
    }

    return `Question: ${cleanText}. Options: ${optLines.join('. ')}`
}

export default function TtsSpeakButton(props: Props) {
    const { lang, text, options, className, title } = props

    const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window

    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
    const [isSpeaking, setIsSpeaking] = useState(false)

    useEffect(() => {
        if (!supported) return

        const update = () => {
            try {
                setVoices(window.speechSynthesis.getVoices() || [])
            } catch {
                setVoices([])
            }
        }

        update()
        window.speechSynthesis.addEventListener('voiceschanged', update)
        return () => {
            try {
                window.speechSynthesis.removeEventListener('voiceschanged', update)
            } catch {
                // ignore
            }
        }
    }, [supported])

    const voice = useMemo(() => pickBestVoice(voices, lang), [voices, lang])

    const buttonTitle = title || (lang === 'zh' ? '朗读题目和选项' : 'Read question and options')

    const speak = () => {
        if (!supported) return

        const synth = window.speechSynthesis
        if (!synth) return

        // Toggle: click again to stop.
        if (synth.speaking || isSpeaking) {
            synth.cancel()
            setIsSpeaking(false)
            return
        }

        const speechText = buildSpeechText(lang, text, options)
        if (!speechText) return

        try {
            synth.cancel()
        } catch {
            // ignore
        }

        const utter = new SpeechSynthesisUtterance(speechText)
        utter.lang = lang === 'zh' ? 'zh-CN' : 'en-US'
        if (voice) utter.voice = voice
        utter.rate = 0.95
        utter.pitch = 1

        utter.onstart = () => setIsSpeaking(true)
        utter.onend = () => setIsSpeaking(false)
        utter.onerror = () => setIsSpeaking(false)

        synth.speak(utter)
    }

    return (
        <button
            type="button"
            className={className || 'btn'}
            title={buttonTitle}
            aria-label={buttonTitle}
            onClick={speak}
            disabled={!supported || !(text || '').trim()}
            style={{
                padding: '2px 8px',
                fontSize: 14,
                lineHeight: '18px',
                opacity: supported ? 1 : 0.6,
                cursor: supported ? 'pointer' : 'not-allowed',
            }}
        >
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                style={{ verticalAlign: 'middle' }}
            >
                <path
                    d="M4 10v4c0 .55.45 1 1 1h3l5 4V5L8 9H5c-.55 0-1 .45-1 1z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                />
                <path
                    d="M16.5 8.5a5 5 0 010 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                />
                <path
                    d="M19 6a9 9 0 010 12"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                />
            </svg>
        </button>
    )
}
