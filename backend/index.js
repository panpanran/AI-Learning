// Debug log for /api/submit/diagnostic
function submitDiagnosticLog(...args) {
    if (process.env.NODE_ENV === 'test' || process.env.SUBMIT_DIAGNOSTIC_DEBUG === 'true') {
        console.log('[submit/diagnostic]', ...args);
    }
}
// Debug log for /api/submit-answer
function submitAnswerLog(...args) {
    if (process.env.NODE_ENV === 'test' || process.env.SUBMIT_ANSWER_DEBUG === 'true') {
        console.log('[submit-answer]', ...args);
    }
}
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.local') });
const DEBUG_LOG = process.env.DEBUG_LOG === '1';
const DIAGNOSTIC_DEBUG = process.env.DIAGNOSTIC_DEBUG === '1';

// Surface unexpected async failures (otherwise Node may exit with code 1 with little context).
process.on('unhandledRejection', (reason) => {
    try {
        console.error('[unhandledRejection]', reason);
    } catch { }
});

process.on('uncaughtException', (err) => {
    try {
        console.error('[uncaughtException]', err);
    } catch { }
});

function debugLog(...args) {
    if (DEBUG_LOG) console.log(...args);
}

function diagLog(...args) {
    if (DIAGNOSTIC_DEBUG) console.log(...args);
}

debugLog('Loaded DATABASE_URL =', process.env.DATABASE_URL);

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const OpenAI = require('openai');
const Ajv = require('ajv');

function stripJsonCodeFences(text) {
    const s = (text == null ? '' : String(text)).trim();
    // Remove common markdown code fences
    return s
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
}

function safeParseJsonObject(text) {
    const raw = stripJsonCodeFences(text);
    if (!raw) return null;
    // Try as-is
    try {
        return JSON.parse(raw);
    } catch { }

    // Try extracting the outermost JSON object
    const m = raw.match(/\{[\s\S]*\}/);
    if (m && m[0]) {
        try {
            return JSON.parse(m[0]);
        } catch { }
    }
    return null;
}

async function createChatCompletionJson(aiClient, params) {
    // Prefer JSON mode when supported; fall back gracefully for older/unsupported models.
    try {
        return await aiClient.chat.completions.create({
            ...params,
            temperature: 0,
            response_format: { type: 'json_object' }
        });
    } catch (e) {
        const msg = (e && e.message) ? String(e.message) : String(e);
        // Unknown parameter/model not supporting response_format
        if (msg.toLowerCase().includes('response_format') || msg.toLowerCase().includes('unknown parameter')) {
            return await aiClient.chat.completions.create({
                ...params,
                temperature: 0
            });
        }
        throw e;
    }
}

// Load diagnostic schema and prepare validator
let validateDiagnostic = null;
try {
    const diagSchema = require('./lib/schemas/diagnostic.schema');
    const ajv = new Ajv({ allErrors: true, strict: false });
    validateDiagnostic = ajv.compile(diagSchema);
} catch (e) {
    console.warn('AJV or schema not available - schema validation disabled.');
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function getOpenAI() {
    return (app && app.locals && app.locals.openai) ? app.locals.openai : openai;
}

// Pinecone client (optional)
let pineconeClient = null;
try {
    pineconeClient = require(path.join(__dirname, 'lib', 'pineconeClient.js'));
} catch (e) {
    console.warn('Pinecone client not available (optional).');
}

(async () => {
    if (pineconeClient && typeof pineconeClient.listIndexes === 'function') {
        try {
            const indexes = await pineconeClient.listIndexes();
            console.log('Pinecone indexes:', indexes);
        } catch (e) {
            console.error('Pinecone test failed:', e);
        }
    } else {
        console.warn('Pinecone client未正确初始化或不支持listIndexes方法');
    }
})();

function getPinecone() {
    return (app && app.locals && app.locals.pineconeClient) ? app.locals.pineconeClient : pineconeClient;
}

// Debug endpoint to verify Pinecone connectivity & record counts
app.get('/api/pinecone/stats', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const token = auth.replace('Bearer ', '');
    try {
        jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    const pcClient = getPinecone();
    if (!pcClient) {
        return res.json({ enabled: false, reason: 'pinecone client not initialized' });
    }
    try {
        const stats = (typeof pcClient.describeIndexStats === 'function') ? await pcClient.describeIndexStats() : null;
        return res.json({
            enabled: true,
            indexName: pcClient.indexName || process.env.PINECONE_INDEX_NAME || null,
            embedModel: pcClient.embedModel || process.env.PINECONE_EMBED_MODEL || null,
            stats
        });
    } catch (e) {
        return res.status(500).json({
            enabled: true,
            indexName: pcClient.indexName || process.env.PINECONE_INDEX_NAME || null,
            embedModel: pcClient.embedModel || process.env.PINECONE_EMBED_MODEL || null,
            error: e && e.message ? e.message : String(e)
        });
    }
});

// Debug endpoint: query Pinecone for nearest metadata vectors and return scores.
// Use this to inspect whether a given metadata/text matches existing question_metadata vectors.
app.post('/api/pinecone/query-metadata', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const token = auth.replace('Bearer ', '');
    try {
        jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    const pcClient = getPinecone();
    if (!pcClient || typeof pcClient.embedTexts !== 'function' || typeof pcClient.queryByVector !== 'function') {
        return res.status(503).json({ error: 'Pinecone not configured' });
    }

    const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
    const topKRaw = body.topK != null ? Number(body.topK) : 10;
    const topK = Number.isFinite(topKRaw) ? Math.max(1, Math.min(50, Math.floor(topKRaw))) : 10;

    // Comparison mode:
    // - default: query Pinecone index for nearest neighbors
    // - local_cosine: embed candidates from Postgres and compute cosineSimilarity locally
    const compareMode = (body.compareMode != null ? String(body.compareMode) : '').trim() || 'pinecone';

    const gradeId = body.grade_id != null ? Number(body.grade_id) : null;
    const subjectId = body.subject_id != null ? Number(body.subject_id) : null;
    const knowledgePointId = body.knowledge_point_id != null ? Number(body.knowledge_point_id) : null;

    const filter = {
        kind: { "$eq": "question_metadata" },
        ...(Number.isInteger(gradeId) ? { grade_id: { "$eq": gradeId } } : {}),
        ...(Number.isInteger(subjectId) ? { subject_id: { "$eq": subjectId } } : {}),
        ...(Number.isInteger(knowledgePointId) ? { knowledge_point_id: { "$eq": knowledgePointId } } : {}),
    };

    const stableStringify = (value) => {
        const seen = new WeakSet();
        const walk = (v) => {
            if (v === null || v === undefined) return v;
            const t = typeof v;
            if (t === 'number' || t === 'string' || t === 'boolean') return v;
            if (Array.isArray(v)) return v.map(walk);
            if (t === 'object') {
                if (seen.has(v)) return '[Circular]';
                seen.add(v);
                const out = {};
                const keys = Object.keys(v).sort();
                for (const k of keys) out[k] = walk(v[k]);
                return out;
            }
            return String(v);
        };
        try {
            return JSON.stringify(walk(value));
        } catch {
            try { return JSON.stringify(value); } catch { return String(value); }
        }
    };

    let queryText = '';
    let queryTextSource = null;
    let queryTextCanonical = '';
    let queryTextRaw = '';
    if (body.text != null && String(body.text).trim()) {
        queryText = String(body.text).trim();
        queryTextSource = 'text';
    } else if (body.metadata != null) {
        const useRaw = body.useRawMetadata === true;
        queryTextCanonical = buildMetadataEmbeddingText(body.metadata) || '';
        queryTextRaw = stableStringify(body.metadata);
        queryText = (useRaw || !queryTextCanonical) ? queryTextRaw : queryTextCanonical;
        queryTextSource = (useRaw || !queryTextCanonical) ? 'metadata_raw_json' : 'metadata_canonical';
    }

    if (!queryText) {
        return res.status(400).json({ error: 'Provide body.text or body.metadata' });
    }

    try {
        const vec = ((await pcClient.embedTexts([queryText], 'query')) || [])[0] || null;
        if (!vec || !Array.isArray(vec) || !vec.length) {
            return res.status(500).json({ error: 'Failed to embed query text' });
        }

        // Local cosine mode: fetch candidate questions from Postgres, embed their metadata texts,
        // then compute cosineSimilarity locally (same pattern as the in-file avoid-metadata ranking).
        if (compareMode === 'local_cosine') {
            if (!useDb) {
                return res.status(503).json({ error: 'Postgres not configured (useDb=false)' });
            }

            const candidateLimitRaw = body.candidateLimit != null ? Number(body.candidateLimit) : null;
            const candidateLimit = Number.isFinite(candidateLimitRaw)
                ? Math.max(10, Math.min(2000, Math.floor(candidateLimitRaw)))
                : 800;

            // Only allow DB scan when grade/subject are provided to keep it bounded.
            if (!Number.isInteger(gradeId) || !Number.isInteger(subjectId)) {
                return res.status(400).json({ error: 'grade_id and subject_id are required for compareMode=local_cosine' });
            }

            const params = [Number(gradeId), Number(subjectId)];
            let where = 'q.grade_id = $1 AND q.subject_id = $2';
            if (Number.isInteger(knowledgePointId)) {
                params.push(Number(knowledgePointId));
                where += ` AND q.knowledge_point_id = $${params.length}`;
            }
            params.push(candidateLimit);

            let rows = [];
            try {
                const r = await pool.query(
                    `SELECT id, grade_id, subject_id, knowledge_point_id, metadata, content_cn, content_en, content_options_hash, created_at
                     FROM questions q
                     WHERE ${where}
                       AND q.metadata IS NOT NULL
                     ORDER BY q.id DESC
                     LIMIT $${params.length}`,
                    params
                );
                rows = r.rows || [];
            } catch (e) {
                return res.status(500).json({ error: 'DB query failed', detail: e && e.message ? e.message : String(e) });
            }

            const cand = [];
            for (const row of rows) {
                const t = buildMetadataEmbeddingText(row.metadata);
                if (!t) continue;
                cand.push({ row, text: t });
            }

            // Batch embed to avoid payload limits.
            const batchSize = 128;
            const candVecs = [];
            try {
                for (let i = 0; i < cand.length; i += batchSize) {
                    const batch = cand.slice(i, i + batchSize).map(x => x.text);
                    const vecs = await pcClient.embedTexts(batch, 'query');
                    for (const v of (vecs || [])) candVecs.push(v);
                }
            } catch (e) {
                return res.status(500).json({ error: 'Failed to embed candidate metadata', detail: e && e.message ? e.message : String(e) });
            }

            const scored = cand.map((x, i) => {
                const v = candVecs[i];
                const s = cosineSimilarity(vec, v);
                return {
                    question_id: x && x.row && x.row.id != null ? Number(x.row.id) : null,
                    score: Number.isFinite(s) ? s : -1,
                    question: x && x.row ? x.row : null,
                };
            }).filter(x => Number.isInteger(x.question_id) && x.question);

            scored.sort((a, b) => (b.score - a.score));
            const top = scored.slice(0, Math.max(1, Math.min(50, topK)));

            return res.json({
                mode: 'local_cosine',
                topK: top.length,
                candidateLimit,
                filter,
                queryTextSource,
                queryTextPreview: queryText.length > 800 ? (queryText.slice(0, 800) + '…') : queryText,
                queryTextCanonicalPreview: queryTextCanonical
                    ? (queryTextCanonical.length > 800 ? (queryTextCanonical.slice(0, 800) + '…') : queryTextCanonical)
                    : null,
                queryTextRawPreview: queryTextRaw
                    ? (queryTextRaw.length > 800 ? (queryTextRaw.slice(0, 800) + '…') : queryTextRaw)
                    : null,
                matches: top.map(x => ({
                    id: x.question_id != null ? String(x.question_id) : null,
                    score: x.score,
                    question: x.question,
                })),
            });
        }

        const pq = await pcClient.queryByVector(vec, topK, filter);
        const matches = (pq && Array.isArray(pq.matches)) ? pq.matches : [];

        const includeQuestionRows = body.includeQuestionRows === true;
        let questionById = {};
        if (includeQuestionRows && useDb && matches.length) {
            try {
                const qids = Array.from(new Set(matches
                    .map(m => (m && m.metadata && m.metadata.question_id != null) ? Number(m.metadata.question_id) : null)
                    .filter(x => Number.isInteger(x))
                ));
                if (qids.length) {
                    const r = await pool.query(
                        `SELECT id, grade_id, subject_id, knowledge_point_id, metadata, content_cn, content_en, content_options_hash, created_at
                         FROM questions
                         WHERE id = ANY($1::int[])`,
                        [qids]
                    );
                    for (const row of (r.rows || [])) {
                        questionById[String(row.id)] = row;
                    }
                }
            } catch {
                questionById = {};
            }
        }

        return res.json({
            mode: 'pinecone',
            topK,
            filter,
            queryTextSource,
            queryTextPreview: queryText.length > 800 ? (queryText.slice(0, 800) + '…') : queryText,
            queryTextCanonicalPreview: queryTextCanonical
                ? (queryTextCanonical.length > 800 ? (queryTextCanonical.slice(0, 800) + '…') : queryTextCanonical)
                : null,
            queryTextRawPreview: queryTextRaw
                ? (queryTextRaw.length > 800 ? (queryTextRaw.slice(0, 800) + '…') : queryTextRaw)
                : null,
            matches: matches.map(m => {
                const qid = (m && m.metadata && m.metadata.question_id != null) ? Number(m.metadata.question_id) : null;
                const qrow = (includeQuestionRows && Number.isInteger(qid)) ? (questionById[String(qid)] || null) : null;
                return {
                    id: m && m.id != null ? String(m.id) : null,
                    score: (m && m.score != null) ? Number(m.score) : null,
                    metadata: (m && m.metadata && typeof m.metadata === 'object') ? m.metadata : null,
                    // The matched question row from Postgres (includes questions.metadata)
                    question: qrow,
                };
            })
        });
    } catch (e) {
        return res.status(500).json({ error: e && e.message ? e.message : String(e) });
    }
});

let prompts = null;
try {
    prompts = require('./lib/prompts');
} catch (e) {
    console.warn('Prompts module not found.');
}

// Postgres support (optional).
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING });
let useDb = false;

// Simple in-memory "DB" fallback. Must be defined before handlers that may reference it.
const users = {};

// Lazy DB init: create tables on first meaningful request (e.g. register/login)
// rather than only at process startup. This avoids one-shot failures on cold start,
// and makes schema creation happen exactly when the app is actually used.
let dbInitPromise = null;
let lastDbInitAttemptAtMs = 0;
let lastDbInitOk = null; // null | true | false

function getDbInitRetryMs() {
    const raw = process.env.DB_INIT_RETRY_MS;
    const n = raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 30000;
}

async function ensureDbInitialized() {
    if (useDb) return { ok: true, useDb: true, attempted: false };
    if (process.env.NODE_ENV === 'test') return { ok: false, useDb: false, attempted: false, reason: 'test' };

    if (dbInitPromise) {
        await dbInitPromise;
        return { ok: useDb === true, useDb, attempted: true, shared: true };
    }

    const now = Date.now();
    const retryMs = getDbInitRetryMs();
    if (lastDbInitOk === false && retryMs > 0 && (now - lastDbInitAttemptAtMs) < retryMs) {
        return { ok: false, useDb: false, attempted: false, throttled: true };
    }

    lastDbInitAttemptAtMs = now;
    dbInitPromise = (async () => {
        await ensureTables();
        lastDbInitOk = (useDb === true);
    })().finally(() => {
        dbInitPromise = null;
    });

    await dbInitPromise;
    return { ok: useDb === true, useDb, attempted: true, shared: false };
}

// 检查用户名是否已存在（注册唯一性校验）
app.post('/auth/check-username', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: '用户名不能为空' });

    // Create schema lazily on first auth-related request.
    await ensureDbInitialized();

    if (useDb) {
        try {
            const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
            return res.json({ exists: result.rows.length > 0 });
        } catch (e) {
            return res.status(500).json({ error: '数据库错误' });
        }
    } else {
        const exists = Object.values(users).some(u => u.username === username);
        return res.json({ exists });
    }
});

async function seedMetaTablesIfEmpty() {
    // Seed minimal grade/subject/grade_subjects data so frontend dropdowns can be DB-driven.
    // This is intentionally idempotent (relies on unique indexes created in ensureTables).
    const gradesCount = await pool.query('SELECT COUNT(1)::int AS c FROM grades');
    const subjectsCount = await pool.query('SELECT COUNT(1)::int AS c FROM subjects');
    const gsCount = await pool.query('SELECT COUNT(1)::int AS c FROM grade_subjects');

    const shouldSeedGrades = (gradesCount.rows[0] && gradesCount.rows[0].c === 0);
    const shouldSeedSubjects = (subjectsCount.rows[0] && subjectsCount.rows[0].c === 0);

    if (shouldSeedGrades) {
        const grades = [];
        grades.push({ code: 'KG', stage: 'KG', level: 0, sequence: 0, name_zh: '学前班', name_en: 'Kindergarten' });
        for (let i = 1; i <= 6; i++) {
            grades.push({ code: `G${i}`, stage: 'G', level: i, sequence: i, name_zh: `小学${i}年级`, name_en: `Grade ${i}` });
        }
        grades.push({ code: 'G7', stage: 'G', level: 7, sequence: 7, name_zh: '初一', name_en: 'Grade 7' });
        grades.push({ code: 'G8', stage: 'G', level: 8, sequence: 8, name_zh: '初二', name_en: 'Grade 8' });
        grades.push({ code: 'G9', stage: 'G', level: 9, sequence: 9, name_zh: '初三', name_en: 'Grade 9' });
        grades.push({ code: 'H1', stage: 'H', level: 1, sequence: 101, name_zh: '高一', name_en: 'High School 1' });
        grades.push({ code: 'H2', stage: 'H', level: 2, sequence: 102, name_zh: '高二', name_en: 'High School 2' });
        grades.push({ code: 'H3', stage: 'H', level: 3, sequence: 103, name_zh: '高三', name_en: 'High School 3' });
        for (const g of grades) {
            await pool.query(
                `INSERT INTO grades(code, level, name_zh, name_en, stage, sequence)
                 VALUES($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (code) DO NOTHING`,
                [g.code, g.level, g.name_zh, g.name_en, g.stage, g.sequence]
            );
        }
    }

    if (shouldSeedSubjects) {
        const subjects = [
            { code: 'math', name_zh: '数学', name_en: 'Math' },
            { code: 'chinese', name_zh: '语文', name_en: 'Chinese' },
            { code: 'english', name_zh: '英语', name_en: 'English' },
            { code: 'science', name_zh: '科学', name_en: 'Science' },
            { code: 'art', name_zh: '美术', name_en: 'Art' },
            { code: 'pe', name_zh: '体育', name_en: 'PE' },
            { code: 'physics', name_zh: '物理', name_en: 'Physics' },
            { code: 'chemistry', name_zh: '化学', name_en: 'Chemistry' },
            { code: 'biology', name_zh: '生物', name_en: 'Biology' },
            { code: 'history', name_zh: '历史', name_en: 'History' },
            { code: 'geography', name_zh: '地理', name_en: 'Geography' },
            { code: 'play', name_zh: '游戏', name_en: 'Play' },
            { code: 'language', name_zh: '语言', name_en: 'Language' }
        ];
        for (const s of subjects) {
            await pool.query(
                `INSERT INTO subjects(code, name_zh, name_en, is_active)
                 VALUES($1,$2,$3,TRUE)
                 ON CONFLICT (code) DO NOTHING`,
                [s.code, s.name_zh, s.name_en]
            );
        }
    }

    // Seed grade_subjects mapping if empty. This replicates the frontend's historical logic.
    if (gsCount.rows[0] && gsCount.rows[0].c === 0) {
        const gradeRows = await pool.query('SELECT id, code FROM grades');
        const subjectRows = await pool.query('SELECT id, code FROM subjects');
        const subjectByCode = new Map(subjectRows.rows.map(r => [r.code, r]));

        function subjectsForGradeCode(code) {
            if (!code) return [];
            if (code === 'KG') return ['play', 'language', 'art'];
            const num = Number(code.slice(1));
            if (code.startsWith('G')) {
                if (num >= 1 && num <= 6) return ['math', 'chinese', 'english', 'science', 'art', 'pe'];
                if (num >= 7 && num <= 9) return ['math', 'chinese', 'english', 'physics', 'chemistry', 'history', 'geography'];
                if (num >= 10 && num <= 12) return ['math', 'chinese', 'english', 'physics', 'chemistry', 'biology', 'history'];
            }
            if (code.startsWith('H')) return ['math', 'chinese', 'english', 'physics', 'chemistry', 'biology'];
            return ['math', 'chinese', 'english'];
        }

        for (const g of gradeRows.rows) {
            const subjectCodes = subjectsForGradeCode(g.code);
            for (const sc of subjectCodes) {
                const s = subjectByCode.get(sc);
                if (!s) continue;
                await pool.query(
                    `INSERT INTO grade_subjects(grade_id, subject_id, description)
                     VALUES($1,$2,NULL)
                     ON CONFLICT (grade_id, subject_id) DO NOTHING`,
                    [g.id, s.id]
                );
            }
        }
    }
}

// ...existing code...

async function resolveGradeSubject({ grade, subject, grade_id, subject_id }) {
    // Normalize to both IDs and codes, to keep backward compatibility.
    const out = { gradeId: null, subjectId: null, gradeCode: null, subjectCode: null };
    if (!useDb) {
        out.gradeCode = grade != null ? String(grade) : null;
        out.subjectCode = subject != null ? String(subject) : null;
        return out;
    }
    try {
        if (grade_id != null) {
            const r = await pool.query('SELECT id, code FROM grades WHERE id=$1', [Number(grade_id)]);
            if (r.rows[0]) { out.gradeId = r.rows[0].id; out.gradeCode = r.rows[0].code; }
        }
        if (out.gradeId == null && grade) {
            const r = await pool.query('SELECT id, code FROM grades WHERE code=$1', [String(grade)]);
            if (r.rows[0]) { out.gradeId = r.rows[0].id; out.gradeCode = r.rows[0].code; }
            else { out.gradeCode = String(grade); }
        }

        if (subject_id != null) {
            const r = await pool.query('SELECT id, code FROM subjects WHERE id=$1', [Number(subject_id)]);
            if (r.rows[0]) { out.subjectId = r.rows[0].id; out.subjectCode = r.rows[0].code; }
        }
        if (out.subjectId == null && subject) {
            const r = await pool.query('SELECT id, code FROM subjects WHERE code=$1', [String(subject)]);
            if (r.rows[0]) { out.subjectId = r.rows[0].id; out.subjectCode = r.rows[0].code; }
            else { out.subjectCode = String(subject); }
        }
    } catch (e) {
        out.gradeCode = grade != null ? String(grade) : out.gradeCode;
        out.subjectCode = subject != null ? String(subject) : out.subjectCode;
    }
    return out;
}

async function ensureTables() {
    if (process.env.NODE_ENV === 'test') {
        console.log('Skipping Postgres setup in test environment.');
        useDb = false;
        return;
    }
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_login_at TIMESTAMP
        )`);
        // If legacy schema exists (questions.id not integer), drop & recreate (no data preservation).
        try {
            const col = await pool.query(
                `SELECT data_type
                 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name='questions' AND column_name='id'`
            );
            const dataType = col.rows[0] ? String(col.rows[0].data_type) : null;
            if (dataType && dataType !== 'integer') {
                try { await pool.query('DROP TABLE IF EXISTS history'); } catch (e) { }
                try { await pool.query('DROP TABLE IF EXISTS questions'); } catch (e) { }
            }
        } catch (e) { }

        // NOTE: Create referenced tables (grades/subjects) before any FK constraints.
        // 新增 grades 表
        await pool.query(`CREATE TABLE IF NOT EXISTS grades (
            id SERIAL PRIMARY KEY,
            code VARCHAR(16),
            level INTEGER NOT NULL,
            name_zh VARCHAR(64) NOT NULL,
            name_en VARCHAR(64) NOT NULL,
            stage VARCHAR(32),
            sequence INTEGER
        )`);

        // 新增 subjects 表
        await pool.query(`CREATE TABLE IF NOT EXISTS subjects (
            id SERIAL PRIMARY KEY,
            code VARCHAR(32) NOT NULL,
            name_zh VARCHAR(64) NOT NULL,
            name_en VARCHAR(64) NOT NULL,
            icon VARCHAR(128),
            is_active BOOLEAN DEFAULT TRUE
        )`);

        // 新增 grade_subjects 中间表
        await pool.query(`CREATE TABLE IF NOT EXISTS grade_subjects (
            id SERIAL PRIMARY KEY,
            grade_id INTEGER REFERENCES grades(id) ON DELETE CASCADE,
            subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
            description TEXT
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS questions (
                id SERIAL PRIMARY KEY,
                content_cn TEXT,
                content_en TEXT,
                options JSONB,
                content_options_hash TEXT,
                metadata JSONB,
                embedding DOUBLE PRECISION[],
                answer_cn TEXT,
                answer_en TEXT,
                explanation_cn TEXT,
                explanation_en TEXT,
                knowledge_point_id INTEGER,
                grade_id INTEGER REFERENCES grades(id),
                subject_id INTEGER REFERENCES subjects(id)
            )`);
        // Remove legacy grade/subject columns if they exist
        try { await pool.query('ALTER TABLE questions DROP COLUMN IF EXISTS grade'); } catch (e) { }
        try { await pool.query('ALTER TABLE questions DROP COLUMN IF EXISTS subject'); } catch (e) { }
        // 后端所有逻辑请勿再使用 questions.grade 或 subject 字段，只用 grade_id/subject_id。

        // For existing DBs created before we added columns
        try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS grade TEXT'); } catch (e) { }
        try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS subject TEXT'); } catch (e) { }
        try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT'); } catch (e) { }
        try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS grade_id INTEGER REFERENCES grades(id)'); } catch (e) { }
        try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES subjects(id)'); } catch (e) { }

        try { await pool.query('ALTER TABLE grades ADD COLUMN IF NOT EXISTS code VARCHAR(16)'); } catch (e) { }
        try { await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS grades_code_unique ON grades(code)'); } catch (e) { }
        try { await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS subjects_code_unique ON subjects(code)'); } catch (e) { }
        try { await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS grade_subjects_unique ON grade_subjects(grade_id, subject_id)'); } catch (e) { }

        try { await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS grade_id INTEGER REFERENCES grades(id)'); } catch (e) { }
        try { await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES subjects(id)'); } catch (e) { }

        try { await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS options JSONB'); } catch (e) { }
        try { await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS content_options_hash TEXT'); } catch (e) { }
        try { await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS metadata JSONB'); } catch (e) { }
        try { await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS embedding DOUBLE PRECISION[]'); } catch (e) { }
        // Track question creation time (generation/import time). Existing rows will be backfilled.
        try { await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'); } catch (e) { }
        try { await pool.query('UPDATE questions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)'); } catch (e) { }
        try { await pool.query('ALTER TABLE questions ALTER COLUMN created_at SET NOT NULL'); } catch (e) { }
        // 已删除 questions.grade/subject 字段，相关索引不再创建。
        try { await pool.query('CREATE INDEX IF NOT EXISTS questions_grade_subject_id_idx ON questions(grade_id, subject_id)'); } catch (e) { }
        try { await pool.query('CREATE INDEX IF NOT EXISTS questions_kp_idx ON questions(knowledge_point_id)'); } catch (e) { }
        try { await pool.query('CREATE INDEX IF NOT EXISTS questions_created_at_idx ON questions(created_at)'); } catch (e) { }
        // content_options_hash is used as a stable de-dup key across generations.
        // Use UNIQUE so we can safely upsert by content_options_hash.
        try { await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS questions_content_options_hash_uniq ON questions(content_options_hash)'); } catch (e) { }
        await pool.query(`CREATE TABLE IF NOT EXISTS knowledge_points (
            id SERIAL PRIMARY KEY,
            name_cn TEXT,
            name_en TEXT,
            unit_name_cn TEXT,
            unit_name_en TEXT,
            description TEXT,
            difficulty_avg INTEGER,
            is_active BOOLEAN DEFAULT TRUE,
            sort_order INTEGER,
            grade_subject_id INTEGER REFERENCES grade_subjects(id) ON DELETE SET NULL
        )`);
        // Remove legacy grade/subject columns if they exist
        try { await pool.query('ALTER TABLE knowledge_points DROP COLUMN IF EXISTS grade'); } catch (e) { }
        try { await pool.query('ALTER TABLE knowledge_points DROP COLUMN IF EXISTS subject'); } catch (e) { }
        // 后端所有逻辑请勿再使用 knowledge_points.grade 或 subject 字段，只用 grade_subject_id。
        await pool.query(`CREATE TABLE IF NOT EXISTS student_knowledge_scores (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            knowledge_point_id INTEGER,
            correct_count INTEGER DEFAULT 0,
            wrong_count INTEGER DEFAULT 0,
            score REAL DEFAULT 0,
            last_updated BIGINT
        )`);

        // --- Knowledge points schema migration (legacy text id -> integer id; name -> name_cn/name_en) ---
        // Old versions used knowledge_points.id as TEXT and questions/student_knowledge_scores.knowledge_point_id as TEXT.
        // Those legacy string ids (e.g. "addition_basic") can't be safely cast to integers, so we recreate columns.
        try {
            const kpIdTypeRes = await pool.query(
                `SELECT data_type
                 FROM information_schema.columns
                 WHERE table_schema='public'
                   AND table_name='knowledge_points'
                   AND column_name='id'`
            );
            const kpIdType = kpIdTypeRes.rows[0] ? kpIdTypeRes.rows[0].data_type : null;
            if (kpIdType && kpIdType !== 'integer') {
                // Preserve old table briefly (debugging) but prefer a clean new one.
                try { await pool.query('DROP TABLE IF EXISTS knowledge_points_legacy_textid'); } catch (e) { }
                try { await pool.query('ALTER TABLE knowledge_points RENAME TO knowledge_points_legacy_textid'); } catch (e) { }
                await pool.query(`CREATE TABLE IF NOT EXISTS knowledge_points (
                    id SERIAL PRIMARY KEY,
                    name_cn TEXT,
                    name_en TEXT,
                    unit_name_cn TEXT,
                    unit_name_en TEXT,
                    description TEXT,
                    difficulty_avg INTEGER,
                    is_active BOOLEAN DEFAULT TRUE,
                    sort_order INTEGER,
                    grade_subject_id INTEGER REFERENCES grade_subjects(id) ON DELETE SET NULL
                )`);
            }
            // Ensure bilingual columns exist; drop legacy name column if present.
            try { await pool.query('ALTER TABLE knowledge_points ADD COLUMN IF NOT EXISTS name_cn TEXT'); } catch (e) { }
            try { await pool.query('ALTER TABLE knowledge_points ADD COLUMN IF NOT EXISTS name_en TEXT'); } catch (e) { }
            try { await pool.query('ALTER TABLE knowledge_points ADD COLUMN IF NOT EXISTS unit_name_cn TEXT'); } catch (e) { }
            try { await pool.query('ALTER TABLE knowledge_points ADD COLUMN IF NOT EXISTS unit_name_en TEXT'); } catch (e) { }
            try { await pool.query('ALTER TABLE knowledge_points ADD COLUMN IF NOT EXISTS description TEXT'); } catch (e) { }
            try { await pool.query('ALTER TABLE knowledge_points ADD COLUMN IF NOT EXISTS difficulty_avg INTEGER'); } catch (e) { }
            try { await pool.query('ALTER TABLE knowledge_points ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE'); } catch (e) { }
            try { await pool.query('ALTER TABLE knowledge_points ADD COLUMN IF NOT EXISTS sort_order INTEGER'); } catch (e) { }
            try { await pool.query('ALTER TABLE knowledge_points DROP COLUMN IF EXISTS name'); } catch (e) { }

            // Ensure dependent columns are INTEGER.
            try {
                const qKpTypeRes = await pool.query(
                    `SELECT data_type
                     FROM information_schema.columns
                     WHERE table_schema='public'
                       AND table_name='questions'
                       AND column_name='knowledge_point_id'`
                );
                const qKpType = qKpTypeRes.rows[0] ? qKpTypeRes.rows[0].data_type : null;
                if (qKpType && qKpType !== 'integer') {
                    try { await pool.query('ALTER TABLE questions DROP COLUMN IF EXISTS knowledge_point_id'); } catch (e) { }
                    try { await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS knowledge_point_id INTEGER'); } catch (e) { }
                }
            } catch (e) { }

            try {
                const sKpTypeRes = await pool.query(
                    `SELECT data_type
                     FROM information_schema.columns
                     WHERE table_schema='public'
                       AND table_name='student_knowledge_scores'
                       AND column_name='knowledge_point_id'`
                );
                const sKpType = sKpTypeRes.rows[0] ? sKpTypeRes.rows[0].data_type : null;
                if (sKpType && sKpType !== 'integer') {
                    try { await pool.query('ALTER TABLE student_knowledge_scores DROP COLUMN IF EXISTS knowledge_point_id'); } catch (e) { }
                    try { await pool.query('ALTER TABLE student_knowledge_scores ADD COLUMN IF NOT EXISTS knowledge_point_id INTEGER'); } catch (e) { }
                }
            } catch (e) { }

            try { await pool.query('CREATE INDEX IF NOT EXISTS student_knowledge_scores_user_kp_idx ON student_knowledge_scores(user_id, knowledge_point_id)'); } catch (e) { }
            try { await pool.query('CREATE INDEX IF NOT EXISTS questions_kp_idx ON questions(knowledge_point_id)'); } catch (e) { }
            try { await pool.query('CREATE INDEX IF NOT EXISTS knowledge_points_gs_active_order_idx ON knowledge_points(grade_subject_id, is_active, sort_order, id)'); } catch (e) { }
        } catch (e) {
            console.warn('knowledge_points schema migration skipped (non-fatal).', e.message || e);
        }
        // Ensure history.question_id matches questions.id type (INTEGER). If legacy TEXT exists, drop & recreate.
        try {
            const hcol = await pool.query(
                `SELECT data_type
                 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name='history' AND column_name='question_id'`
            );
            const hType = hcol.rows[0] ? String(hcol.rows[0].data_type) : null;
            if (hType && hType !== 'integer') {
                try { await pool.query('DROP TABLE IF EXISTS history'); } catch (e) { }
            }
        } catch (e) { }

        await pool.query(`CREATE TABLE IF NOT EXISTS history (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
            given_answer TEXT,
            correct BOOLEAN,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )`);

        // IMPORTANT: created_at should include timezone info. Historically we used TIMESTAMP (no tz)
        // but inserted UTC ISO strings, which causes clients to display “UTC-looking” local times.
        // If existing rows are UTC values stored without tz, migrate by interpreting them as UTC.
        try {
            const c = await pool.query(
                `SELECT data_type
                 FROM information_schema.columns
                 WHERE table_schema='public'
                   AND table_name='history'
                   AND column_name='created_at'`
            );
            const t = c.rows[0] ? String(c.rows[0].data_type) : null;
            if (t === 'timestamp without time zone') {
                await pool.query(`ALTER TABLE history ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC'`);
                await pool.query(`ALTER TABLE history ALTER COLUMN created_at SET DEFAULT NOW()`);
            }
        } catch (e) {
            console.warn('history.created_at tz migration skipped (non-fatal).', e && e.message ? e.message : e);
        }

        // Used by /api/submit/diagnostic; create it so DB mode won't error


        // Seed meta tables and backfill ID columns (best-effort)
        try {
            await seedMetaTablesIfEmpty();
        } catch (e) {
            console.warn('Meta seed failed (non-fatal).', e.message || e);
        }

        try {
            // Backfill users.grade_id/subject_id from legacy grade/subject string columns
            await pool.query(
                `UPDATE users u
                 SET grade_id = COALESCE(u.grade_id, g.id),
                     subject_id = COALESCE(u.subject_id, s.id)
                 FROM grades g, subjects s
                 WHERE u.grade IS NOT NULL AND u.subject IS NOT NULL
                   AND g.code = u.grade
                   AND s.code = u.subject
                   AND (u.grade_id IS NULL OR u.subject_id IS NULL)`
            );
        } catch (e) { }

        useDb = true;
        console.log('Postgres tables ensured, using database for persistence.');
    } catch (e) {
        console.warn('Postgres not available or failed to initialize, falling back to in-memory stores.', e.message || e);
        useDb = false;
    }
}

// Meta endpoints for DB-driven cascading dropdowns
app.get('/api/meta/grades', async (req, res) => {
    await ensureDbInitialized();
    if (!useDb) return res.json({ grades: [], dbDisabled: true });
    try {
        const r = await pool.query('SELECT id, code, level, name_zh, name_en, stage, sequence FROM grades ORDER BY sequence NULLS LAST, id ASC');
        return res.json({ grades: r.rows });
    } catch (e) {
        return res.status(500).json({ error: 'DB error' });
    }
});

app.get('/api/meta/subjects', async (req, res) => {
    await ensureDbInitialized();
    if (!useDb) return res.json({ subjects: [], dbDisabled: true });
    try {
        const r = await pool.query('SELECT id, code, name_zh, name_en, icon, is_active FROM subjects WHERE is_active = TRUE ORDER BY code ASC');
        return res.json({ subjects: r.rows });
    } catch (e) {
        return res.status(500).json({ error: 'DB error' });
    }
});

app.get('/api/meta/grade-subjects', async (req, res) => {
    await ensureDbInitialized();
    if (!useDb) return res.json({ items: [], dbDisabled: true });
    const gradeId = req.query && req.query.grade_id != null ? Number(req.query.grade_id) : null;
    if (!gradeId) return res.status(400).json({ error: 'grade_id required' });
    try {
        const r = await pool.query(
            `SELECT gs.id AS grade_subject_id,
                    gs.grade_id,
                    gs.subject_id,
                    s.code AS subject_code,
                    s.name_zh,
                    s.name_en,
                    s.icon
             FROM grade_subjects gs
             JOIN subjects s ON s.id = gs.subject_id
             WHERE gs.grade_id = $1
             ORDER BY s.code ASC`,
            [gradeId]
        );
        return res.json({ items: r.rows });
    } catch (e) {
        return res.status(500).json({ error: 'DB error' });
    }
});

// Debug endpoint to verify which DB this server is actually connected to.
// Requires JWT auth by default. You can make it public in controlled environments by setting DEBUG_DB_INFO_PUBLIC=1.
app.get('/api/_debug/db-info', async (req, res) => {
    const isPublic = String(process.env.DEBUG_DB_INFO_PUBLIC || '') === '1';
    if (!isPublic) {
        const auth = req.headers.authorization;
        if (!auth) return res.status(401).json({ error: 'Unauthorized' });
        const token = auth.replace('Bearer ', '');
        try {
            jwt.verify(token, JWT_SECRET);
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
    }

    const init = await ensureDbInitialized();
    const out = {
        useDb,
        init,
        db: null,
        publicTables: [],
        counts: {},
    };

    if (!useDb) {
        return res.json(out);
    }

    try {
        const ident = await pool.query(
            `SELECT
                current_database() AS db,
                current_user AS user,
                inet_server_addr()::text AS server_addr,
                inet_server_port() AS server_port,
                inet_client_addr()::text AS client_addr`
        );
        out.db = ident.rows && ident.rows[0] ? ident.rows[0] : null;
    } catch (e) {
        out.db = { error: e && e.message ? e.message : String(e) };
    }

    try {
        const tablesRes = await pool.query(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema='public' AND table_type='BASE TABLE'
             ORDER BY table_name ASC`
        );
        out.publicTables = (tablesRes.rows || []).map(r => r.table_name);
    } catch (e) {
        out.publicTables = [];
    }

    const safeCount = async (tableName) => {
        try {
            const r = await pool.query(`SELECT COUNT(1)::int AS c FROM ${tableName}`);
            return (r.rows && r.rows[0]) ? r.rows[0].c : null;
        } catch {
            return null;
        }
    };

    out.counts = {
        users: await safeCount('users'),
        grades: await safeCount('grades'),
        subjects: await safeCount('subjects'),
        grade_subjects: await safeCount('grade_subjects'),
        questions: await safeCount('questions'),
        history: await safeCount('history'),
    };

    return res.json(out);
});

function normalizeOptions(options) {
    if (!Array.isArray(options)) return null;
    return options.map(x => (x ?? '').toString().trim());
}

function extractBilingualOptions(options) {
    if (!options) return null;
    // Preferred storage format: { zh: string[], en: string[] }
    if (typeof options === 'object' && !Array.isArray(options)) {
        const zh = normalizeOptions(options.zh);
        const en = normalizeOptions(options.en);
        if (zh && en) return { zh, en };
        // DB may store only one language (e.g. { en: [...] })
        if (en && !zh) return { zh: en, en };
        if (zh && !en) return { zh, en: zh };

        // LLM format: { A:{zh,en}, B:{zh,en}, C:{zh,en}, D:{zh,en} }
        const keys = ['A', 'B', 'C', 'D'];
        const zh2 = [];
        const en2 = [];
        let ok = true;
        for (const k of keys) {
            const v = options[k];
            if (!v || typeof v !== 'object') { ok = false; break; }
            const z = (v.zh ?? '').toString().trim();
            const e = (v.en ?? '').toString().trim();
            if (!z || !e) { ok = false; break; }
            zh2.push(z);
            en2.push(e);
        }
        if (ok) return { zh: zh2, en: en2 };
    }

    // Legacy: just an array (treat as English-only)
    const arr = normalizeOptions(options);
    if (arr) return { zh: arr, en: arr };
    return null;
}

function applyTemplateAll(tpl, vars) {
    let out = String(tpl ?? '');
    for (const [k, v] of Object.entries(vars || {})) {
        out = out.split(`{{${k}}}`).join(String(v));
    }
    return out;
}

function readFiniteNumberEnv(varName) {
    const raw = process.env[varName];
    if (raw == null) return NaN;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
}

// Unified similarity threshold.
// If PINECONE_DEDUPE_THRESHOLD is set, it becomes the default threshold used across
// avoid/semantic/metadata/Pinecone question-dedupe, unless a specific env var overrides it.
function getSimilarityThreshold(specificEnvVarName, defaultValue) {
    const specific = readFiniteNumberEnv(specificEnvVarName);
    if (Number.isFinite(specific)) return specific;
    const common = readFiniteNumberEnv('PINECONE_DEDUPE_THRESHOLD');
    if (Number.isFinite(common)) return common;
    return defaultValue;
}

function computeQuestionContentOptionsHash(content_en, options) {
    const p = (content_en ?? '').toString().trim();
    const o = normalizeOptions(options) || [];
    const payload = JSON.stringify({ content_en: p, options: o });
    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function uniqueByContentOptionsHash(questions) {
    const seen = new Set();
    const out = [];
    for (const q of questions || []) {
        const h = (q && q.content_options_hash)
            ? String(q.content_options_hash)
            : computeQuestionContentOptionsHash(
                q && q.content_en,
                (q && q.options && Array.isArray(q.options))
                    ? q.options
                    : (q && q.options && q.options.en)
            );
        if (seen.has(h)) continue;
        seen.add(h);
        out.push(q);
    }
    return out;
}

function ensureContentOptionsHash(question) {
    if (!question || typeof question !== 'object') return question;
    if (question.content_options_hash) return question;
    try {
        const opt = question.options_bilingual || question.optionsBilingual || question.options;
        const bilingual = extractBilingualOptions(opt);
        const optionsEn = bilingual ? bilingual.en : (Array.isArray(opt) ? opt : (opt && Array.isArray(opt.en) ? opt.en : []));
        question.content_options_hash = computeQuestionContentOptionsHash(question.content_en, optionsEn);
    } catch {
        // best-effort
    }
    return question;
}

function getPineconeQuestionDedupeConfig() {
    const enabledRaw = (process.env.PINECONE_QUESTION_DEDUPE || '').toString().trim();
    const enabled = enabledRaw === '' ? true : (enabledRaw !== '0');
    const threshold = getSimilarityThreshold('PINECONE_QUESTION_DEDUPE_THRESHOLD', 0.9);
    const topKRaw = process.env.PINECONE_QUESTION_DEDUPE_TOPK;
    const k = topKRaw != null ? Number(topKRaw) : NaN;
    const topK = Number.isFinite(k) ? Math.max(1, Math.min(10, Math.floor(k))) : 3;
    return { enabled, threshold, topK };
}

function coerceEmbeddingArray(v) {
    if (Array.isArray(v) && v.length) return v;
    // Best-effort: handle cases where PG returns a JSON string.
    if (typeof v === 'string' && v.trim().startsWith('[')) {
        try {
            const parsed = JSON.parse(v);
            if (Array.isArray(parsed) && parsed.length) return parsed;
        } catch { }
    }
    return null;
}

async function dedupeQuestionsByHistoryMetadataSemantic({ questions, pcClient, userIds, gradeId, subjectId }) {
    const list = Array.isArray(questions) ? questions : [];
    if (!list.length) return [];
    if (!useDb) return list;
    const cfg = getPineconeQuestionDedupeConfig();
    if (!cfg.enabled) return list;
    if (!pcClient || typeof pcClient.queryByVector !== 'function') return list;
    if (!Number.isInteger(Number(gradeId)) || !Number.isInteger(Number(subjectId))) return list;

    const ids = Array.isArray(userIds) ? userIds.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return list;

    // Pinecone stores ONLY global question metadata vectors (no user_id).
    const filter = {
        kind: { "$eq": "question_metadata" },
        grade_id: { "$eq": Number(gradeId) },
        subject_id: { "$eq": Number(subjectId) },
    };

    // 1) Load embeddings for questions this student has already seen.
    let historyRows = [];
    try {
        const r = await pool.query(
            `SELECT DISTINCT q.id, q.embedding, q.metadata
             FROM history h
             JOIN questions q ON q.id = h.question_id
             WHERE h.user_id = ANY($1::int[])
               AND q.grade_id = $2
               AND q.subject_id = $3
               AND q.metadata IS NOT NULL
             ORDER BY q.id DESC
             LIMIT 200`,
            [ids, Number(gradeId), Number(subjectId)]
        );
        historyRows = r.rows || [];
    } catch {
        historyRows = [];
    }

    const histEmbeddings = [];
    const embedTexts = [];
    const embedIndexes = [];
    for (const row of historyRows) {
        const emb = coerceEmbeddingArray(row.embedding);
        if (emb) {
            histEmbeddings.push(emb);
            continue;
        }
        const metaText = buildMetadataEmbeddingText(row.metadata);
        if (metaText) {
            embedIndexes.push(histEmbeddings.length);
            embedTexts.push(metaText);
            histEmbeddings.push(null);
        }
    }

    if (embedTexts.length) {
        try {
            const vecs = (pcClient && typeof pcClient.embedTexts === 'function')
                ? await pcClient.embedTexts(embedTexts, 'query')
                : await embedTextsOpenAI(embedTexts);
            if (Array.isArray(vecs) && vecs.length === embedTexts.length) {
                for (let i = 0; i < embedIndexes.length; i++) {
                    histEmbeddings[embedIndexes[i]] = vecs[i];
                }
            }
        } catch {
            // fail-open
        }
    }

    const usableHistEmbeddings = histEmbeddings.filter(v => Array.isArray(v) && v.length);
    if (!usableHistEmbeddings.length) return list;

    // 2) Build an avoid set by querying Pinecone with each history embedding.
    const avoidQuestionIds = new Set();
    for (const hv of usableHistEmbeddings) {
        try {
            const pq = await pcClient.queryByVector(hv, cfg.topK, filter);
            const matches = (pq && pq.matches) ? pq.matches : [];
            for (const m of matches) {
                const qid = (m && m.metadata && m.metadata.question_id != null) ? Number(m.metadata.question_id) : null;
                const score = (m && m.score != null) ? Number(m.score) : NaN;
                if (Number.isInteger(qid) && Number.isFinite(score) && score >= cfg.threshold) {
                    avoidQuestionIds.add(qid);
                }
            }
        } catch {
            // fail-open
        }
    }
    if (!avoidQuestionIds.size) return list;

    // 3) For each candidate, query Pinecone; skip if its nearest neighbors overlap avoid set.
    const out = [];
    for (const q of list) {
        const v = q ? coerceEmbeddingArray(q.embedding) : null;
        if (!v) {
            out.push(q);
            continue;
        }
        try {
            const pq = await pcClient.queryByVector(v, cfg.topK, filter);
            const matches = (pq && pq.matches) ? pq.matches : [];
            let shouldSkip = false;
            for (const m of matches) {
                const qid = (m && m.metadata && m.metadata.question_id != null) ? Number(m.metadata.question_id) : null;
                const score = (m && m.score != null) ? Number(m.score) : NaN;
                if (Number.isInteger(qid) && avoidQuestionIds.has(qid) && Number.isFinite(score) && score >= cfg.threshold) {
                    shouldSkip = true;
                    break;
                }
            }
            if (shouldSkip) continue;
        } catch {
            // fail-open
        }
        out.push(q);
    }

    return out;
}

async function dedupeQuestionsBeforeInsert({ questions, pcClient, userIds, gradeId, subjectId }) {
    const cfg = getPineconeQuestionDedupeConfig();

    // Layer 1: local stable hash dedupe
    const withHash = (Array.isArray(questions) ? questions : []).map(q => ensureContentOptionsHash(q));
    const layer1 = uniqueByContentOptionsHash(withHash);

    // Layer 2: ensure metadata embeddings are present in q.embedding (GLOBAL: no user info)
    const embedInputs = [];
    const embedTargets = [];
    for (const q of layer1) {
        if (!q || !q.metadata) continue;
        const v = coerceEmbeddingArray(q.embedding);
        if (v) continue;
        const t = buildMetadataEmbeddingText(q.metadata);
        if (!t) continue;
        embedInputs.push(t);
        embedTargets.push(q);
    }
    if (embedInputs.length) {
        try {
            const vecs = (pcClient && typeof pcClient.embedTexts === 'function')
                ? await pcClient.embedTexts(embedInputs, 'passage')
                : await embedTextsOpenAI(embedInputs);
            if (Array.isArray(vecs) && vecs.length === embedInputs.length) {
                for (let i = 0; i < embedTargets.length; i++) {
                    embedTargets[i].embedding = vecs[i];
                }
            }
        } catch {
            // fail-open
        }
    }

    // Layer 3: 新生成的题里语义重复过滤
    const kept = [];
    for (const q of layer1) {
        const v = q ? coerceEmbeddingArray(q.embedding) : null;
        if (!v) {
            kept.push(q);
            continue;
        }
        let tooClose = false;
        for (const k of kept) {
            const kv = k ? coerceEmbeddingArray(k.embedding) : null;
            if (!kv) continue;
            const s = cosineSimilarity(v, kv);
            if (Number.isFinite(s) && s >= cfg.threshold) {
                tooClose = true;
                break;
            }
        }
        if (!tooClose) kept.push(q);
    }

    // Layer 4: per-student semantic filtering via history->metadata and Pinecone question_metadata.
    const layer4 = await dedupeQuestionsByHistoryMetadataSemantic({
        questions: kept,
        pcClient,
        userIds,
        gradeId,
        subjectId,
    });

    return layer4;
}

function normalizeForEmbedding(text) {
    // Keep it simple and stable. We want paraphrases to be close, so don't over-normalize.
    return (text ?? '')
        .toString()
        .replace(/\s+/g, ' ')
        .trim();
}

function buildQuestionEmbeddingText(question) {
    // Include options so trivial rewording doesn't bypass dedupe.
    const contentEn = normalizeForEmbedding(question && (question.content_en ?? question.contentEn ?? question.content) || '');
    const opt = question && (question.options_bilingual || question.optionsBilingual || question.options);
    const bilingual = extractBilingualOptions(opt) || null;
    const optsEn = bilingual ? (normalizeOptions(bilingual.en) || []) : (Array.isArray(opt) ? normalizeOptions(opt) || [] : []);
    const optsJoined = optsEn.length ? optsEn.join(' | ') : '';
    return normalizeForEmbedding([contentEn, optsJoined].filter(Boolean).join(' || '));
}

function buildQuestionDedupeEmbeddingText(question, ctx = null) {
    // Prefer compact metadata representation for dedupe. Avoid embedding raw content/options unless necessary.
    // ctx may include: userId, gradeId, subjectId, knowledgePointId
    const q = question && typeof question === 'object' ? question : {};
    const metaText = (q && q.metadata) ? buildMetadataEmbeddingText(q.metadata) : '';
    const parts = [];
    const u = ctx && ctx.userId != null ? Number(ctx.userId) : null;
    const g = ctx && ctx.gradeId != null ? Number(ctx.gradeId) : null;
    const s = ctx && ctx.subjectId != null ? Number(ctx.subjectId) : null;
    const kp = (ctx && ctx.knowledgePointId != null) ? Number(ctx.knowledgePointId)
        : (q.knowledge_point_id != null ? Number(q.knowledge_point_id) : null);

    if (Number.isInteger(u)) parts.push(`user=${u}`);
    if (Number.isInteger(g)) parts.push(`grade_id=${g}`);
    if (Number.isInteger(s)) parts.push(`subject_id=${s}`);
    if (Number.isInteger(kp)) parts.push(`knowledge_point_id=${kp}`);
    if (metaText) parts.push(metaText);

    // Fallback: only if metadata missing, use content/options representation.
    if (!parts.length || (parts.length <= 4 && !metaText)) {
        const fallback = buildQuestionEmbeddingText(q);
        if (fallback) parts.push(fallback);
    }
    return normalizeForEmbedding(parts.filter(Boolean).join(' | '));
}

function normalizeMetadataValue(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'boolean') return v;
    return v;
}

function normalizeQuestionMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;

    // Preferred compact math metadata shape:
    // { type: string, nums: number[], context: string|null }
    try {
        const t = (metadata.type != null) ? String(metadata.type).trim() : '';
        const numsRaw = metadata.nums;
        const nums = Array.isArray(numsRaw) ? numsRaw.map(x => Number(x)).filter(x => Number.isFinite(x)) : [];
        const ctx = (metadata.context == null) ? null : String(metadata.context).trim();
        if (t && nums.length) {
            return { type: t, nums, context: (ctx === '' ? null : ctx) };
        }
    } catch {
        // fall through
    }

    const out = {};
    for (const [k, v] of Object.entries(metadata)) {
        if (!k) continue;
        out[String(k)] = normalizeMetadataValue(v);
    }
    return Object.keys(out).length ? out : null;
}

function buildMetadataEmbeddingText(metadata) {
    const m = normalizeQuestionMetadata(metadata);
    if (!m) return '';

    // Compact math metadata embedding
    if (m && typeof m === 'object' && !Array.isArray(m) && m.type && Array.isArray(m.nums)) {
        const t = String(m.type).trim();
        const nums = m.nums.map(x => (x == null ? '' : String(x))).filter(Boolean).join(',');
        const ctx = (m.context == null) ? '' : String(m.context).trim();
        return normalizeForEmbedding([
            t ? `type=${t}` : '',
            nums ? `nums=${nums}` : '',
            ctx ? `context=${ctx}` : ''
        ].filter(Boolean).join(' | '));
    }

    const domain = (m.domain ?? '').toString().trim();
    const skill = (m.skill ?? '').toString().trim();
    const storyType = (m.story_type ?? '').toString().trim();
    const units = (m.units ?? '').toString().trim();
    const expression = (m.expression ?? '').toString().trim();

    const operands = Array.isArray(m.operands)
        ? m.operands.map(x => (x == null ? '' : String(x))).filter(Boolean).join(',')
        : (m.operands != null ? String(m.operands) : '');
    const result = (m.result != null && m.result !== '') ? String(m.result) : '';

    // Keep the text compact but specific; numbers must remain present.
    return normalizeForEmbedding([
        domain ? `domain=${domain}` : '',
        skill ? `skill=${skill}` : '',
        storyType ? `story_type=${storyType}` : '',
        units ? `units=${units}` : '',
        expression ? `expression=${expression}` : '',
        operands ? `operands=${operands}` : '',
        result ? `result=${result}` : ''
    ].filter(Boolean).join(' | '));
}

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length || a.length !== b.length) return -1;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const av = Number(a[i]);
        const bv = Number(b[i]);
        if (!Number.isFinite(av) || !Number.isFinite(bv)) return -1;
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
    }
    if (na <= 0 || nb <= 0) return -1;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function computeScorePercent(correct, total) {
    const c = correct != null ? Number(correct) : 0;
    const t = total != null ? Number(total) : 0;
    const score = t > 0 ? (c / t) * 100 : 0;
    return {
        score,
        score_percent: Math.round(score),
        correct: c,
        total: t,
    };
}

async function getKnowledgePointScoresFromHistory({ userIds, gradeId, subjectId, knowledgePointIds = null }) {
    if (!useDb) return [];
    const ids = Array.isArray(userIds) ? userIds.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return [];
    if (!Number.isInteger(gradeId) || !Number.isInteger(subjectId)) return [];

    const kpIds = Array.isArray(knowledgePointIds)
        ? knowledgePointIds.map(Number).filter(Number.isInteger)
        : [];

    const params = [ids, gradeId, subjectId];
    let kpWhere = '';
    if (kpIds.length) {
        params.push(kpIds);
        kpWhere = ` AND q.knowledge_point_id = ANY($${params.length}::int[])`;
    }

    const r = await pool.query(
        `SELECT
            q.knowledge_point_id,
            COUNT(*)::int AS total,
            SUM(CASE WHEN h.correct THEN 1 ELSE 0 END)::int AS correct
         FROM history h
         JOIN questions q ON q.id = h.question_id
         WHERE h.user_id = ANY($1::int[])
           AND q.grade_id = $2
           AND q.subject_id = $3
           AND q.knowledge_point_id IS NOT NULL
           ${kpWhere}
         GROUP BY q.knowledge_point_id`,
        params
    );

    return (r.rows || []).map(row => {
        const kpId = row.knowledge_point_id != null ? Number(row.knowledge_point_id) : null;
        const { total, correct, score, score_percent } = computeScorePercent(row.correct, row.total);
        return {
            knowledge_point_id: Number.isInteger(kpId) ? kpId : null,
            total,
            correct,
            score,
            score_percent,
        };
    }).filter(x => Number.isInteger(x.knowledge_point_id));
}

async function embedTextsOpenAI(texts) {
    const aiClient = getOpenAI();
    if (!aiClient) return null;
    const list = (Array.isArray(texts) ? texts : []).map(t => normalizeForEmbedding(t)).filter(Boolean);
    if (!list.length) return [];
    const model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    const resp = await aiClient.embeddings.create({ model, input: list });
    const data = (resp && resp.data) ? resp.data : [];
    return data.map(d => d.embedding);
}

async function dbFirstSelectAndMaybeGenerateWithGpt({
    numQuestions,
    studentUserIds,
    gradeId,
    subjectId,
    knowledgePointId = null,
    preferredKnowledgePointIds = null,
    avoidMetadataKnowledgePointId = null,
    promptCtx,
    logFn = null,
}) {
    const log = typeof logFn === 'function' ? logFn : (() => { });
    const logImportant = (...args) => {
        try { console.log(...args); } catch { }
        try { if (typeof logFn === 'function') logFn(...args); } catch { }
    };
    const n = Math.max(1, Math.min(20, Number(numQuestions) || 1));

    const ctx = promptCtx && typeof promptCtx === 'object' ? promptCtx : null;
    const useLang = ctx && ctx.useLang != null ? ctx.useLang : null;
    const student_profile = ctx ? ctx.student_profile : null;
    const knowledgePointsForPrompt = ctx ? ctx.knowledgePointsForPrompt : null;
    const allowedKnowledgePointIds = ctx ? ctx.allowedKnowledgePointIds : null;
    const buildKnowledgePointIdsPlan = ctx ? ctx.buildKnowledgePointIdsPlan : null;
    const max_tokens = ctx && ctx.max_tokens != null ? Number(ctx.max_tokens) : 5000;

    if (!Array.isArray(studentUserIds) || !studentUserIds.length) {
        return { error: { status: 400, body: { error: 'studentUserIds required' } } };
    }
    if (!Number.isInteger(Number(gradeId)) || !Number.isInteger(Number(subjectId))) {
        return { error: { status: 400, body: { error: 'gradeId and subjectId are required (integer)' } } };
    }
    if (!Array.isArray(knowledgePointsForPrompt) || !knowledgePointsForPrompt.length) {
        return { error: { status: 400, body: { error: 'knowledgePointsForPrompt required' } } };
    }
    if (typeof buildKnowledgePointIdsPlan !== 'function') {
        return { error: { status: 400, body: { error: 'buildKnowledgePointIdsPlan required' } } };
    }
    if (useLang !== 'zh' && useLang !== 'en') {
        return { error: { status: 400, body: { error: 'promptCtx.useLang must be "zh" or "en"' } } };
    }
    if (!student_profile || typeof student_profile !== 'object') {
        return { error: { status: 400, body: { error: 'promptCtx.student_profile required' } } };
    }

    const kpFilterId = (knowledgePointId != null ? Number(knowledgePointId) : null);
    const avoidKpId = (avoidMetadataKnowledgePointId != null ? Number(avoidMetadataKnowledgePointId) : null);
    const allowedSet = (allowedKnowledgePointIds instanceof Set) ? allowedKnowledgePointIds : new Set();

    const mapQuestionRow = (row) => {
        let parsedOptions = null;
        try {
            parsedOptions = typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
        } catch {
            parsedOptions = null;
        }
        const bilingualOptions = extractBilingualOptions(parsedOptions) || { zh: [], en: [] };
        const contentCn = row.content_cn != null ? String(row.content_cn) : '';
        const contentEn = row.content_en != null ? String(row.content_en) : '';
        const contentOptionsHash = row.content_options_hash
            ? String(row.content_options_hash)
            : computeQuestionContentOptionsHash(contentEn, bilingualOptions.en);

        let kpId = kpFilterId != null ? kpFilterId : (row.knowledge_point_id != null ? Number(row.knowledge_point_id) : null);
        if (!Number.isInteger(kpId) || (allowedSet.size && !allowedSet.has(kpId))) {
            kpId = knowledgePointsForPrompt[0] ? Number(knowledgePointsForPrompt[0].id) : null;
        }

        return {
            id: row.id != null ? Number(row.id) : null,
            type: 'mcq',
            content_cn: contentCn,
            content_en: contentEn,
            options: bilingualOptions,
            content_options_hash: contentOptionsHash,
            answer_cn: row.answer_cn != null ? String(row.answer_cn) : '',
            answer_en: row.answer_en != null ? String(row.answer_en) : '',
            explanation_cn: row.explanation_cn != null ? String(row.explanation_cn) : '',
            explanation_en: row.explanation_en != null ? String(row.explanation_en) : '',
            knowledge_point_id: kpId,
        };
    };

    const fetchUnusedQuestions = async ({ kpId, limit }) => {
        const lim = Math.max(0, Number(limit) || 0);
        if (!lim) return [];
        const params = [studentUserIds, Number(gradeId), Number(subjectId)];
        let sql =
            `SELECT id, content_cn, content_en, options, content_options_hash, answer_cn, answer_en, explanation_cn, explanation_en, knowledge_point_id
             FROM questions q
             WHERE 1=1
               AND q.grade_id = $2
               AND q.subject_id = $3
               AND NOT EXISTS (
                   SELECT 1 FROM history h
                   WHERE h.user_id = ANY($1::int[])
                     AND (h.question_id = q.id)
               )`;
        if (Number.isInteger(kpId)) {
            params.push(Number(kpId));
            sql += ` AND q.knowledge_point_id = $${params.length}`;
        }
        params.push(lim);
        sql += ` ORDER BY RANDOM() LIMIT $${params.length}`;

        const r = await pool.query(sql, params);
        return (r.rows || []).map(mapQuestionRow);
    };

    // 1) fetch unused questions from DB
    const selected = [];
    try {
        // Over-fetch to avoid false GPT fallback when DB has enough rows but
        // many share the same content_options_hash (or hash is null/unstable).
        const overfetch = Math.min(250, Math.max(n * 5, n + 5));

        if (Number.isInteger(kpFilterId)) {
            selected.push(...await fetchUnusedQuestions({ kpId: kpFilterId, limit: overfetch }));
        } else if (Array.isArray(preferredKnowledgePointIds) && preferredKnowledgePointIds.length) {
            // Try to get at least one per preferred KP, but allow a few attempts per KP.
            for (const kp of preferredKnowledgePointIds) {
                if (selected.length >= overfetch) break;
                selected.push(...await fetchUnusedQuestions({ kpId: Number(kp), limit: 3 }));
            }
        } else {
            selected.push(...await fetchUnusedQuestions({ kpId: null, limit: overfetch }));
        }

        // If still not enough unique questions, retry a couple times (random ORDER BY).
        // This avoids entering GPT when the DB has enough but random sample collided.
        let questionsOutTry = uniqueByContentOptionsHash(selected).slice(0, n);
        let tries = 0;
        while (questionsOutTry.length < n && tries < 2) {
            tries++;
            if (Number.isInteger(kpFilterId)) {
                selected.push(...await fetchUnusedQuestions({ kpId: kpFilterId, limit: overfetch }));
            } else if (Array.isArray(preferredKnowledgePointIds) && preferredKnowledgePointIds.length) {
                for (const kp of preferredKnowledgePointIds) {
                    if (selected.length >= overfetch * (tries + 1)) break;
                    selected.push(...await fetchUnusedQuestions({ kpId: Number(kp), limit: 2 }));
                }
            } else {
                selected.push(...await fetchUnusedQuestions({ kpId: null, limit: overfetch }));
            }
            questionsOutTry = uniqueByContentOptionsHash(selected).slice(0, n);
        }
    } catch (e) {
        logImportant('[dbFirstSelectAndMaybeGenerateWithGpt] fetchUnusedQuestions failed:', e && e.message ? e.message : e);
    }

    let questionsOut = uniqueByContentOptionsHash(selected).slice(0, n);
    if (questionsOut.length >= n) {
        return { questionsOut, generatedQuestions: [], generatedLesson: null };
    }

    try {
        const nullHashCount = selected.filter(q => !(q && q.content_options_hash)).length;
        logImportant('[dbFirstSelectAndMaybeGenerateWithGpt] DB-first not enough unique; selected=', selected.length,
            'unique=', questionsOut.length, 'need=', n, 'null_hash=', nullHashCount,
            'kpFilterId=', kpFilterId, 'preferredKps=', Array.isArray(preferredKnowledgePointIds) ? preferredKnowledgePointIds.length : 0);
    } catch { }

    // 2) If still not enough, ask GPT for (missing + 5)
    const missing = n - questionsOut.length;
    let askN = missing + 5;

    // Find top-5 most frequent metadata patterns in this student's history (optionally scoped to a KP).
    let avoidMetadataObjects = [];
    try {
        const params = [studentUserIds, Number(gradeId), Number(subjectId)];
        let where =
            `h.user_id = ANY($1::int[])
             AND q.grade_id = $2
             AND q.subject_id = $3
             AND q.metadata IS NOT NULL`;
        if (Number.isInteger(avoidKpId)) {
            params.push(Number(avoidKpId));
            where += ` AND q.knowledge_point_id = $${params.length}`;
        }

        const r = await pool.query(
            `SELECT q.metadata, COUNT(*)::int AS cnt
             FROM history h
             JOIN questions q ON q.id = h.question_id
             WHERE ${where}
             GROUP BY q.metadata
             ORDER BY cnt DESC
             LIMIT 5`,
            params
        );
        avoidMetadataObjects = (r.rows || [])
            .map(row => normalizeQuestionMetadata(row.metadata))
            .filter(Boolean);
    } catch {
        avoidMetadataObjects = [];
    }
    if (avoidMetadataObjects.length) {
        askN = missing + 10;
    }
    logImportant('[dbFirstSelectAndMaybeGenerateWithGpt] missing=', missing, 'askN=', askN, 'avoidMetadata.count=', avoidMetadataObjects.length);

    const aiClient = getOpenAI();
    if (!aiClient) {
        return { error: { status: 503, body: { error: 'OpenAI not configured' } } };
    }
    const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

    let knowledge_point_ids_plan = [];
    try {
        knowledge_point_ids_plan = await buildKnowledgePointIdsPlan(knowledgePointsForPrompt, askN);
    } catch {
        knowledge_point_ids_plan = Array.from({ length: askN }).map(() => (knowledgePointsForPrompt[0] ? Number(knowledgePointsForPrompt[0].id) : null)).filter(Boolean);
    }

    const sysTpl = (useLang === 'zh' && prompts && prompts.diagnostic && prompts.diagnostic.system_zh)
        ? prompts.diagnostic.system_zh
        : (prompts && prompts.diagnostic && prompts.diagnostic.system_en)
            ? prompts.diagnostic.system_en
            : 'You are a helpful tutoring assistant. Output strict JSON.';
    const userTpl = (useLang === 'zh' && prompts && prompts.diagnostic && prompts.diagnostic.user_zh)
        ? prompts.diagnostic.user_zh
        : (prompts && prompts.diagnostic && prompts.diagnostic.user_en)
            ? prompts.diagnostic.user_en
            : 'Generate a diagnostic test as JSON.';

    const retrieval_snippets = [];
    const userMessage = applyTemplateAll(userTpl, {
        student_profile: JSON.stringify(student_profile),
        num_questions: String(askN),
        retrieval_snippets: JSON.stringify(retrieval_snippets),
        knowledge_points: JSON.stringify(knowledgePointsForPrompt),
        knowledge_point_ids_plan: JSON.stringify(knowledge_point_ids_plan),
        avoid_metadata: JSON.stringify(avoidMetadataObjects.slice(0, 5)),
    });

    let completion;
    try {
        completion = await createChatCompletionJson(aiClient, {
            model,
            messages: [
                { role: 'system', content: sysTpl },
                { role: 'user', content: userMessage },
            ],
            max_tokens: Math.max(1, Number(max_tokens) || 4000),
        });
    } catch (e) {
        return { error: { status: 500, body: { error: 'OpenAI API 调用失败', detail: e && e.message ? e.message : e } } };
    }

    const text = completion && completion.choices && completion.choices[0] && completion.choices[0].message
        ? completion.choices[0].message.content
        : '';
    const gen = safeParseJsonObject(text);
    if (!gen || !Array.isArray(gen.questions)) {
        return { error: { status: 500, body: { error: 'Failed to parse generated JSON' } } };
    }

    // Map bilingual fields and options
    const existingHashes = new Set(questionsOut.map(q => q.content_options_hash).filter(Boolean));
    const candidates = [];
    for (const q of gen.questions) {
        if (!q || (!q.content_en && !q.content_cn)) continue;
        const opt = extractBilingualOptions(q.options);
        if (!opt) continue;
        const h = computeQuestionContentOptionsHash(q.content_en, opt.en);
        if (existingHashes.has(h)) continue;
        existingHashes.add(h);
        candidates.push({ ...q, __opt: opt, content_options_hash: h });
    }

    // Filter out candidates already in DB by content_options_hash (batch)
    let inDb = new Set();
    try {
        const hashes = candidates.map(c => c.content_options_hash).filter(Boolean);
        if (hashes.length) {
            const r = await pool.query('SELECT content_options_hash FROM questions WHERE content_options_hash = ANY($1::text[])', [hashes]);
            inDb = new Set((r.rows || []).map(x => x.content_options_hash));
        }
    } catch {
        inDb = new Set();
    }

    const accepted = [];
    for (const c of candidates) {
        const opt = c.__opt || extractBilingualOptions(c.options);
        if (!opt) continue;
        const optsEn = normalizeOptions(opt.en);
        const optsZh = normalizeOptions(opt.zh);
        if (!optsEn || optsEn.length !== 4 || !optsZh || optsZh.length !== 4) continue;
        if (!optsEn.includes((c.answer_en || '').toString().trim()) || !optsZh.includes((c.answer_cn || '').toString().trim())) continue;
        if (typeof c.answer_en !== 'string' || typeof c.answer_cn !== 'string') continue;
        if (inDb.has(c.content_options_hash)) continue;

        accepted.push({
            type: 'mcq',
            content_cn: c.content_cn,
            content_en: c.content_en,
            options: { zh: optsZh, en: optsEn },
            content_options_hash: c.content_options_hash,
            metadata: normalizeQuestionMetadata(c.metadata) || null,
            answer_cn: c.answer_cn,
            answer_en: c.answer_en,
            explanation_cn: c.explanation_cn,
            explanation_en: c.explanation_en,
            knowledge_point_id: c.knowledge_point_id,
        });
    }

    // Enforce required knowledge_point_id distribution using the plan (by question index).
    const fallbackKpId = knowledgePointsForPrompt[0] ? Number(knowledgePointsForPrompt[0].id) : null;
    accepted.forEach((q, idx) => {
        const planned = knowledge_point_ids_plan[idx];
        if (Number.isInteger(planned) && (!allowedSet.size || allowedSet.has(planned))) {
            q.knowledge_point_id = planned;
            return;
        }
        if (Number.isInteger(kpFilterId)) {
            q.knowledge_point_id = kpFilterId;
            return;
        }
        const kpId = Number(q.knowledge_point_id);
        if (Number.isInteger(kpId) && (!allowedSet.size || allowedSet.has(kpId))) {
            q.knowledge_point_id = kpId;
            return;
        }
        q.knowledge_point_id = fallbackKpId;
    });

    // Rank candidates by distance to avoidMetadataObjects (farthest first).
    if (avoidMetadataObjects.length && accepted.length) {
        try {
            const avoidTexts = avoidMetadataObjects.map(m => buildMetadataEmbeddingText(m)).filter(Boolean);
            const acceptedTexts = accepted.map(q => buildMetadataEmbeddingText(q && q.metadata ? q.metadata : null));

            const candPairs = accepted
                .map((q, idx) => ({ q, idx, text: acceptedTexts[idx] || '' }))
                .filter(x => x.text);

            if (avoidTexts.length && candPairs.length) {
                const pc = (() => {
                    try {
                        const p = getPinecone();
                        if (p && typeof p.embedTexts === 'function') return p;
                        return null;
                    } catch {
                        return null;
                    }
                })();

                const embed = async (texts) => {
                    if (pc) return await pc.embedTexts(texts, 'query');
                    return await embedTextsOpenAI(texts);
                };

                const avoidVecs = await embed(avoidTexts);
                const candVecs = await embed(candPairs.map(x => x.text));

                if (Array.isArray(avoidVecs) && Array.isArray(candVecs) && avoidVecs.length === avoidTexts.length && candVecs.length === candPairs.length) {
                    const scored = candPairs.map((x, i) => {
                        const v = candVecs[i];
                        let maxSim = -1;
                        for (const av of avoidVecs) {
                            const s = cosineSimilarity(v, av);
                            if (s > maxSim) maxSim = s;
                        }
                        if (!Number.isFinite(maxSim) || maxSim < 0) maxSim = 1;
                        return { ...x, maxSim };
                    });

                    scored.sort((a, b) => a.maxSim - b.maxSim);

                    const avoidThreshold = getSimilarityThreshold('AVOID_METADATA_THRESHOLD', 0.9);
                    const filtered = scored.filter(x => x.maxSim < avoidThreshold);
                    const useFiltered = filtered.length >= missing;
                    const ranked = (useFiltered ? filtered : scored).map(x => x.q);
                    const noText = accepted.filter((q, idx) => !(acceptedTexts[idx] || ''));
                    accepted.splice(0, accepted.length, ...ranked, ...noText);
                }
            }
        } catch {
            // non-fatal
        }
    }

    // Per-student filtering derived from Postgres history (userIds), compared via Pinecone using ONLY global question_metadata vectors.
    let acceptedForInsert = accepted;
    try {
        const pcForDedupe = (() => {
            try {
                const pc = getPinecone();
                if (!pc || typeof pc.queryByVector !== 'function') return null;
                return pc;
            } catch {
                return null;
            }
        })();
        acceptedForInsert = await dedupeQuestionsBeforeInsert({
            questions: accepted,
            pcClient: pcForDedupe,
            userIds: studentUserIds,
            gradeId: Number(gradeId),
            subjectId: Number(subjectId),
        });
    } catch {
        acceptedForInsert = accepted;
    }

    return {
        questionsOut,
        generatedQuestions: acceptedForInsert,
        generatedLesson: (gen && gen.lesson) ? gen.lesson : null,
    };
}

// NOTE: Postgres tables are initialized lazily (see ensureDbInitialized), so we
// don't call ensureTables() eagerly at process startup.


function generateToken(user) {
    return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}


// 本地账号注册/登录
app.post('/auth/mock-login', async (req, res) => {
    const { username, password, mode } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

    // Ensure all tables exist during register/login (lazy init).
    await ensureDbInitialized();

    if (useDb) {
        try {
            if (mode === 'register') {
                // 注册
                const existing = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
                if (existing.rows.length > 0) {
                    return res.status(400).json({ error: '用户名已存在' });
                }
                const inserted = await pool.query('INSERT INTO users(username, password, created_at) VALUES($1, $2, NOW()) RETURNING *', [username, password]);
                const user = inserted.rows[0];
                const token = generateToken(user);
                return res.json({ token, user });
            } else {
                // 登录
                const existing = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
                const user = existing.rows[0];
                if (!user || user.password !== password) {
                    return res.status(400).json({ error: '用户名或密码错误' });
                }
                await pool.query('UPDATE users SET last_login_at=NOW() WHERE id=$1', [user.id]);
                const token = generateToken(user);
                return res.json({ token, user });
            }
        } catch (e) {
            console.error('DB login error', e);
            return res.status(500).json({ error: 'DB error' });
        }
    }
    // 内存模式
    if (mode === 'register') {
        const exists = Object.values(users).some(u => u.username === username);
        if (exists) return res.status(400).json({ error: '用户名已存在' });
        const id = Object.keys(users).length + 1;
        const user = { id, username, password, created_at: Date.now(), last_login_at: null };
        users[id] = user;
        const token = generateToken(user);
        return res.json({ token, user });
    } else {
        const user = Object.values(users).find(u => u.username === username && u.password === password);
        if (!user) return res.status(400).json({ error: '用户名或密码错误' });
        user.last_login_at = Date.now();
        const token = generateToken(user);
        return res.json({ token, user });
    }
});


// OAuth 登录注册（简化版，真实环境应校验token）
// Google OAuth 登录注册，支持credential解码
app.post('/auth/oauth', async (req, res) => {
    let { email, name, provider, credential, profile } = req.body;
    // 如果是Google，尝试从credential解码email
    if (provider === 'google' && credential && !email) {
        try {
            // JWT格式：header.payload.signature
            const payload = credential.split('.')[1];
            const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
            email = decoded.email;
            name = decoded.name || name;
            if (decoded.picture) profile = { ...(profile || {}), picture: decoded.picture };
        } catch (e) {
            return res.status(400).json({ error: 'Invalid Google credential' });
        }
    }
    if (!email) return res.status(400).json({ error: 'Email required' });
    try {
        if (useDb) {
            let user;
            const existing = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
            if (existing.rows.length > 0) {
                user = existing.rows[0];
            } else {
                // 不再插入grade/subject/lang字段
                const inserted = await pool.query('INSERT INTO users(email,name) VALUES($1,$2) RETURNING *', [email, name || provider || 'OAuthUser']);
                user = inserted.rows[0];
            }
            if (profile && profile.picture) user.picture = profile.picture;
            const token = generateToken(user);
            return res.json({ token, user });
        }
        // 内存模式
        let user = Object.values(users).find(u => u.email === email);
        if (!user) {
            const id = Object.keys(users).length + 1;
            user = { id, email, name: name || provider || 'OAuthUser' };
            users[id] = user;
        }
        if (profile && profile.picture) user.picture = profile.picture;
        const token = generateToken(user);
        res.json({ token, user });
    } catch (e) {
        console.error('OAuth login error', e);
        res.status(500).json({ error: 'OAuth error' });
    }
});

app.get('/me', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const token = auth.replace('Bearer ', '');
    try {
        const data = jwt.verify(token, JWT_SECRET);
        if (useDb) {
            const r = await pool.query('SELECT * FROM users WHERE id=$1', [data.id]);
            const user = r.rows[0];
            if (!user) return res.status(404).json({ error: 'User not found' });
            return res.json({ user });
        }
        const user = users[data.id];
        if (!user) return res.status(404).json({ error: 'User not found' });
        return res.json({ user });
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
});

app.post('/user/update', async (req, res) => {
    const { token } = req.body;
    debugLog('[user/update] called, body:', { ...req.body, token: token ? '<redacted>' : null });
    if (!token) {
        debugLog('[user/update] missing token');
        return res.status(400).json({ error: 'Token required' });
    }
    try {
        const data = jwt.verify(token, JWT_SECRET);
        debugLog('[user/update] token decoded:', data);
        const { grade, subject, grade_id, subject_id, lang } = req.body;
        if (useDb) {
            const resolved = await resolveGradeSubject({ grade, subject, grade_id, subject_id });
            const r = await pool.query(
                'UPDATE users SET grade = COALESCE($1, grade), subject = COALESCE($2, subject), grade_id = COALESCE($3, grade_id), subject_id = COALESCE($4, subject_id), lang = COALESCE($5, lang) WHERE id=$6 RETURNING *',
                [
                    resolved.gradeCode != null ? resolved.gradeCode : grade,
                    resolved.subjectCode != null ? resolved.subjectCode : subject,
                    resolved.gradeId != null ? resolved.gradeId : grade_id,
                    resolved.subjectId != null ? resolved.subjectId : subject_id,
                    lang,
                    data.id
                ]
            );
            debugLog('[user/update] db updated:', r.rows[0]);
            return res.json({ user: r.rows[0] });
        }
        const user = users[data.id];
        if (!user) {
            debugLog('[user/update] user not found in memory:', data.id);
            return res.status(404).json({ error: 'User not found' });
        }
        if (grade) user.grade = grade;
        if (subject) user.subject = subject;
        if (lang) user.lang = lang;
        debugLog('[user/update] memory user updated:', user);
        return res.json({ user });
    } catch (e) {
        debugLog('[user/update] token error:', e && e.message ? e.message : e);
        return res.status(401).json({ error: 'Invalid token', detail: e.message || e });
    }
});


// Simple in-memory history store per user (for demo)
const history = {}; // history[userId] = [{ questionId, givenAnswer, correct, correctAnswer, timestamp }]

// 工具函数：根据username查所有user_id（知识点分数合并用）
async function getUserIdsByUsername(username) {
    if (!useDb) return [];
    const r = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    return r.rows.map(row => row.id);
}

app.get('/api/today', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const token = auth.replace('Bearer ', '');
    try {
        const data = jwt.verify(token, JWT_SECRET);
        let user = users[data.id];
        if (useDb) {
            const r = await pool.query('SELECT * FROM users WHERE id=$1', [data.id]);
            user = r.rows[0];
        }
        // 只用前端传入的grade/subject，后端today接口不再假定user有grade/subject
        // 这里建议直接返回错误或空内容，或要求前端传递grade/subject参数
        return res.status(400).json({ error: 'Please use /api/generate/diagnostic with grade/subject from frontend.' });

        // ...如需 fallback，可直接返回空题目或默认 questions
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
});

// Submit an answer for a question
app.post('/api/submit-answer', async (req, res) => {
    const { token, questionId, answer } = req.body;
    submitAnswerLog('payload:', { ...req.body, token: token ? '<redacted>' : null });
    if (!token || !questionId) {
        submitAnswerLog('missing token or questionId');
        return res.status(400).json({ error: 'token and questionId required' });
    }
    try {
        const data = jwt.verify(token, JWT_SECRET);
        submitAnswerLog('token valid, user id:', data.id);
        let user = users[data.id];
        if (useDb) {
            const r = await pool.query('SELECT * FROM users WHERE id=$1', [data.id]);
            user = r.rows[0];
        }
        submitAnswerLog('user loaded:', user);
        if (!user) {
            submitAnswerLog('user not found for id:', data.id);
            return res.status(404).json({ error: 'User not found' });
        }

        let correct = false;
        let correctAnswer = null;
        const lang = user.lang === 'zh' ? 'zh' : 'en';
        submitAnswerLog('lang:', lang);
        if (typeof questionId === 'string' && questionId.startsWith('q')) {
            const i = parseInt(questionId.slice(1), 10);
            correctAnswer = (5 + i).toString();
            correct = (answer && answer.toString().trim() === correctAnswer);
            submitAnswerLog('demo correctAnswer:', correctAnswer, 'user answer:', answer, 'correct:', correct);
        }

        let analysis = '';
        const aiClient2 = getOpenAI();
        if (!correct && aiClient2) {
            try {
                const prompt2 = `A student answered '${answer}' to question '${questionId}' whose correct answer is '${correctAnswer}'. Provide a short analysis of the likely mistake and a simple explanation/remediation in ${user.lang === 'zh' ? 'Chinese' : 'English'}.`;
                const resp2 = await aiClient2.chat.completions.create({
                    model: 'gpt-4.1',
                    messages: [
                        { role: 'system', content: 'You are a patient teacher and explain mistakes clearly.' },
                        { role: 'user', content: prompt2 }
                    ],
                    max_tokens: 300
                });
                analysis = resp2.choices[0].message.content;
                submitAnswerLog('AI analysis:', analysis);
            } catch (e) {
                submitAnswerLog('OpenAI analysis error:', e && e.message ? e.message : e);
            }
        }

        const timestamp = Date.now();
        const record = { questionId, givenAnswer: answer, correct, correctAnswer, created_at: new Date().toISOString(), timestamp };
        if (useDb) {
            try {
                const qid = Number(record.questionId);
                await pool.query(
                    'INSERT INTO history(user_id, question_id, given_answer, correct, created_at) VALUES($1,$2,$3,$4,$5)',
                    [data.id, Number.isInteger(qid) ? qid : null, record.givenAnswer, record.correct, record.created_at]
                );
                submitAnswerLog('history inserted to DB:', record);
            } catch (e) {
                submitAnswerLog('history insert error:', e && e.message ? e.message : e);
            }
        } else {
            history[data.id] = history[data.id] || [];
            history[data.id].push(record);
            submitAnswerLog('history inserted to memory:', record);
        }

        submitAnswerLog('returning result:', { success: true, ...record });
        return res.json({ success: true, ...record });

    } catch (e) {
        submitAnswerLog('error caught:', e && e.message ? e.message : e);
        return res.status(401).json({ error: 'Invalid token' });
    }
});

// Generate a 20-question diagnostic tailored to the student using RAG + OpenAI
app.post('/api/generate/diagnostic', async (req, res) => {
    const { token, grade, subject, grade_id, subject_id, lang } = req.body;
    diagLog('[diagnostic] payload:', { ...req.body, token: token ? '<redacted>' : null });
    if (!token) {
        diagLog('[diagnostic] missing token');
        return res.status(400).json({ error: 'Token required' });
    }

    try {
        diagLog('[diagnostic] entered handler');
        if (process.env.NODE_ENV === 'test') diagLog('HANDLER GENERATE: app.locals.openai present:', !!app.locals.openai);
        let data;
        try {
            data = jwt.verify(token, JWT_SECRET);
            diagLog('[diagnostic] token valid, user:', data);
        } catch (e) {
            diagLog('[diagnostic] invalid token:', e && e.message ? e.message : e);
            return res.status(401).json({ error: 'Invalid token' });
        }
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

        // 必须由前端传入 grade/subject 或者 grade_id/subject_id，否则直接报错
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
                    // do NOT log token
                    token: '<redacted>',
                });
            } catch { }
            diagLog('[diagnostic] missing grade/subject and grade_id/subject_id');
            return res.status(400).json({ error: 'grade/subject (legacy) or grade_id/subject_id are required. Please select them in the frontend.' });
        }

        const resolved = await resolveGradeSubject({ grade, subject, grade_id, subject_id });
        const useGradeId = resolved.gradeId != null ? resolved.gradeId : (grade_id != null ? Number(grade_id) : null);
        const useSubjectId = resolved.subjectId != null ? resolved.subjectId : (subject_id != null ? Number(subject_id) : null);
        let gradeSubjectId = null;
        if (useDb && useGradeId && useSubjectId) {
            try {
                const r = await pool.query('SELECT id FROM grade_subjects WHERE grade_id=$1 AND subject_id=$2 LIMIT 1', [useGradeId, useSubjectId]);
                gradeSubjectId = r.rows[0] ? r.rows[0].id : null;
            } catch (e) {
                gradeSubjectId = null;
            }
        }

        // 语言逻辑：只按 lang 参数（默认 zh）
        let useLang = lang === 'en' ? 'en' : 'zh';
        diagLog('[diagnostic] language selection:', useLang);
        diagLog('[diagnostic] reached selection logic, user:', user, 'grade_id:', useGradeId, 'subject_id:', useSubjectId, 'lang:', useLang);

        // For DB mode we must be able to filter by grade_id/subject_id
        if (useDb && (!useGradeId || !useSubjectId)) {
            return res.status(400).json({ error: 'grade_id and subject_id are required (or provide legacy grade/subject that can be resolved to ids).' });
        }

        // Resolve display names for prompt/title (prefer DB names; fall back to legacy payload strings)
        let gradeNameZh = '';
        let gradeNameEn = '';
        let subjectNameZh = '';
        let subjectNameEn = '';
        if (useDb && useGradeId) {
            try {
                const r = await pool.query('SELECT name_zh, name_en FROM grades WHERE id = $1', [useGradeId]);
                gradeNameZh = (r.rows[0]?.name_zh || '') || '';
                gradeNameEn = (r.rows[0]?.name_en || '') || '';
            } catch (e) {
                gradeNameZh = '';
                gradeNameEn = '';
            }
        }
        if (useDb && useSubjectId) {
            try {
                const r = await pool.query('SELECT name_zh, name_en FROM subjects WHERE id = $1', [useSubjectId]);
                subjectNameZh = (r.rows[0]?.name_zh || '') || '';
                subjectNameEn = (r.rows[0]?.name_en || '') || '';
            } catch (e) {
                subjectNameZh = '';
                subjectNameEn = '';
            }
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

        // For per-student aggregation, merge all DB user_ids under same username (same logic as /api/history).
        let studentUserIds = [user.id];
        if (useDb) {
            try {
                const uname = user && user.username ? String(user.username) : null;
                const ids = uname ? await getUserIdsByUsername(uname) : [];
                if (Array.isArray(ids) && ids.length) studentUserIds = ids;
            } catch (e) {
                studentUserIds = [user.id];
            }
        }

        // Helper: build a knowledge point assignment plan based on numQuestions and seeded KPs.
        // Rules:
        // - If numQuestions <= numKPs: randomly pick numQuestions distinct KPs, each exactly one question.
        // - If numQuestions > numKPs: include all KPs once, then randomly pick additional KPs to fill.
        const buildKnowledgePointIdsPlan = async (knowledgePoints, desiredCount) => {
            const rawIds = (Array.isArray(knowledgePoints) ? knowledgePoints : [])
                .map(k => (k && k.id != null ? Number(k.id) : null))
                .filter(x => Number.isInteger(x));
            const ids = Array.from(new Set(rawIds));
            const n = ids.length;
            const m = Math.max(0, Number(desiredCount) || 0);
            if (!n || !m) return [];

            // Default: shuffle
            let ordered = ids.slice();

            // DB mode: prioritize knowledge points with the fewest attempts for this student in this grade+subject.
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
                } catch (e) {
                    // Fall back to random shuffle
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

            if (m <= n) {
                return ordered.slice(0, m);
            }

            // If need more than available KPs, include all once then preferentially repeat from the lowest-attempt pool.
            const plan = ordered.slice();
            const poolSize = Math.min(ordered.length, Math.max(3, Math.ceil(ordered.length / 3)));
            const repeatPool = ordered.slice(0, poolSize);
            while (plan.length < m) {
                plan.push(repeatPool[crypto.randomInt(0, repeatPool.length)]);
            }
            return plan;
        };

        // Load seeded knowledge points (prompt input) and restrict any GPT output to these ids.
        // In DB mode, these must be pre-seeded per grade_subject_id.
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
            } catch (e) {
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
            // In-memory fallback (dev/test): provide a minimal seeded list.
            knowledgePointsForPrompt = [
                { id: 1, name_cn: '基础概念', name_en: 'Basics', unit_name_cn: '单元1', unit_name_en: 'Unit 1', description: 'Basic definitions and simple facts.', difficulty_avg: 2, sort_order: 10 },
                { id: 2, name_cn: '核心技能', name_en: 'Core Skills', unit_name_cn: '单元2', unit_name_en: 'Unit 2', description: 'Core methods and typical problem solving.', difficulty_avg: 3, sort_order: 20 }
            ];
            allowedKnowledgePointIds = new Set(knowledgePointsForPrompt.map(k => k.id));
        }

        // This plan ties knowledge_point_id distribution to numQuestions.
        // It is passed to GPT so each question must follow the plan by index.
        const knowledgePointIdsPlanForNumQuestions = await buildKnowledgePointIdsPlan(knowledgePointsForPrompt, numQuestions);

        // In-memory mode fallback: keep old behavior (always GPT)
        diagLog('[diagnostic] branch selection, useDb:', useDb);
        if (!useDb) {
            diagLog('[diagnostic] in-memory mode');
            // In memory mode we may not have DB meta tables; keep original prompt shape
            const student_profile = { id: user.id, grade: gradeDisplayName, subject: subjectDisplayName, lang: useLang };
            const sysTpl = (useLang === 'zh' && prompts && prompts.diagnostic.system_zh) ? prompts.diagnostic.system_zh : (prompts && prompts.diagnostic.system_en ? prompts.diagnostic.system_en : 'You are a helpful tutoring assistant. Output strict JSON.');
            const userTpl = (useLang === 'zh' && prompts && prompts.diagnostic.user_zh) ? prompts.diagnostic.user_zh : (prompts && prompts.diagnostic.user_en ? prompts.diagnostic.user_en : 'Generate a diagnostic test as JSON.');
            const userMessage = applyTemplateAll(userTpl, {
                student_profile: JSON.stringify(student_profile),
                num_questions: String(numQuestions),
                retrieval_snippets: JSON.stringify([]),
                knowledge_points: JSON.stringify(knowledgePointsForPrompt),
                knowledge_point_ids_plan: JSON.stringify(knowledgePointIdsPlanForNumQuestions),
                avoid_metadata: JSON.stringify([])
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
                // Keep in-memory ids stable (tests use 'q1'). Only coerce purely-numeric ids.
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

        // ---------------------------
        // DB-first selection pipeline 正式开始生成题目
        // ---------------------------
        const selected = [];
        diagLog('[diagnostic] DB mode: selection pipeline start');

        // (A) Find knowledge points used by this user under this grade+subject (via history -> questions join)
        let usedKnowledgePoints = [];
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
                   AND q.knowledge_point_id IS NOT NULL
                   `,
                params
            );
            usedKnowledgePoints = kpRows.rows.map(r => r.knowledge_point_id);
            diagLog('[diagnostic] usedKnowledgePoints =', usedKnowledgePoints);
        } catch (e) {
            usedKnowledgePoints = [];
            diagLog('[diagnostic] usedKnowledgePoints query failed:', e.message || e);
        }

        // (B) Pick lowest-score knowledge points (target = numQuestions)
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

                // Lowest score first (weaker knowledge points)
                stats.sort((a, b) => {
                    const sa = Number.isFinite(a.score) ? a.score : 0;
                    const sb = Number.isFinite(b.score) ? b.score : 0;
                    if (sa !== sb) return sa - sb;
                    // Tie-breaker: fewer attempts first, then random
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
                student_profile: { id: user.id, grade: gradeDisplayName, subject: subjectDisplayName, lang: useLang, focus_knowledge_points: focusKnowledgePoints },
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
        const accepted = (genRes && genRes.generatedQuestions) ? genRes.generatedQuestions : [];
        const genLesson = (genRes && genRes.generatedLesson) ? genRes.generatedLesson : null;

        diagLog('[diagnostic] questionsOut.length after selection =', questionsOut.length);

        if (questionsOut.length < numQuestions) {
            diagLog('[diagnostic] still not enough after DB fetch; will insert GPT-generated questions');
            let returnPool = accepted;

            // Optional semantic de-dup vs existing Postgres questions (global within grade+subject).
            const enableSemanticDedupe = process.env.SEMANTIC_DEDUPE === '1';
            const semanticThreshold = getSimilarityThreshold('SEMANTIC_DEDUPE_THRESHOLD', 0.92);

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
                } catch (e) {
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
                } catch (e) {
                    // If embeddings fail, fall back to hash-only behavior.
                }
            }

            // Optional metadata-based dedupe via Pinecone cosine similarity.
            // This compares metadata embeddings, not raw question text.
            const enableMetadataDedupe = true;
            const metadataThreshold = getSimilarityThreshold('METADATA_DEDUPE_THRESHOLD', 0.9);

            const pcForMetadata = (() => {
                try {
                    const pc = getPinecone();
                    if (!pc || typeof pc.embedTexts !== 'function' || typeof pc.queryByVector !== 'function' || typeof pc.upsertVectors !== 'function') return null;
                    return pc;
                } catch {
                    return null;
                }
            })();

            // Insert ONLY the questions we will return (so returned ids always exist in Postgres and match the screen).
            // Dedupe at insertion time is global (metadata + DB semantic + content_options_hash constraint).
            for (const q of returnPool) {
                if (questionsOut.length >= numQuestions) break;

                if (enableMetadataDedupe && pcForMetadata && q) {
                    try {
                        const metaText = buildQuestionDedupeEmbeddingText(q, {
                            gradeId: useGradeId,
                            subjectId: useSubjectId,
                            knowledgePointId: q.knowledge_point_id || null,
                        });
                        if (metaText) {
                            // IMPORTANT: always use Pinecone embeddings for Pinecone query/upsert.
                            // Using q.embedding here can cause dimension mismatch (e.g. OpenAI 1536 vs Pinecone index dims)
                            // and failures would be swallowed.
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
                        // If Pinecone fails, fall back to DB insert path.
                        diagLog('[diagnostic] metadata-dedupe pinecone query failed:', e && e.message ? e.message : String(e));
                    }
                }

                if (enableSemanticDedupe && Array.isArray(q.embedding) && existingEmbeddings.length) {
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
                    // Upsert by content_options_hash; let SERIAL id auto-generate.
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
                } catch (e) { }

                if (!Number.isInteger(insertedId)) {
                    try {
                        const sel = await pool.query('SELECT id FROM questions WHERE content_options_hash=$1 LIMIT 1', [q.content_options_hash]);
                        insertedId = sel.rows[0] ? Number(sel.rows[0].id) : null;
                    } catch (e) {
                        insertedId = null;
                    }
                }

                // If we couldn't obtain a stable DB id, do not return it (submit would not be able to record history correctly).
                if (!Number.isInteger(insertedId)) {
                    continue;
                }

                // Upsert metadata vector for future dedupe/retrieval.
                if (enableMetadataDedupe && pcForMetadata && Number.isInteger(insertedId) && q) {
                    try {
                        const metaText = buildQuestionDedupeEmbeddingText(q, {
                            gradeId: useGradeId,
                            subjectId: useSubjectId,
                            knowledgePointId: q.knowledge_point_id || null,
                        });
                        if (metaText) {
                            // IMPORTANT: always use Pinecone embeddings for Pinecone upsert (dimension must match index).
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
                        // Non-fatal.
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
            // No final deduplication needed; questionsOut already deduped during insertion and earlier steps.
            questionsOut = questionsOut.slice(0, numQuestions);

            // Validate with AJV schema if available
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

            // Always return bilingual-switchable lesson title/explanation.
            // (Do not override with GPT lesson fields, which may be single-language.)
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


// Generate practice questions for a specific knowledge point (DB -> Pinecone RAG -> GPT fill)
app.post('/api/generate/practice', async (req, res) => {
    const { token, grade_id, subject_id, knowledge_point_id, num_questions, lang } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Token required' });
    if (!useDb) return res.status(400).json({ error: 'DB disabled' });

    const useGradeId = grade_id != null ? Number(grade_id) : null;
    const useSubjectId = subject_id != null ? Number(subject_id) : null;
    const kpId = knowledge_point_id != null ? Number(knowledge_point_id) : null;
    const n = Math.max(1, Math.min(50, Number(num_questions) || 5));
    const useLang = lang === 'en' ? 'en' : 'zh';

    if (!Number.isInteger(useGradeId) || !Number.isInteger(useSubjectId) || !Number.isInteger(kpId)) {
        return res.status(400).json({ error: 'grade_id, subject_id, knowledge_point_id are required (integer)' });
    }

    let data;
    try {
        data = jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    // Load user
    let user = null;
    try {
        const r = await pool.query('SELECT * FROM users WHERE id=$1', [data.id]);
        user = r.rows[0] || null;
    } catch (e) {
        user = null;
    }
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Resolve grade/subject display names
    let gradeNameZh = '';
    let gradeNameEn = '';
    let subjectNameZh = '';
    let subjectNameEn = '';
    try {
        const r = await pool.query('SELECT name_zh, name_en FROM grades WHERE id=$1', [useGradeId]);
        gradeNameZh = (r.rows[0]?.name_zh || '') || '';
        gradeNameEn = (r.rows[0]?.name_en || '') || '';
    } catch { }
    try {
        const r = await pool.query('SELECT name_zh, name_en FROM subjects WHERE id=$1', [useSubjectId]);
        subjectNameZh = (r.rows[0]?.name_zh || '') || '';
        subjectNameEn = (r.rows[0]?.name_en || '') || '';
    } catch { }

    // Resolve knowledge point info
    let kpNameCn = '';
    let kpNameEn = '';
    let kpUnitCn = '';
    let kpUnitEn = '';
    let kpDesc = '';
    try {
        const r = await pool.query(
            'SELECT name_cn, name_en, unit_name_cn, unit_name_en, description FROM knowledge_points WHERE id=$1 LIMIT 1',
            [kpId]
        );
        kpNameCn = (r.rows[0]?.name_cn || '') || '';
        kpNameEn = (r.rows[0]?.name_en || '') || '';
        kpUnitCn = (r.rows[0]?.unit_name_cn || '') || '';
        kpUnitEn = (r.rows[0]?.unit_name_en || '') || '';
        kpDesc = (r.rows[0]?.description || '') || '';
    } catch { }

    const gradeDisplayName = useLang === 'zh' ? gradeNameZh : gradeNameEn;
    const subjectDisplayName = useLang === 'zh' ? subjectNameZh : subjectNameEn;
    const kpDisplayName = useLang === 'zh' ? (kpNameCn || kpNameEn) : (kpNameEn || kpNameCn);

    // For per-student aggregation, merge all DB user_ids under same username (same logic as /api/history).
    let studentUserIds = [user.id];
    try {
        const uname = user && user.username ? String(user.username) : null;
        const ids = uname ? await getUserIdsByUsername(uname) : [];
        if (Array.isArray(ids) && ids.length) studentUserIds = ids;
    } catch { }

    const kpObj = {
        id: kpId,
        name_cn: kpNameCn,
        name_en: kpNameEn,
        unit_name_cn: kpUnitCn,
        unit_name_en: kpUnitEn,
        description: kpDesc
    };

    const student_profile = {
        id: user.id,
        grade: gradeDisplayName,
        subject: subjectDisplayName,
        lang: useLang,
        focus_knowledge_points: [kpId]
    };

    const buildKnowledgePointIdsPlan = async (_kps, desiredCount) => {
        const m = Math.max(0, Number(desiredCount) || 0);
        return Array.from({ length: m }).map(() => kpId);
    };

    const genRes = await dbFirstSelectAndMaybeGenerateWithGpt({
        numQuestions: n,
        studentUserIds,
        gradeId: useGradeId,
        subjectId: useSubjectId,
        knowledgePointId: kpId,
        preferredKnowledgePointIds: null,
        avoidMetadataKnowledgePointId: kpId,
        promptCtx: {
            useLang,
            student_profile,
            knowledgePointsForPrompt: [kpObj],
            allowedKnowledgePointIds: new Set([kpId]),
            buildKnowledgePointIdsPlan,
            max_tokens: 4000,
        },
        logFn: (...args) => { try { console.log('[practice]', ...args); } catch { } },
    });
    if (genRes && genRes.error) {
        return res.status(genRes.error.status).json(genRes.error.body);
    }

    let questionsOut = (genRes && genRes.questionsOut) ? genRes.questionsOut : [];
    const acceptedForInsert = (genRes && genRes.generatedQuestions) ? genRes.generatedQuestions : [];

    if (questionsOut.length < n) {
        const practiceLog = (...args) => { try { console.log('[practice]', ...args); } catch { } };

        // Optional metadata-based dedupe via Pinecone cosine similarity.
        // This compares embeddings built from question metadata (or fallback to content+options) and uses ONLY global question_metadata vectors.
        const enableMetadataDedupe = true;
        const metadataThreshold = getSimilarityThreshold('METADATA_DEDUPE_THRESHOLD', 0.9);

        const pcForMetadata = (() => {
            try {
                const pc = getPinecone();
                if (!pc || typeof pc.embedTexts !== 'function' || typeof pc.queryByVector !== 'function' || typeof pc.upsertVectors !== 'function') return null;
                return pc;
            } catch {
                return null;
            }
        })();

        // Insert accepted questions (upsert by content_options_hash)
        for (const q of acceptedForInsert) {
            if (questionsOut.length >= n) break;

            if (enableMetadataDedupe && pcForMetadata && q) {
                try {
                    const metaText = buildQuestionDedupeEmbeddingText(q, {
                        gradeId: useGradeId,
                        subjectId: useSubjectId,
                        knowledgePointId: kpId,
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
                                practiceLog('metadata-dedupe skip (pinecone score):', { score: best, threshold: metadataThreshold });
                                continue;
                            }
                        }
                    }
                } catch (e) {
                    practiceLog('metadata-dedupe pinecone query failed:', e && e.message ? e.message : String(e));
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
                        kpId,
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

            // Do not return a question without a stable DB id.
            if (!Number.isInteger(insertedId)) continue;

            // Upsert metadata vector for future dedupe/retrieval.
            if (enableMetadataDedupe && pcForMetadata && q) {
                try {
                    const metaText = buildQuestionDedupeEmbeddingText(q, {
                        gradeId: useGradeId,
                        subjectId: useSubjectId,
                        knowledgePointId: kpId,
                    });
                    if (metaText) {
                        const v = ((await pcForMetadata.embedTexts([metaText], 'passage')) || [])[0] || null;
                        if (v && Array.isArray(v) && v.length) {
                            const md = {
                                kind: 'question_metadata',
                                question_id: insertedId,
                                grade_id: useGradeId,
                                subject_id: useSubjectId,
                                knowledge_point_id: kpId,
                                expression: (q && q.metadata && q.metadata.expression) ? String(q.metadata.expression) : null,
                                content_options_hash: q.content_options_hash || null,
                            };
                            await pcForMetadata.upsertVectors([{ id: `qmeta:${insertedId}`, values: v, metadata: md }]);
                            practiceLog('pinecone upserted question_metadata:', { id: `qmeta:${insertedId}`, grade_id: useGradeId, subject_id: useSubjectId, knowledge_point_id: kpId });
                        }
                    }
                } catch (e) {
                    practiceLog('pinecone upsert failed:', e && e.message ? e.message : String(e));
                }
            }

            questionsOut.push({
                id: Number.isInteger(insertedId) ? insertedId : null,
                type: q.type,
                content_cn: q.content_cn,
                content_en: q.content_en,
                options: q.options,
                content_options_hash: q.content_options_hash,
                answer_cn: q.answer_cn,
                answer_en: q.answer_en,
                explanation_cn: q.explanation_cn,
                explanation_en: q.explanation_en,
                metadata: q.metadata || null,
                knowledge_point_id: kpId
            });
        }

        questionsOut = uniqueByContentOptionsHash(questionsOut).slice(0, n);
    }

    const lessonBilingual = {
        title_cn: `${gradeNameZh} ${subjectNameZh} ${kpNameCn || kpNameEn} 练习`.trim() || '知识点练习',
        title_en: `${gradeNameEn} ${subjectNameEn} ${kpNameEn || kpNameCn} Practice`.trim() || 'Knowledge Point Practice',
        explanation_cn: '针对当前知识点进行专项练习。',
        explanation_en: 'Targeted practice for this knowledge point.'
    };

    return res.json({
        generated: true,
        lesson: {
            title: useLang === 'zh' ? lessonBilingual.title_cn : lessonBilingual.title_en,
            explanation: useLang === 'zh' ? lessonBilingual.explanation_cn : lessonBilingual.explanation_en,
            title_cn: lessonBilingual.title_cn,
            title_en: lessonBilingual.title_en,
            explanation_cn: lessonBilingual.explanation_cn,
            explanation_en: lessonBilingual.explanation_en,
            images: []
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
            knowledge_point_id: kpId
        }))
    });
});



// Submit diagnostic answers and record attempts; upload wrong questions to Pinecone (with wrong_count computed)
app.post('/api/submit/diagnostic', async (req, res) => {
    const { token, answers, lesson: providedLesson, lang } = req.body;
    submitDiagnosticLog('payload:', { ...req.body, token: token ? '<redacted>' : null });
    if (!token || !Array.isArray(answers)) {
        submitDiagnosticLog('missing token or answers');
        return res.status(400).json({ error: 'token and answers required' });
    }
    const hasLessonQuestions = !!(providedLesson && Array.isArray(providedLesson.questions));
    if (!hasLessonQuestions && !useDb) {
        // In-memory mode has no authoritative questions table; must provide the questions.
        submitDiagnosticLog('missing questions in request body (required in-memory mode)');
        return res.status(400).json({ error: 'Missing lesson.questions in request body (required when DB is disabled)' });
    }

    try {
        const data = jwt.verify(token, JWT_SECRET);
        submitDiagnosticLog('token valid, user id:', data.id);
        const useLang = (lang === 'zh') ? 'zh' : 'en';

        // Build question lookup:
        // - In DB mode, ALWAYS fetch from questions table by ids (authoritative)
        // - In memory mode, require lesson.questions
        let questions = [];
        const ids = answers
            .map(a => (a && a.questionId != null ? Number(a.questionId) : null))
            .filter(x => Number.isInteger(x));
        const uniqueIds = Array.from(new Set(ids));
        if (useDb) {
            submitDiagnosticLog('DB mode: fetching questions from DB, uniqueIds =', uniqueIds.length);
            if (!uniqueIds.length) {
                return res.status(400).json({ error: 'answers.questionId required' });
            }
            try {
                const r = await pool.query(
                    `SELECT id, grade_id, subject_id, content_cn, content_en, options, content_options_hash,
                            metadata, answer_cn, answer_en, explanation_cn, explanation_en, knowledge_point_id, created_at
                     FROM questions
                     WHERE id = ANY($1::int[])`,
                    [uniqueIds]
                );
                questions = r.rows.map(row => ({
                    id: row.id != null ? Number(row.id) : null,
                    grade_id: row.grade_id != null ? Number(row.grade_id) : null,
                    subject_id: row.subject_id != null ? Number(row.subject_id) : null,
                    content_cn: row.content_cn != null ? String(row.content_cn) : '',
                    content_en: row.content_en != null ? String(row.content_en) : '',
                    content_options_hash: row.content_options_hash != null ? String(row.content_options_hash) : null,
                    metadata: row.metadata || null,
                    options_bilingual: (() => {
                        try {
                            const parsed = typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
                            return extractBilingualOptions(parsed) || null;
                        } catch {
                            return null;
                        }
                    })(),
                    answer_cn: row.answer_cn != null ? String(row.answer_cn) : '',
                    answer_en: row.answer_en != null ? String(row.answer_en) : '',
                    explanation_cn: row.explanation_cn != null ? String(row.explanation_cn) : '',
                    explanation_en: row.explanation_en != null ? String(row.explanation_en) : '',
                    knowledge_point_id: row.knowledge_point_id != null ? Number(row.knowledge_point_id) : null,
                    question_created_at: row.created_at ? new Date(row.created_at).toISOString() : null
                }));
                const found = new Set(questions.map(q => Number(q.id)).filter(x => Number.isInteger(x)));
                const missing = uniqueIds.filter(id => !found.has(id));
                submitDiagnosticLog('fetched questions from DB, count =', questions.length, 'missing =', missing.length);
                if (missing.length) submitDiagnosticLog('missing ids (first 10):', missing.slice(0, 10));
            } catch (e) {
                submitDiagnosticLog('DB fetch questions failed:', e && e.message ? e.message : e);
                return res.status(500).json({ error: 'Failed to load questions from DB' });
            }
        } else {
            questions = (hasLessonQuestions ? providedLesson.questions : []) || [];
            submitDiagnosticLog('in-memory mode: using lesson.questions, count =', questions.length);
        }

        const questionById = new Map();
        for (const q of questions) {
            if (!q || q.id == null) continue;
            questionById.set(String(q.id), q);
        }

        const results = [];

        for (const a of answers) {
            const qid = (a && a.questionId != null) ? String(a.questionId) : '';
            const q = questionById.get(qid);
            if (!q) {
                submitDiagnosticLog('question not found for answer:', a);
                continue;
            }
            const correctAnswer = (useLang === 'zh' ? (q.answer_cn || q.answer || '') : (q.answer_en || q.answer || '')).toString().trim();
            const given = (a.answer || '').toString().trim();
            const correct = correctAnswer.toLowerCase() === given.toLowerCase();
            const createdAt = new Date().toISOString();
            submitDiagnosticLog('answer:', { questionId: q.id, given, correctAnswer, correct });

            if (useDb) {
                try {
                    await pool.query(
                        'INSERT INTO history(user_id, question_id, given_answer, correct, created_at) VALUES($1,$2,$3,$4,$5)',
                        [data.id, Number(q.id), given, correct, createdAt]
                    );
                    submitDiagnosticLog('history inserted to DB:', { userId: data.id, questionId: q.id, given, correct, createdAt });
                } catch (e) {
                    submitDiagnosticLog('history insert error:', e && e.message ? e.message : e);
                }
            } else {
                history[data.id] = history[data.id] || [];
                history[data.id].push({ questionId: q.id, givenAnswer: given, correct, correctAnswer, created_at: createdAt, timestamp: Date.now() });
                submitDiagnosticLog('history inserted to memory:', { userId: data.id, questionId: q.id, given, correct, createdAt });
            }

            const contentOut = useLang === 'zh'
                ? ((q.content_cn != null ? q.content_cn : q.content) || '')
                : ((q.content_en != null ? q.content_en : q.content) || '');
            const explanationOut = useLang === 'zh'
                ? ((q.explanation_cn != null ? q.explanation_cn : q.explanation) || '')
                : ((q.explanation_en != null ? q.explanation_en : q.explanation) || '');
            results.push({
                questionId: q.id,
                correct,
                given,
                correctAnswer,
                content_cn: q.content_cn != null ? String(q.content_cn) : '',
                content_en: q.content_en != null ? String(q.content_en) : '',
                answer_cn: (q.answer_cn || q.answer || '').toString().trim(),
                answer_en: (q.answer_en || q.answer || '').toString().trim(),
                explanation_cn: q.explanation_cn != null ? String(q.explanation_cn) : '',
                explanation_en: q.explanation_en != null ? String(q.explanation_en) : '',
                explanation: explanationOut,
                content: contentOut,
                knowledge_point_id: q.knowledge_point_id,
                created_at: createdAt,
                question_created_at: q.question_created_at || null
            });
        }

        submitDiagnosticLog('returning result:', { success: true, total: results.length, answers: results });
        return res.json({ success: true, total: results.length, answers: results });
    } catch (e) {
        submitDiagnosticLog('error caught:', e && e.message ? e.message : e);
        return res.status(401).json({ error: 'Invalid token' });
    }
});


// Full history view (DB join with questions), newest first. Optional fuzzy filter via ?q=
app.get('/api/history/full', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const qText = (req.query && req.query.q != null) ? String(req.query.q) : '';
    const like = qText ? `%${qText}%` : null;
    try {
        const token = auth.replace('Bearer ', '');
        const data = jwt.verify(token, JWT_SECRET);
        if (!useDb) {
            // In-memory fallback: return what we have (no questions table)
            const userHistory = history[data.id] || [];
            const filtered = like
                ? userHistory.filter(h => JSON.stringify(h).toLowerCase().includes(String(qText).toLowerCase()))
                : userHistory;
            const sorted = filtered.slice().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
            return res.json({ history: sorted });
        }

        // DB mode: resolve all user ids under same username (keep consistent with /api/history)
        const r = await pool.query('SELECT username FROM users WHERE id=$1', [data.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
        const username = r.rows[0].username;
        const userIds = await getUserIdsByUsername(username);
        if (!userIds.length) return res.json({ history: [] });

        const params = [userIds];
        let sql =
            `SELECT h.user_id,
                    h.question_id as "questionId",
                    h.given_answer as "givenAnswer",
                    h.correct,
                    h.created_at,
                    q.content_cn,
                    q.content_en,
                    q.answer_cn,
                    q.answer_en,
                    q.explanation_cn,
                    q.explanation_en,
                    q.knowledge_point_id,
                  kp.name_cn AS knowledge_point_name_cn,
                  kp.name_en AS knowledge_point_name_en,
                    q.grade_id,
                    q.subject_id
             FROM history h
             JOIN questions q ON q.id = h.question_id
              LEFT JOIN knowledge_points kp ON kp.id = q.knowledge_point_id
             WHERE h.user_id = ANY($1::int[])`;

        if (like) {
            params.push(like);
            const p = `$${params.length}`;
            sql += ` AND (
                        COALESCE(q.content_cn,'') ILIKE ${p}
                     OR COALESCE(q.content_en,'') ILIKE ${p}
                     OR COALESCE(q.explanation_cn,'') ILIKE ${p}
                     OR COALESCE(q.explanation_en,'') ILIKE ${p}
                     OR COALESCE(h.given_answer,'') ILIKE ${p}
                     OR COALESCE(q.answer_cn,'') ILIKE ${p}
                     OR COALESCE(q.answer_en,'') ILIKE ${p}
                                         OR COALESCE(kp.name_cn,'') ILIKE ${p}
                                         OR COALESCE(kp.name_en,'') ILIKE ${p}
                                         OR COALESCE(CAST(q.knowledge_point_id AS TEXT),'') ILIKE ${p}
                   )`;
        }
        sql += ' ORDER BY h.created_at DESC LIMIT 500';

        const r2 = await pool.query(sql, params);
        return res.json({ history: r2.rows });
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
});


// Knowledge point scores (accuracy %) grouped by grade + subject + knowledge_point_id
// score = correct_count / total_count * 100
app.get('/api/scores/knowledge-points', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    if (!useDb) return res.json({ items: [] });

    const gradeId = (req.query && req.query.grade_id != null) ? Number(req.query.grade_id) : null;
    const subjectId = (req.query && req.query.subject_id != null) ? Number(req.query.subject_id) : null;

    try {
        const token = auth.replace('Bearer ', '');
        const data = jwt.verify(token, JWT_SECRET);

        // Keep consistent with /api/history: merge all user ids under same username.
        let userIds = [data.id];
        try {
            const rUser = await pool.query('SELECT username FROM users WHERE id=$1', [data.id]);
            const username = (rUser.rows[0] && rUser.rows[0].username) ? String(rUser.rows[0].username) : null;
            if (username) {
                const ids = await getUserIdsByUsername(username);
                if (Array.isArray(ids) && ids.length) userIds = ids;
            }
        } catch (e) {
            userIds = [data.id];
        }

        const params = [userIds];
        let where = 'h.user_id = ANY($1::int[])';
        if (Number.isInteger(gradeId)) {
            params.push(gradeId);
            where += ` AND q.grade_id = $${params.length}`;
        }
        if (Number.isInteger(subjectId)) {
            params.push(subjectId);
            where += ` AND q.subject_id = $${params.length}`;
        }

        const r = await pool.query(
            `SELECT
                q.grade_id,
                g.name_zh AS grade_name_zh,
                g.name_en AS grade_name_en,
                q.subject_id,
                s.name_zh AS subject_name_zh,
                s.name_en AS subject_name_en,
                q.knowledge_point_id,
                kp.name_cn AS knowledge_point_name_cn,
                kp.name_en AS knowledge_point_name_en,
                COUNT(*)::int AS total,
                SUM(CASE WHEN h.correct THEN 1 ELSE 0 END)::int AS correct
             FROM history h
             JOIN questions q ON q.id = h.question_id
             LEFT JOIN grades g ON g.id = q.grade_id
             LEFT JOIN subjects s ON s.id = q.subject_id
             LEFT JOIN knowledge_points kp ON kp.id = q.knowledge_point_id
             WHERE ${where}
               AND q.grade_id IS NOT NULL
               AND q.subject_id IS NOT NULL
               AND q.knowledge_point_id IS NOT NULL
             GROUP BY
                q.grade_id, g.name_zh, g.name_en,
                q.subject_id, s.name_zh, s.name_en,
                q.knowledge_point_id, kp.name_cn, kp.name_en
             ORDER BY q.grade_id ASC, q.subject_id ASC, q.knowledge_point_id ASC`,
            params
        );

        const items = (r.rows || []).map(row => {
            const { total, correct, score_percent } = computeScorePercent(row.correct, row.total);
            return {
                grade_id: row.grade_id != null ? Number(row.grade_id) : null,
                grade_name_zh: row.grade_name_zh != null ? String(row.grade_name_zh) : '',
                grade_name_en: row.grade_name_en != null ? String(row.grade_name_en) : '',
                subject_id: row.subject_id != null ? Number(row.subject_id) : null,
                subject_name_zh: row.subject_name_zh != null ? String(row.subject_name_zh) : '',
                subject_name_en: row.subject_name_en != null ? String(row.subject_name_en) : '',
                knowledge_point_id: row.knowledge_point_id != null ? Number(row.knowledge_point_id) : null,
                knowledge_point_name_cn: row.knowledge_point_name_cn != null ? String(row.knowledge_point_name_cn) : '',
                knowledge_point_name_en: row.knowledge_point_name_en != null ? String(row.knowledge_point_name_en) : '',
                total,
                correct,
                score_percent
            };
        });

        return res.json({ items });
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
});

// Fetch questions by ids (DB mode only). Used by Results page for zh/en switching.
app.get('/api/questions/by-ids', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    if (!useDb) return res.status(400).json({ error: 'DB disabled' });
    const raw = (req.query && req.query.ids != null) ? String(req.query.ids) : '';
    const ids = raw
        .split(',')
        .map(s => Number(String(s).trim()))
        .filter(x => Number.isInteger(x));
    const uniqueIds = Array.from(new Set(ids)).slice(0, 300);
    if (!uniqueIds.length) return res.status(400).json({ error: 'ids required' });

    try {
        const token = auth.replace('Bearer ', '');
        jwt.verify(token, JWT_SECRET);
        const r = await pool.query(
            `SELECT id, content_cn, content_en, options, answer_cn, answer_en, explanation_cn, explanation_en, knowledge_point_id, created_at
             FROM questions
             WHERE id = ANY($1::int[])`,
            [uniqueIds]
        );
        return res.json({ questions: r.rows });
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
});


// 查询所有同email用户的历史
app.get('/api/history', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const token = auth.replace('Bearer ', '');
        const data = jwt.verify(token, JWT_SECRET);
        let username = null;
        if (useDb) {
            const r = await pool.query('SELECT username FROM users WHERE id=$1', [data.id]);
            if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
            username = r.rows[0].username;
            const userIds = await getUserIdsByUsername(username);
            if (!userIds.length) return res.json({ history: [] });
            const r2 = await pool.query(`SELECT question_id as "questionId", given_answer as "givenAnswer", correct, created_at FROM history WHERE user_id = ANY($1::int[]) ORDER BY created_at DESC LIMIT 100`, [userIds]);
            return res.json({ history: r2.rows });
        }
        // 内存模式
        username = users[data.id]?.username;
        if (!username) return res.status(404).json({ error: 'User not found' });
        const ids = Object.values(users).filter(u => u.username === username).map(u => u.id);
        let all = [];
        for (const id of ids) {
            all = all.concat(history[id] || []);
        }
        all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        return res.json({ history: all.slice(0, 100) });
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`AI Learning backend listening on http://localhost:${PORT}`);
    });
} else {
    module.exports = app;
}
