'use strict';

const crypto = require('crypto');

/**
 * Phase C — KnowledgePointPlanner worker.
 * Decides which knowledge_point_id each question slot should use.
 */
async function buildKnowledgePointIdsPlan({
    pool,
    knowledgePoints,
    desiredCount,
    studentUserIds = [],
    gradeId = null,
    subjectId = null,
    useDb = false,
}) {
    const rawIds = (Array.isArray(knowledgePoints) ? knowledgePoints : [])
        .map((k) => (k && k.id != null ? Number(k.id) : null))
        .filter((x) => Number.isInteger(x));
    const ids = Array.from(new Set(rawIds));
    const n = ids.length;
    const m = Math.max(0, Number(desiredCount) || 0);
    if (!n || !m) return [];

    let ordered = ids.slice();

    if (useDb && pool && gradeId != null && subjectId != null && studentUserIds.length) {
        try {
            const r = await pool.query(
                `SELECT q.knowledge_point_id, COUNT(*)::int AS cnt
                 FROM history h
                 JOIN questions q ON q.id = h.question_id
                 WHERE h.user_id = ANY($1::int[])
                   AND q.grade_id = $2
                   AND q.subject_id = $3
                   AND q.knowledge_point_id = ANY($4::int[])
                 GROUP BY q.knowledge_point_id`,
                [studentUserIds, gradeId, subjectId, ids]
            );
            const cntMap = new Map();
            for (const row of (r.rows || [])) {
                const kid = row && row.knowledge_point_id != null ? Number(row.knowledge_point_id) : null;
                const cnt = row && row.cnt != null ? Number(row.cnt) : 0;
                if (Number.isInteger(kid)) cntMap.set(kid, cnt);
            }
            ordered.sort((a, b) => {
                const ca = cntMap.get(a) || 0;
                const cb = cntMap.get(b) || 0;
                if (ca !== cb) return ca - cb;
                return crypto.randomInt(0, 2) === 0 ? -1 : 1;
            });
        } catch {
            ordered = shuffleIds(ids);
        }
    } else {
        ordered = shuffleIds(ids);
    }

    if (m <= n) return ordered.slice(0, m);

    const plan = ordered.slice();
    const poolSize = Math.min(ordered.length, Math.max(3, Math.ceil(ordered.length / 3)));
    const repeatPool = ordered.slice(0, poolSize);
    while (plan.length < m) {
        plan.push(repeatPool[crypto.randomInt(0, repeatPool.length)]);
    }
    return plan;
}

function shuffleIds(ids) {
    const ordered = ids.slice();
    for (let i = ordered.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        const tmp = ordered[i];
        ordered[i] = ordered[j];
        ordered[j] = tmp;
    }
    return ordered;
}

module.exports = {
    buildKnowledgePointIdsPlan,
};
