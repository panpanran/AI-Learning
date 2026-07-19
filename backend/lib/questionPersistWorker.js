'use strict';

/**
 * Phase C — QuestionPersistWorker: insert one question row (+ optional Pinecone metadata).
 */
async function persistQuestion({
    pool,
    question,
    gradeId,
    subjectId,
    pcClient = null,
    buildQuestionDedupeEmbeddingText = null,
    logFn = null,
}) {
    const log = typeof logFn === 'function' ? logFn : () => {};
    const q = question;
    if (!pool || !q) return { insertedId: null, error: 'missing pool or question' };

    let insertedId = null;
    try {
        const ins = await pool.query(
            `INSERT INTO questions(content_cn, content_en, options, content_options_hash, metadata, embedding, answer_cn, answer_en, explanation_cn, explanation_en, knowledge_point_id, grade_id, subject_id)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (content_options_hash) DO UPDATE
             SET content_cn = EXCLUDED.content_cn,
                 content_en = EXCLUDED.content_en,
                 options = EXCLUDED.options,
                 metadata = EXCLUDED.metadata,
                 embedding = EXCLUDED.embedding,
                 answer_cn = EXCLUDED.answer_cn,
                 answer_en = EXCLUDED.answer_en,
                 explanation_cn = EXCLUDED.explanation_cn,
                 explanation_en = EXCLUDED.explanation_en,
                 knowledge_point_id = EXCLUDED.knowledge_point_id,
                 grade_id = EXCLUDED.grade_id,
                 subject_id = EXCLUDED.subject_id
             RETURNING id`,
            [
                q.content_cn,
                q.content_en,
                JSON.stringify(q.options),
                q.content_options_hash,
                q.metadata ? JSON.stringify(q.metadata) : null,
                Array.isArray(q.embedding) ? q.embedding : null,
                q.answer_cn,
                q.answer_en,
                q.explanation_cn,
                q.explanation_en,
                q.knowledge_point_id || null,
                gradeId,
                subjectId,
            ]
        );
        insertedId = ins.rows[0] ? Number(ins.rows[0].id) : null;
    } catch {
        insertedId = null;
    }

    if (!Number.isInteger(insertedId)) {
        try {
            const sel = await pool.query(
                'SELECT id FROM questions WHERE content_options_hash=$1 LIMIT 1',
                [q.content_options_hash]
            );
            insertedId = sel.rows[0] ? Number(sel.rows[0].id) : null;
        } catch {
            insertedId = null;
        }
    }

    if (Number.isInteger(insertedId) && pcClient && typeof buildQuestionDedupeEmbeddingText === 'function') {
        try {
            const metaText = buildQuestionDedupeEmbeddingText(q, {
                gradeId,
                subjectId,
                knowledgePointId: q.knowledge_point_id || null,
            });
            if (metaText && typeof pcClient.embedTexts === 'function' && typeof pcClient.upsertVectors === 'function') {
                const v = ((await pcClient.embedTexts([metaText], 'passage')) || [])[0] || null;
                if (v && Array.isArray(v) && v.length) {
                    const md = {
                        kind: 'question_metadata',
                        question_id: insertedId,
                        grade_id: gradeId,
                        subject_id: subjectId,
                        knowledge_point_id: q.knowledge_point_id || null,
                        expression: q.metadata && q.metadata.expression ? String(q.metadata.expression) : null,
                        content_options_hash: q.content_options_hash || null,
                    };
                    await pcClient.upsertVectors([{ id: `qmeta:${insertedId}`, values: v, metadata: md }]);
                    log('[persist] pinecone upserted question_metadata:', { id: `qmeta:${insertedId}` });
                }
            }
        } catch (e) {
            log('[persist] pinecone upsert failed:', e && e.message ? e.message : e);
        }
    }

    return { insertedId };
}

module.exports = {
    persistQuestion,
};
