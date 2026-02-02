'use strict';

const crypto = require('crypto');

function registerDiagnosticRoutes({ app, deps }) {
    if (!app) throw new Error('registerDiagnosticRoutes: app is required');
    if (!deps) throw new Error('registerDiagnosticRoutes: deps is required');

    const {
        diagLog,
        jwt,
        JWT_SECRET,
        users,
        getUseDb,
        pool,
        resolveGradeSubject,
        parseGradeLevelLoose,
        getGradeGuidance,
        getUserIdsByUsername,
        getKnowledgePointScoresFromHistory,
        dbFirstSelectAndMaybeGenerateWithGpt,
        getPineconeQuestionDedupeConfig,
        getSimilarityThreshold,
        coerceEmbeddingArray,
        embedTextsOpenAI,
        buildMetadataEmbeddingText,
        buildQuestionDedupeEmbeddingText,
        cosineSimilarity,
        getPinecone,
        prompts,
        applyTemplateAll,
        getOpenAI,
        createChatCompletionJson,
        safeParseJsonObject,
        validateDiagnostic,
    } = deps;

    // Generate a diagnostic tailored to the student.
    app.post('/api/generate/diagnostic', async (req, res) => {
        const { token, grade, subject, grade_id, subject_id, lang } = req.body;
        diagLog('[diagnostic] payload:', { ...req.body, token: token ? '<redacted>' : null });
        if (!token) {
            diagLog('[diagnostic] missing token');
            return res.status(400).json({ error: 'Token required' });
        }

        try {
            diagLog('[diagnostic] entered handler');
            if (process.env.NODE_ENV === 'test') diagLog('HANDLER GENERATE: app.locals.openai present:', !!req.app?.locals?.openai);

            let data;
            try {
                data = jwt.verify(token, JWT_SECRET);
                diagLog('[diagnostic] token valid, user:', data);
            } catch (e) {
                diagLog('[diagnostic] invalid token:', e && e.message ? e.message : e);
                return res.status(401).json({ error: 'Invalid token' });
            }

            const useDb = typeof getUseDb === 'function' ? !!getUseDb() : false;

            let user = users[data.id];
            if (useDb) {
                const r = await pool.query('SELECT * FROM users WHERE id=$1', [data.id]);
                user = r.rows[0];
            }
            diagLog('[diagnostic] user loaded:', user);
            if (!user) {
                diagLog('[diagnostic] user not found for id:', data.id);
                return res.status(404).json({ error: 'User not found' });
            }

            diagLog('[diagnostic] grade:', grade, 'subject:', subject, 'grade_id:', grade_id, 'subject_id:', subject_id);

            const numQuestions = 5;

            // Must have grade/subject or grade_id/subject_id
            if ((!grade || !subject) && (!grade_id || !subject_id)) {
                try {
                    console.warn('[diagnostic] 400 missing grade/subject', {
                        grade,
                        subject,
                        grade_id,
                        subject_id,
                        norm_grade_id: grade_id != null ? Number(grade_id) : null,
                        norm_subject_id: subject_id != null ? Number(subject_id) : null,
                        lang,
                        token: '<redacted>',
                    });
                } catch { }
                diagLog('[diagnostic] missing grade/subject and grade_id/subject_id');
                return res.status(400).json({ error: 'grade/subject (legacy) or grade_id/subject_id are required. Please select them in the frontend.' });
            }

            const resolved = await resolveGradeSubject({ grade, subject, grade_id, subject_id });
            const useGradeId = resolved.gradeId != null ? resolved.gradeId : (grade_id != null ? Number(grade_id) : null);
            const useSubjectId = resolved.subjectId != null ? resolved.subjectId : (subject_id != null ? Number(subject_id) : null);
            const gradeCode = resolved.gradeCode != null ? String(resolved.gradeCode) : (grade != null ? String(grade) : null);
            const subjectCode = resolved.subjectCode != null ? String(resolved.subjectCode) : (subject != null ? String(subject) : null);
            const gradeLevel = parseGradeLevelLoose(gradeCode || grade);

            let gradeSubjectId = null;
            if (useDb && useGradeId && useSubjectId) {
                try {
                    const r = await pool.query('SELECT id FROM grade_subjects WHERE grade_id=$1 AND subject_id=$2 LIMIT 1', [useGradeId, useSubjectId]);
                    gradeSubjectId = r.rows[0] ? r.rows[0].id : null;
                } catch {
                    gradeSubjectId = null;
                }
            }

            // Optional curriculum notes per grade+subject (editable in DB).
            let gradeSubjectNotes = '';
            if (useDb && gradeSubjectId) {
                try {
                    const r = await pool.query('SELECT description FROM grade_subjects WHERE id=$1 LIMIT 1', [gradeSubjectId]);
                    gradeSubjectNotes = (r.rows[0] && r.rows[0].description != null) ? String(r.rows[0].description) : '';
                } catch {
                    gradeSubjectNotes = '';
                }
            }

            // Language selection
            const useLang = lang === 'en' ? 'en' : 'zh';
            diagLog('[diagnostic] language selection:', useLang);
            diagLog('[diagnostic] reached selection logic, user:', user, 'grade_id:', useGradeId, 'subject_id:', useSubjectId, 'lang:', useLang);

            if (useDb && (!useGradeId || !useSubjectId)) {
                return res.status(400).json({ error: 'grade_id and subject_id are required (or provide legacy grade/subject that can be resolved to ids).' });
            }

            // Resolve display names for prompt/title
            let gradeNameZh = '';
            let gradeNameEn = '';
            let subjectNameZh = '';
            let subjectNameEn = '';
            if (useDb && useGradeId) {
                try {
                    const r = await pool.query('SELECT name_zh, name_en FROM grades WHERE id = $1', [useGradeId]);
                    gradeNameZh = (r.rows[0]?.name_zh || '') || '';
                    gradeNameEn = (r.rows[0]?.name_en || '') || '';
                } catch { }
            }
            if (useDb && useSubjectId) {
                try {
                    const r = await pool.query('SELECT name_zh, name_en FROM subjects WHERE id = $1', [useSubjectId]);
                    subjectNameZh = (r.rows[0]?.name_zh || '') || '';
                    subjectNameEn = (r.rows[0]?.name_en || '') || '';
                } catch { }
            }
            if ((!gradeNameZh || !gradeNameEn) && grade) {
                const g = String(grade);
                if (!gradeNameZh) gradeNameZh = g;
                if (!gradeNameEn) gradeNameEn = g;
            }
            if ((!subjectNameZh || !subjectNameEn) && subject) {
                const s = String(subject);
                if (!subjectNameZh) subjectNameZh = s;
                if (!subjectNameEn) subjectNameEn = s;
            }

            const gradeDisplayName = useLang === 'zh' ? gradeNameZh : gradeNameEn;
            const subjectDisplayName = useLang === 'zh' ? subjectNameZh : subjectNameEn;

            const lessonBilingual = {
                title_cn: `${gradeNameZh} ${subjectNameZh} 诊断测试`.trim() || '诊断测试',
                title_en: `${gradeNameEn} ${subjectNameEn} Diagnostic Test`.trim() || 'Diagnostic Test',
                explanation_cn: '请完成以下题目以评估学习水平。',
                explanation_en: 'Please complete these questions to assess your level.'
            };

            // Merge all DB user_ids under same username
            let studentUserIds = [user.id];
            if (useDb) {
                try {
                    const uname = user && user.username ? String(user.username) : null;
                    const ids = uname ? await getUserIdsByUsername(uname) : [];
                    if (Array.isArray(ids) && ids.length) studentUserIds = ids;
                } catch {
                    studentUserIds = [user.id];
                }
            }

            const buildKnowledgePointIdsPlan = async (knowledgePoints, desiredCount) => {
                const rawIds = (Array.isArray(knowledgePoints) ? knowledgePoints : [])
                    .map(k => (k && k.id != null ? Number(k.id) : null))
                    .filter(x => Number.isInteger(x));
                const ids = Array.from(new Set(rawIds));
                const n = ids.length;
                const m = Math.max(0, Number(desiredCount) || 0);
                if (!n || !m) return [];

                let ordered = ids.slice();

                if (useDb && useGradeId && useSubjectId) {
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
                            [studentUserIds, useGradeId, useSubjectId, ids]
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
                        ordered = ids.slice();
                        for (let i = ordered.length - 1; i > 0; i--) {
                            const j = crypto.randomInt(0, i + 1);
                            const tmp = ordered[i];
                            ordered[i] = ordered[j];
                            ordered[j] = tmp;
                        }
                    }
                } else {
                    for (let i = ordered.length - 1; i > 0; i--) {
                        const j = crypto.randomInt(0, i + 1);
                        const tmp = ordered[i];
                        ordered[i] = ordered[j];
                        ordered[j] = tmp;
                    }
                }

                if (m <= n) return ordered.slice(0, m);

                const plan = ordered.slice();
                const poolSize = Math.min(ordered.length, Math.max(3, Math.ceil(ordered.length / 3)));
                const repeatPool = ordered.slice(0, poolSize);
                while (plan.length < m) {
                    plan.push(repeatPool[crypto.randomInt(0, repeatPool.length)]);
                }
                return plan;
            };

            let knowledgePointsForPrompt = [];
            let allowedKnowledgePointIds = new Set();
            if (useDb) {
                if (!gradeSubjectId) {
                    return res.status(400).json({ error: 'grade_subject_id not found for this grade_id + subject_id. Please seed grade_subjects first.' });
                }
                try {
                    const kpRes = await pool.query(
                        `SELECT id, name_cn, name_en, unit_name_cn, unit_name_en, description, difficulty_avg, sort_order
                         FROM knowledge_points
                         WHERE grade_subject_id=$1 AND (is_active IS NULL OR is_active = TRUE)
                         ORDER BY sort_order NULLS LAST, id ASC`,
                        [gradeSubjectId]
                    );
                    knowledgePointsForPrompt = kpRes.rows.map(r => ({
                        id: r.id,
                        name_cn: r.name_cn != null ? String(r.name_cn) : '',
                        name_en: r.name_en != null ? String(r.name_en) : '',
                        unit_name_cn: r.unit_name_cn != null ? String(r.unit_name_cn) : '',
                        unit_name_en: r.unit_name_en != null ? String(r.unit_name_en) : '',
                        description: r.description != null ? String(r.description) : '',
                        difficulty_avg: r.difficulty_avg != null ? Number(r.difficulty_avg) : null,
                        sort_order: r.sort_order != null ? Number(r.sort_order) : null
                    }));
                    allowedKnowledgePointIds = new Set(knowledgePointsForPrompt.map(k => k.id));
                } catch {
                    knowledgePointsForPrompt = [];
                    allowedKnowledgePointIds = new Set();
                }
                if (!knowledgePointsForPrompt.length) {
                    return res.status(400).json({
                        error: 'No knowledge points seeded for this grade+subject. Please seed knowledge_points first.',
                        grade_subject_id: gradeSubjectId
                    });
                }
            } else {
                knowledgePointsForPrompt = [
                    { id: 1, name_cn: '基础概念', name_en: 'Basics', unit_name_cn: '单元1', unit_name_en: 'Unit 1', description: 'Basic definitions and simple facts.', difficulty_avg: 2, sort_order: 10 },
                    { id: 2, name_cn: '核心技能', name_en: 'Core Skills', unit_name_cn: '单元2', unit_name_en: 'Unit 2', description: 'Core methods and typical problem solving.', difficulty_avg: 3, sort_order: 20 }
                ];
                allowedKnowledgePointIds = new Set(knowledgePointsForPrompt.map(k => k.id));
            }

            const knowledgePointIdsPlanForNumQuestions = await buildKnowledgePointIdsPlan(knowledgePointsForPrompt, numQuestions);

            diagLog('[diagnostic] branch selection, useDb:', useDb);
            if (!useDb) {
                diagLog('[diagnostic] in-memory mode');

                const student_profile = {
                    id: user.id,
                    grade: gradeDisplayName,
                    subject: subjectDisplayName,
                    lang: useLang,
                    grade_code: gradeCode,
                    grade_level: gradeLevel,
                    subject_code: subjectCode,
                    grade_subject_notes: gradeSubjectNotes,
                };

                const sysTpl = (useLang === 'zh' && prompts && prompts.diagnostic.system_zh)
                    ? prompts.diagnostic.system_zh
                    : (prompts && prompts.diagnostic.system_en)
                        ? prompts.diagnostic.system_en
                        : 'You are a helpful tutoring assistant. Output strict JSON.';

                const userTpl = (useLang === 'zh' && prompts && prompts.diagnostic.user_zh)
                    ? prompts.diagnostic.user_zh
                    : (prompts && prompts.diagnostic.user_en)
                        ? prompts.diagnostic.user_en
                        : 'Generate a diagnostic test as JSON.';

                const userMessage = applyTemplateAll(userTpl, {
                    student_profile: JSON.stringify(student_profile),
                    num_questions: String(numQuestions),
                    retrieval_snippets: JSON.stringify([]),
                    knowledge_points: JSON.stringify(knowledgePointsForPrompt),
                    knowledge_point_ids_plan: JSON.stringify(knowledgePointIdsPlanForNumQuestions),
                    avoid_metadata: JSON.stringify([]),
                    grade_guidance: getGradeGuidance({ useLang, studentProfile: student_profile, gradeLevel, gradeCode, subjectCode }),
                });

                const aiClient = getOpenAI();
                if (!aiClient) {
                    diagLog('[diagnostic] OpenAI client not configured');
                    return res.status(503).json({ error: 'OpenAI not configured' });
                }

                const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
                diagLog('[diagnostic] calling OpenAI model', model);

                let completion;
                try {
                    completion = await createChatCompletionJson(aiClient, {
                        model,
                        messages: [
                            { role: 'system', content: sysTpl },
                            { role: 'user', content: userMessage }
                        ],
                        max_tokens: 5000
                    });
                } catch (e) {
                    console.error('[diagnostic] --- LOG H.OPENAI ERROR:', e && e.stack ? e.stack : e);
                    return res.status(500).json({ error: 'OpenAI API 调用失败', detail: e && e.message ? e.message : e });
                }

                const text = completion.choices[0].message.content;
                diagLog('[diagnostic] OpenAI response received, length:', (text || '').length);

                const gen = safeParseJsonObject(text);
                if (!gen) {
                    diagLog('[diagnostic] failed to parse generated JSON');
                    return res.status(500).json({ error: 'Failed to parse generated JSON' });
                }

                if (gen && Array.isArray(gen.questions)) {
                    gen.questions.forEach(q => {
                        if (!q || q.id === undefined) return;
                        const raw = q.id;
                        const asNum = (typeof raw === 'number') ? raw : Number(raw);
                        if (Number.isFinite(asNum) && String(raw).trim() !== '' && String(raw).trim() === String(asNum)) {
                            q.id = asNum;
                        } else {
                            q.id = String(raw);
                        }
                    });

                    const fallbackKpId = knowledgePointsForPrompt[0] ? Number(knowledgePointsForPrompt[0].id) : 1;
                    gen.questions.forEach((q, idx) => {
                        const planned = knowledgePointIdsPlanForNumQuestions[idx];
                        if (Number.isInteger(planned) && (!allowedKnowledgePointIds.size || allowedKnowledgePointIds.has(planned))) {
                            q.knowledge_point_id = planned;
                            return;
                        }
                        const kpId = Number(q.knowledge_point_id);
                        if (!Number.isInteger(kpId) || (allowedKnowledgePointIds.size && !allowedKnowledgePointIds.has(kpId))) {
                            q.knowledge_point_id = fallbackKpId;
                        } else {
                            q.knowledge_point_id = kpId;
                        }
                    });
                }

                diagLog('[diagnostic] returning in-memory diagnostic result');
                return res.json({
                    generated: true,
                    lesson: {
                        title: useLang === 'zh' ? lessonBilingual.title_cn : lessonBilingual.title_en,
                        explanation: useLang === 'zh' ? lessonBilingual.explanation_cn : lessonBilingual.explanation_en,
                        title_cn: lessonBilingual.title_cn,
                        title_en: lessonBilingual.title_en,
                        explanation_cn: lessonBilingual.explanation_cn,
                        explanation_en: lessonBilingual.explanation_en,
                        images: (gen.lesson && gen.lesson.images) || []
                    },
                    questions: gen.questions
                });
            }

            // DB-first selection pipeline
            let usedKnowledgePoints = [];
            diagLog('[diagnostic] DB mode: selection pipeline start');
            diagLog('[diagnostic] querying usedKnowledgePoints');

            try {
                const params = [studentUserIds, useGradeId, useSubjectId];
                const kpRows = await pool.query(
                    `SELECT DISTINCT q.knowledge_point_id
                     FROM history h
                     JOIN questions q
                       ON (q.id = h.question_id)
                     WHERE h.user_id = ANY($1::int[])
                       AND q.grade_id = $2
                       AND q.subject_id = $3
                       AND q.knowledge_point_id IS NOT NULL`,
                    params
                );
                usedKnowledgePoints = kpRows.rows.map(r => r.knowledge_point_id);
                diagLog('[diagnostic] usedKnowledgePoints =', usedKnowledgePoints);
            } catch (e) {
                usedKnowledgePoints = [];
                diagLog('[diagnostic] usedKnowledgePoints query failed:', e.message || e);
            }

            let focusKnowledgePoints = [];
            diagLog('[diagnostic] querying focusKnowledgePoints');
            try {
                if (usedKnowledgePoints.length) {
                    const desiredKpCount = Math.max(1, Math.min(
                        Number(numQuestions) || 1,
                        Array.isArray(knowledgePointsForPrompt) && knowledgePointsForPrompt.length ? knowledgePointsForPrompt.length : Number(numQuestions) || 1
                    ));

                    const stats = await getKnowledgePointScoresFromHistory({
                        userIds: studentUserIds,
                        gradeId: useGradeId,
                        subjectId: useSubjectId,
                        knowledgePointIds: usedKnowledgePoints,
                    });

                    stats.sort((a, b) => {
                        const sa = Number.isFinite(a.score) ? a.score : 0;
                        const sb = Number.isFinite(b.score) ? b.score : 0;
                        if (sa !== sb) return sa - sb;
                        if ((a.total || 0) !== (b.total || 0)) return (a.total || 0) - (b.total || 0);
                        return crypto.randomInt(0, 2) === 0 ? -1 : 1;
                    });

                    focusKnowledgePoints = stats.map(x => x.knowledge_point_id).slice(0, desiredKpCount);
                    diagLog('[diagnostic] focusKnowledgePoints (from history scores) =', focusKnowledgePoints);
                }
            } catch (e) {
                focusKnowledgePoints = [];
                diagLog('[diagnostic] focusKnowledgePoints history-score calc failed:', e.message || e);
            }

            const genRes = await dbFirstSelectAndMaybeGenerateWithGpt({
                numQuestions,
                studentUserIds,
                gradeId: useGradeId,
                subjectId: useSubjectId,
                knowledgePointId: null,
                preferredKnowledgePointIds: (focusKnowledgePoints && focusKnowledgePoints.length) ? focusKnowledgePoints : null,
                avoidMetadataKnowledgePointId: null,
                promptCtx: {
                    useLang,
                    student_profile: {
                        id: user.id,
                        grade: gradeDisplayName,
                        subject: subjectDisplayName,
                        lang: useLang,
                        grade_code: gradeCode,
                        grade_level: gradeLevel,
                        subject_code: subjectCode,
                        grade_subject_notes: gradeSubjectNotes,
                        focus_knowledge_points: focusKnowledgePoints
                    },
                    knowledgePointsForPrompt,
                    allowedKnowledgePointIds,
                    buildKnowledgePointIdsPlan,
                    max_tokens: 5000,
                },
                logFn: diagLog,
            });

            if (genRes && genRes.error) {
                return res.status(genRes.error.status).json(genRes.error.body);
            }

            let questionsOut = (genRes && genRes.questionsOut) ? genRes.questionsOut : [];
            let accepted = (genRes && genRes.generatedQuestions) ? genRes.generatedQuestions : [];
            const genLesson = (genRes && genRes.generatedLesson) ? genRes.generatedLesson : null;

            diagLog('[diagnostic] questionsOut.length after selection =', questionsOut.length);

            if (questionsOut.length < numQuestions) {
                diagLog('[diagnostic] still not enough after DB fetch; will insert GPT-generated questions');
                let returnPool = accepted;

                const baseQuestionDedupeCfg = getPineconeQuestionDedupeConfig();

                const clamp01 = (x) => {
                    const n = Number(x);
                    if (!Number.isFinite(n)) return null;
                    return Math.max(0, Math.min(0.999, n));
                };

                const maxFillAttempts = Math.max(1, Math.min(4, Number(process.env.DIAGNOSTIC_FILL_ATTEMPTS) || 3));
                let attempt = 0;

                const enableSemanticDedupe = process.env.SEMANTIC_DEDUPE === '1';
                const semanticThresholdBase = getSimilarityThreshold('SEMANTIC_DEDUPE_THRESHOLD', 0.92);

                let existingEmbeddings = [];
                if (enableSemanticDedupe) {
                    try {
                        const r = await pool.query(
                            `SELECT id, content_options_hash, embedding
                             FROM questions
                             WHERE grade_id = $1 AND subject_id = $2 AND embedding IS NOT NULL
                             ORDER BY created_at DESC NULLS LAST, id DESC
                             LIMIT 2000`,
                            [useGradeId, useSubjectId]
                        );
                        existingEmbeddings = (r.rows || []).map(row => ({
                            id: row.id != null ? Number(row.id) : null,
                            hash: row.content_options_hash != null ? String(row.content_options_hash) : null,
                            embedding: coerceEmbeddingArray(row.embedding)
                        })).filter(x => Array.isArray(x.embedding));
                    } catch {
                        existingEmbeddings = [];
                    }
                }

                if (enableSemanticDedupe && returnPool.length) {
                    try {
                        const embedTexts = [];
                        const embedIndexes = [];
                        for (let i = 0; i < returnPool.length; i++) {
                            const q = returnPool[i];
                            const existing = q ? coerceEmbeddingArray(q.embedding) : null;
                            if (existing) continue;
                            const t = q && q.metadata ? buildMetadataEmbeddingText(q.metadata) : '';
                            if (!t) continue;
                            embedIndexes.push(i);
                            embedTexts.push(t);
                        }
                        if (embedTexts.length) {
                            const vecs = await embedTextsOpenAI(embedTexts);
                            if (Array.isArray(vecs) && vecs.length === embedTexts.length) {
                                for (let j = 0; j < embedIndexes.length; j++) {
                                    returnPool[embedIndexes[j]].embedding = vecs[j];
                                }
                            }
                        }
                    } catch {
                        // ignore
                    }
                }

                const enableMetadataDedupeBase = true;
                const metadataThresholdBase = getSimilarityThreshold('METADATA_DEDUPE_THRESHOLD', 0.9);

                const pcForMetadata = (() => {
                    try {
                        const pc = getPinecone();
                        if (!pc || typeof pc.embedTexts !== 'function' || typeof pc.queryByVector !== 'function' || typeof pc.upsertVectors !== 'function') return null;
                        return pc;
                    } catch {
                        return null;
                    }
                })();

                const maybeRegenerate = async (needCount, relaxStep) => {
                    try {
                        const relaxed = clamp01(Math.max(Number(baseQuestionDedupeCfg.threshold) || 0.9, 0.9) + (Number(relaxStep) || 0) * 0.04);
                        const regenRes = await dbFirstSelectAndMaybeGenerateWithGpt({
                            numQuestions: Math.max(1, Math.min(20, Number(needCount) || 1)),
                            studentUserIds,
                            gradeId: useGradeId,
                            subjectId: useSubjectId,
                            knowledgePointId: null,
                            preferredKnowledgePointIds: (focusKnowledgePoints && focusKnowledgePoints.length) ? focusKnowledgePoints : null,
                            avoidMetadataKnowledgePointId: null,
                            dedupeCfgOverride: {
                                enabled: true,
                                threshold: (relaxed != null ? relaxed : 0.95),
                                topK: baseQuestionDedupeCfg.topK,
                            },
                            promptCtx: {
                                useLang,
                                student_profile: {
                                    id: user.id,
                                    grade: gradeDisplayName,
                                    subject: subjectDisplayName,
                                    lang: useLang,
                                    grade_code: gradeCode,
                                    grade_level: gradeLevel,
                                    subject_code: subjectCode,
                                    grade_subject_notes: gradeSubjectNotes,
                                    focus_knowledge_points: focusKnowledgePoints
                                },
                                knowledgePointsForPrompt,
                                allowedKnowledgePointIds,
                                buildKnowledgePointIdsPlan,
                                max_tokens: 5000,
                            },
                            logFn: diagLog,
                        });
                        const newAccepted = (regenRes && regenRes.generatedQuestions) ? regenRes.generatedQuestions : [];
                        if (Array.isArray(newAccepted) && newAccepted.length) {
                            accepted = accepted.concat(newAccepted);
                            returnPool = accepted;
                            diagLog('[diagnostic] regenerated candidates:', { added: newAccepted.length, total_pool: returnPool.length, relaxStep });
                        }
                    } catch (e) {
                        diagLog('[diagnostic] regeneration failed:', e && e.message ? e.message : String(e));
                    }
                };

                while (questionsOut.length < numQuestions && attempt < maxFillAttempts) {
                    const relaxStep = attempt;
                    const enableMetadataDedupe = enableMetadataDedupeBase && relaxStep < 2;
                    const enableSemanticDedupeThisAttempt = enableSemanticDedupe && relaxStep < 1;
                    const metadataThreshold = clamp01(Math.max(Number(metadataThresholdBase) || 0.9, 0.9) + relaxStep * 0.04) ?? 0.95;
                    const semanticThreshold = clamp01(Math.max(Number(semanticThresholdBase) || 0.92, 0.92) + relaxStep * 0.03) ?? 0.96;

                    if (!Array.isArray(returnPool) || returnPool.length < (numQuestions - questionsOut.length)) {
                        await maybeRegenerate(numQuestions - questionsOut.length, relaxStep);
                    }

                    const beforeLen = questionsOut.length;
                    for (const q of (returnPool || [])) {
                        if (questionsOut.length >= numQuestions) break;

                        if (enableMetadataDedupe && pcForMetadata && q) {
                            try {
                                const metaText = buildQuestionDedupeEmbeddingText(q, {
                                    gradeId: useGradeId,
                                    subjectId: useSubjectId,
                                    knowledgePointId: q.knowledge_point_id || null,
                                });
                                if (metaText) {
                                    const v = ((await pcForMetadata.embedTexts([metaText], 'query')) || [])[0] || null;
                                    if (v && Array.isArray(v) && v.length) {
                                        const filter = {
                                            kind: { "$eq": "question_metadata" },
                                            grade_id: { "$eq": useGradeId },
                                            subject_id: { "$eq": useSubjectId },
                                        };
                                        const pq = await pcForMetadata.queryByVector(v, 3, filter);
                                        const matches = (pq && pq.matches) ? pq.matches : [];
                                        const best = matches.length ? Number(matches[0].score) : NaN;
                                        if (Number.isFinite(best) && best >= metadataThreshold) {
                                            diagLog('[diagnostic] metadata-dedupe skip (pinecone score):', { score: best, threshold: metadataThreshold, expression: q.metadata && q.metadata.expression });
                                            continue;
                                        }
                                    }
                                }
                            } catch (e) {
                                diagLog('[diagnostic] metadata-dedupe pinecone query failed:', e && e.message ? e.message : String(e));
                            }
                        }

                        if (enableSemanticDedupeThisAttempt && Array.isArray(q.embedding) && existingEmbeddings.length) {
                            let best = -1;
                            let bestId = null;
                            for (const ex of existingEmbeddings) {
                                const s = cosineSimilarity(q.embedding, ex.embedding);
                                if (s > best) {
                                    best = s;
                                    bestId = ex.id;
                                }
                            }
                            if (best >= semanticThreshold) {
                                diagLog('[diagnostic] semantic-dedupe skip (db similarity):', { similarity: best, existing_id: bestId });
                                continue;
                            }
                        }

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
                                    useGradeId,
                                    useSubjectId
                                ]
                            );
                            insertedId = ins.rows[0] ? Number(ins.rows[0].id) : null;
                        } catch { }

                        if (!Number.isInteger(insertedId)) {
                            try {
                                const sel = await pool.query('SELECT id FROM questions WHERE content_options_hash=$1 LIMIT 1', [q.content_options_hash]);
                                insertedId = sel.rows[0] ? Number(sel.rows[0].id) : null;
                            } catch {
                                insertedId = null;
                            }
                        }

                        if (!Number.isInteger(insertedId)) {
                            continue;
                        }

                        if (enableMetadataDedupe && pcForMetadata && Number.isInteger(insertedId) && q) {
                            try {
                                const metaText = buildQuestionDedupeEmbeddingText(q, {
                                    gradeId: useGradeId,
                                    subjectId: useSubjectId,
                                    knowledgePointId: q.knowledge_point_id || null,
                                });
                                if (metaText) {
                                    const v = ((await pcForMetadata.embedTexts([metaText], 'passage')) || [])[0] || null;
                                    if (v && Array.isArray(v) && v.length) {
                                        const md = {
                                            kind: 'question_metadata',
                                            question_id: insertedId,
                                            grade_id: useGradeId,
                                            subject_id: useSubjectId,
                                            knowledge_point_id: q.knowledge_point_id || null,
                                            expression: q.metadata && q.metadata.expression ? String(q.metadata.expression) : null,
                                            content_options_hash: q.content_options_hash || null,
                                        };
                                        await pcForMetadata.upsertVectors([{ id: `qmeta:${insertedId}`, values: v, metadata: md }]);
                                        diagLog('[diagnostic] pinecone upserted question_metadata:', { id: `qmeta:${insertedId}`, grade_id: useGradeId, subject_id: useSubjectId });
                                    }
                                }
                            } catch (e) {
                                diagLog('[diagnostic] pinecone upsert failed:', e && e.message ? e.message : String(e));
                            }
                        }

                        questionsOut.push({
                            id: Number.isInteger(insertedId) ? insertedId : null,
                            type: q.type,
                            content_cn: q.content_cn,
                            content_en: q.content_en,
                            options: q.options,
                            content_options_hash: q.content_options_hash,
                            metadata: q.metadata || null,
                            answer_cn: q.answer_cn,
                            answer_en: q.answer_en,
                            explanation_cn: q.explanation_cn,
                            explanation_en: q.explanation_en,
                            knowledge_point_id: q.knowledge_point_id
                        });
                    }

                    const addedThisAttempt = questionsOut.length - beforeLen;
                    diagLog('[diagnostic] fill attempt done:', {
                        attempt,
                        added: addedThisAttempt,
                        now: questionsOut.length,
                        need: numQuestions,
                        enableMetadataDedupe,
                        enableSemanticDedupe: enableSemanticDedupeThisAttempt,
                        metadataThreshold,
                        semanticThreshold,
                    });

                    attempt++;
                }

                questionsOut = questionsOut.slice(0, numQuestions);

                if (questionsOut.length < numQuestions) {
                    return res.status(500).json({
                        error: 'Failed to generate enough unique questions',
                        requested: numQuestions,
                        returned: questionsOut.length,
                        hint: 'Try increasing dedupe thresholds or increase DIAGNOSTIC_FILL_ATTEMPTS.',
                    });
                }

                if (validateDiagnostic) {
                    const draft = {
                        lesson: genLesson || {
                            title: useLang === 'zh' ? '诊断测试' : 'Diagnostic Test',
                            explanation: useLang === 'zh' ? '请完成以下题目以评估学习水平。' : 'Please complete these questions to assess your level.',
                            images: []
                        },
                        questions: questionsOut
                    };
                    diagLog('[diagnostic] schema validate: draft.questions.length =', draft.questions ? draft.questions.length : 'undefined');
                    const isValid = validateDiagnostic(draft);
                    if (!isValid) {
                        console.error('Generated diagnostic failed schema validation:', validateDiagnostic.errors);
                        return res.status(500).json({ error: 'Generated diagnostic did not match required schema', details: validateDiagnostic.errors });
                    }
                }

                const lessonTitle = useLang === 'zh' ? lessonBilingual.title_cn : lessonBilingual.title_en;
                const lessonExplanation = useLang === 'zh' ? lessonBilingual.explanation_cn : lessonBilingual.explanation_en;

                return res.json({
                    generated: true,
                    lesson: {
                        title: lessonTitle,
                        explanation: lessonExplanation,
                        title_cn: lessonBilingual.title_cn,
                        title_en: lessonBilingual.title_en,
                        explanation_cn: lessonBilingual.explanation_cn,
                        explanation_en: lessonBilingual.explanation_en,
                        images: (genLesson && genLesson.images) || []
                    },
                    questions: questionsOut.map(q => ({
                        id: q.id,
                        type: q.type,
                        content_cn: q.content_cn,
                        content_en: q.content_en,
                        options_bilingual: q.options,
                        answer_cn: q.answer_cn,
                        answer_en: q.answer_en,
                        explanation_cn: q.explanation_cn,
                        explanation_en: q.explanation_en,
                        metadata: q.metadata || null,
                        content: useLang === 'zh' ? q.content_cn : q.content_en,
                        options: q.options ? (useLang === 'zh' ? q.options.zh : q.options.en) : [],
                        answer: useLang === 'zh' ? q.answer_cn : q.answer_en,
                        explanation: useLang === 'zh' ? q.explanation_cn : q.explanation_en,
                        knowledge_point_id: q.knowledge_point_id
                    }))
                });
            }

            const lesson = {
                title: `${gradeDisplayName} ${subjectDisplayName} ${useLang === 'zh' ? '诊断测试' : 'Diagnostic Test'}`.trim(),
                explanation: useLang === 'zh' ? lessonBilingual.explanation_cn : lessonBilingual.explanation_en,
                title_cn: lessonBilingual.title_cn,
                title_en: lessonBilingual.title_en,
                explanation_cn: lessonBilingual.explanation_cn,
                explanation_en: lessonBilingual.explanation_en,
                images: []
            };

            return res.json({
                generated: true,
                lesson,
                questions: questionsOut.map(q => ({
                    id: q.id,
                    type: q.type,
                    content_cn: q.content_cn,
                    content_en: q.content_en,
                    options_bilingual: q.options,
                    answer_cn: q.answer_cn,
                    answer_en: q.answer_en,
                    explanation_cn: q.explanation_cn,
                    explanation_en: q.explanation_en,
                    metadata: q.metadata || null,
                    content: useLang === 'zh' ? q.content_cn : q.content_en,
                    options: q.options ? (useLang === 'zh' ? q.options.zh : q.options.en) : [],
                    answer: useLang === 'zh' ? q.answer_cn : q.answer_en,
                    explanation: useLang === 'zh' ? q.explanation_cn : q.explanation_en,
                    knowledge_point_id: q.knowledge_point_id
                }))
            });

        } catch (e) {
            return res.status(401).json({ error: 'Invalid token' });
        }
    });
}

module.exports = { registerDiagnosticRoutes };
