/*
  DB smoke test
  - Uses the same env loading as backend/index.js (../../.env.local from repo root)
  - Prints connection identity (no secrets)
  - Lists public tables and basic row counts

  Usage:
    cd backend
    node scripts/db_smoke.js
*/

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.local') });

const { Pool } = require('pg');

function safeText(v) {
    if (v == null) return null;
    return String(v);
}

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
    if (!connectionString) {
        console.error('Missing DATABASE_URL (or PG_CONNECTION_STRING).');
        process.exitCode = 2;
        return;
    }

    const pool = new Pool({ connectionString });

    try {
        const ident = await pool.query(
            `SELECT
         current_database() AS db,
         current_user AS user,
         inet_server_addr()::text AS server_addr,
         inet_server_port() AS server_port,
         version() AS version`
        );

        console.log('Connected:', {
            db: safeText(ident.rows[0]?.db),
            user: safeText(ident.rows[0]?.user),
            server_addr: safeText(ident.rows[0]?.server_addr),
            server_port: ident.rows[0]?.server_port ?? null,
        });

        const tablesRes = await pool.query(
            `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE'
       ORDER BY table_name ASC`
        );

        const tables = (tablesRes.rows || []).map(r => r.table_name);
        console.log('Public tables:', tables);

        // Best-effort counts (skip if table missing)
        const countTable = async (name) => {
            if (!tables.includes(name)) return null;
            const r = await pool.query(`SELECT COUNT(1)::int AS c FROM ${name}`);
            return r.rows[0]?.c ?? null;
        };

        const counts = {
            users: await countTable('users'),
            grades: await countTable('grades'),
            subjects: await countTable('subjects'),
            grade_subjects: await countTable('grade_subjects'),
            questions: await countTable('questions'),
            history: await countTable('history'),
        };

        console.log('Counts:', counts);
    } finally {
        await pool.end().catch(() => { });
    }
}

main().catch((e) => {
    console.error('db_smoke failed:', e && e.message ? e.message : String(e));
    process.exitCode = 1;
});
