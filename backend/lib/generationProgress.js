'use strict';

const crypto = require('crypto');

const jobs = new Map();
const TTL_MS = 30 * 60 * 1000;

function pruneExpired() {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, job] of jobs.entries()) {
        if (job.updatedAt < cutoff) jobs.delete(id);
    }
}

function createGenerationProgress({ userId, kind }) {
    pruneExpired();
    const id = crypto.randomUUID();
    const now = Date.now();
    const job = {
        id,
        userId: Number(userId),
        kind: kind === 'practice' ? 'practice' : 'diagnostic',
        stage: 'queued',
        percent: 2,
        message: 'Queued',
        createdAt: now,
        updatedAt: now,
    };
    jobs.set(id, job);
    return publicJob(job);
}

function updateGenerationProgress(id, userId, patch) {
    if (!id) return null;
    const job = jobs.get(String(id));
    if (!job || job.userId !== Number(userId)) return null;

    const nextPercent = Number(patch && patch.percent);
    if (Number.isFinite(nextPercent)) {
        job.percent = Math.max(job.percent, Math.min(100, Math.max(0, Math.round(nextPercent))));
    }
    if (patch && patch.stage) job.stage = String(patch.stage);
    if (patch && patch.message) job.message = String(patch.message);
    if (patch && patch.error) job.error = String(patch.error);
    job.updatedAt = Date.now();
    return publicJob(job);
}

function getGenerationProgress(id, userId) {
    pruneExpired();
    const job = jobs.get(String(id));
    if (!job || job.userId !== Number(userId)) return null;
    return publicJob(job);
}

function publicJob(job) {
    return {
        id: job.id,
        kind: job.kind,
        stage: job.stage,
        percent: job.percent,
        message: job.message,
        error: job.error || null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
    };
}

module.exports = {
    createGenerationProgress,
    updateGenerationProgress,
    getGenerationProgress,
};
