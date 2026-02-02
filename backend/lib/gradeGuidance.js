'use strict';

function parseGradeLevelLoose(raw) {
    const s = (raw ?? '').toString().trim();
    if (!s) return null;
    if (s.toUpperCase() === 'KG') return 0;
    const m1 = s.match(/^G(\d+)$/i);
    if (m1) {
        const n = Number(m1[1]);
        return Number.isFinite(n) ? n : null;
    }
    const m2 = s.match(/(\d+)/);
    if (m2) {
        const n = Number(m2[1]);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/**
 * Returns the guidance string injected into the LLM prompt.
 * Design goal: use DB-configured grade_subjects.description directly whenever present,
 * so scope can be controlled without modifying code.
 */
function getGradeGuidance({ useLang, studentProfile = null, gradeLevel = null, gradeCode = null, subjectCode = null } = {}) {
    const notes = (studentProfile && studentProfile.grade_subject_notes != null)
        ? String(studentProfile.grade_subject_notes).trim()
        : '';

    // Primary: admin-controlled scope notes from DB.
    if (notes) return notes;

    // Minimal fallback when notes are empty.
    const lang = useLang === 'en' ? 'en' : 'zh';
    const sc = (subjectCode != null ? String(subjectCode) : (studentProfile && studentProfile.subject_code != null ? String(studentProfile.subject_code) : ''));
    const gc = (gradeCode != null ? String(gradeCode) : (studentProfile && studentProfile.grade_code != null ? String(studentProfile.grade_code) : ''));
    const gl = Number.isInteger(Number(gradeLevel)) ? Number(gradeLevel)
        : (studentProfile && studentProfile.grade_level != null ? Number(studentProfile.grade_level) : null);

    if (lang === 'zh') {
        const gHint = gc ? `（${gc}）` : (Number.isInteger(gl) ? `（G${gl}）` : '');
        return `请严格围绕 knowledge_points 出题，并匹配该年级${gHint}与学科${sc ? `（${sc}）` : ''}的常见范围与难度；不要超纲。`;
    }

    const gHint = gc || (Number.isInteger(gl) ? `G${gl}` : '');
    return `Stay strictly within the provided knowledge_points and match the typical scope/difficulty for grade ${gHint || '(unknown)'} and subject ${sc || '(unknown)'}; do not go beyond scope.`;
}

module.exports = { parseGradeLevelLoose, getGradeGuidance };
