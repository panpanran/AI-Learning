export type LockedLang = 'zh' | 'en' | null

export function subjectCodeToLockedLang(subjectCode?: string | null): LockedLang {
    const code = (subjectCode || '').trim().toLowerCase()
    if (code === 'chinese') return 'zh'
    if (code === 'english') return 'en'
    return null
}

// Keep UI language switchable; this helper only decides which language to use
// when selecting bilingual *content* fields based on subject.
export function resolveContentLang(uiLang: 'zh' | 'en', subjectCode?: string | null): 'zh' | 'en' {
    return subjectCodeToLockedLang(subjectCode) || uiLang
}

export function readLastSelection(): { gradeId: string, subjectId: string, subjectCode: string | null } {
    try {
        const raw = localStorage.getItem('last_selection')
        const last = raw ? JSON.parse(raw) : null
        return {
            gradeId: last && last.gradeId != null ? String(last.gradeId) : '',
            subjectId: last && last.subjectId != null ? String(last.subjectId) : '',
            subjectCode: last && last.subjectCode != null ? String(last.subjectCode) : null,
        }
    } catch {
        return { gradeId: '', subjectId: '', subjectCode: null }
    }
}

export function writeLastSelection(next: { gradeId: string, subjectId: string, subjectCode?: string | null }) {
    try {
        localStorage.setItem('last_selection', JSON.stringify({
            gradeId: next.gradeId,
            subjectId: next.subjectId,
            subjectCode: next.subjectCode ?? null,
        }))
    } catch {
        // ignore
    }
}

export function readSubjectCodeFromLastSelection(): string | null {
    return readLastSelection().subjectCode
}
