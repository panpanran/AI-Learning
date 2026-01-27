

// Pinecone SDK 客户端，兼容 queryByVector 调用
const { Pinecone } = require('@pinecone-database/pinecone');
const indexName = process.env.PINECONE_INDEX_NAME || process.env.PINECONE_INDEX;
const embedModel = process.env.PINECONE_EMBED_MODEL || 'llama-text-embed-v2';
const client = process.env.PINECONE_API_KEY
    ? new Pinecone({ apiKey: process.env.PINECONE_API_KEY })
    : new Pinecone();

async function embedTexts(texts, inputType = 'passage') {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    if (!client || !client.inference || typeof client.inference.embed !== 'function') {
        throw new Error('Pinecone inference.embed not available');
    }
    const resp = await client.inference.embed(embedModel, texts, {
        inputType,
        truncate: 'END'
    });
    const data = (resp && resp.data) ? resp.data : [];
    return data.map(d => (d && Array.isArray(d.values) ? d.values : []));
}

async function describeIndexStats() {
    if (!indexName) throw new Error('PINECONE_INDEX_NAME not set');
    const index = client.index(indexName);
    if (!index || typeof index.describeIndexStats !== 'function') {
        throw new Error('Pinecone index.describeIndexStats not available');
    }
    return await index.describeIndexStats();
}

async function upsertVectors(vectors) {
    if (!indexName) throw new Error('PINECONE_INDEX_NAME not set');
    const index = client.index(indexName);
    if (!index || typeof index.upsert !== 'function') {
        throw new Error('Pinecone index.upsert not available');
    }
    if (!Array.isArray(vectors)) {
        throw new Error('upsertVectors expects an array of records');
    }

    const sanitizeMetadata = (md) => {
        if (!md || typeof md !== 'object' || Array.isArray(md)) return null;
        const out = {};
        for (const [k, v] of Object.entries(md)) {
            if (!k) continue;
            if (v === null || v === undefined) continue;
            out[k] = v;
        }
        return Object.keys(out).length ? out : null;
    };

    const safeVectors = vectors.map((r) => {
        const rec = (r && typeof r === 'object') ? r : {};
        const md = sanitizeMetadata(rec.metadata);
        if (!md) {
            const { metadata, ...rest } = rec;
            return rest;
        }
        return { ...rec, metadata: md };
    });

    return await index.upsert(safeVectors);
}

async function queryByVector(vector, topK = 10, filter = null) {
    if (!indexName) throw new Error('PINECONE_INDEX_NAME not set');
    const index = client.index(indexName);
    const query = {
        vector,
        topK,
        includeMetadata: true,
        filter: filter || undefined,
    };
    return await index.query({ ...query });
}

async function listIndexes() {
    return await client.listIndexes();
}

module.exports = {
    queryByVector,
    upsertVectors,
    listIndexes,
    describeIndexStats,
    embedTexts,
    indexName,
    embedModel,
    _rawClient: client,
};
