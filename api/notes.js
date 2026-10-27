// Shared sticky-note board for Plenty of Fish in the Sea.
// Vercel serverless function. Stores notes in whichever database is connected to the Vercel project:
//   • Supabase / any Postgres (Vercel's Supabase integration sets POSTGRES_URL, with an optional prefix), or
//   • Upstash Redis (KV_REST_API_URL + KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL + _TOKEN).
// With Postgres, the tables are created automatically on first use (row-level security on, no public access).
//
//   GET    /api/notes                              -> { notes: [{ id, text, by, color, at }] }  newest first, max 300
//   POST   /api/notes  { text, by, color, token }  -> { note }  201
//   DELETE /api/notes  { id, token }  (or header x-admin-key: NOTES_ADMIN_KEY)  200 / 403 / 404
//   GET    /api/notes?health=1                     -> { ok, storage }  which database is in use

const crypto = require('crypto');

const MAX_TEXT = 220;
const MAX_BY = 40;
const MAX_NOTES = 300;
const COLORS = ['cream', 'lilac', 'coral', 'mint'];
const RATE_LIMIT = 5;            // notes per visitor...
const RATE_WINDOW_MS = 600000;   // ...per 10 minutes

const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// Find an env var by suffix, so integration prefixes (e.g. STORAGE_POSTGRES_URL) still work.
function envBySuffix(suffixes, exclude) {
  for (const suffix of suffixes) {
    if (process.env[suffix]) return process.env[suffix];
    const key = Object.keys(process.env).find(k => k.endsWith('_' + suffix) && !(exclude && exclude.test(k)) && process.env[k]);
    if (key) return process.env[key];
  }
  return '';
}

/* ---------------- Postgres (Supabase) ---------------- */
let pgPool = null, pgReady = null;
function postgres() {
  const url = envBySuffix(['POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'DATABASE_URL'], /PRISMA/);
  if (!url) return null;
  if (!pgPool) {
    const { Pool } = require('pg');
    // Managed Postgres certificates often fail strict verification in serverless runtimes; encrypt without verifying the chain.
    const conn = url.replace(/([?&])(sslmode|supa)=[^&]*/g, '$1').replace(/[?&]+$/, '').replace(/\?&/, '?');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(conn);
    pgPool = new Pool({ connectionString: conn, max: 1, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000,
      ssl: local ? false : { rejectUnauthorized: false } });
  }
  if (!pgReady) {
    pgReady = pgPool.query(`
      create table if not exists pofs_notes (
        id text primary key,
        body text not null,
        signed text not null default '',
        color text not null default 'cream',
        at bigint not null,
        token_hash text not null default ''
      );
      create index if not exists pofs_notes_at on pofs_notes (at desc);
      create table if not exists pofs_rate (
        visitor text primary key,
        window_start bigint not null,
        count integer not null
      );
      alter table pofs_notes enable row level security;
      alter table pofs_rate enable row level security;
    `).catch(e => { pgReady = null; throw e; });
  }
  const q = async (sql, params) => { await pgReady; return (await pgPool.query(sql, params)).rows; };
  return {
    name: 'postgres',
    async list() {
      const rows = await q('select id, body, signed, color, at from pofs_notes order by at desc limit $1', [MAX_NOTES]);
      return rows.map(r => ({ id: r.id, text: r.body, by: r.signed, color: r.color, at: Number(r.at) }));
    },
    async hit(visitor, now) {
      const rows = await q(`
        insert into pofs_rate (visitor, window_start, count) values ($1, $2, 1)
        on conflict (visitor) do update set
          count = case when pofs_rate.window_start < $3 then 1 else pofs_rate.count + 1 end,
          window_start = case when pofs_rate.window_start < $3 then excluded.window_start else pofs_rate.window_start end
        returning count`, [visitor, now, now - RATE_WINDOW_MS]);
      return Number(rows[0].count);
    },
    async add(n) {
      await q('insert into pofs_notes (id, body, signed, color, at, token_hash) values ($1, $2, $3, $4, $5, $6)',
        [n.id, n.text, n.by, n.color, n.at, n.tokenHash]);
      await q('delete from pofs_notes where id in (select id from pofs_notes order by at desc offset $1)', [MAX_NOTES]);
    },
    async get(id) {
      const rows = await q('select id, token_hash from pofs_notes where id = $1', [id]);
      return rows[0] ? { id: rows[0].id, tokenHash: rows[0].token_hash } : null;
    },
    async del(id) { await q('delete from pofs_notes where id = $1', [id]); }
  };
}

/* ---------------- Upstash Redis ---------------- */
function redisStore() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envBySuffix(['KV_REST_API_URL']);
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envBySuffix(['KV_REST_API_TOKEN']);
  if (!url || !token) return null;
  const DATA = 'pofs:notes:data', INDEX = 'pofs:notes:by-time';
  const run = async commands => {
    const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(commands)
    });
    if (!r.ok) throw new Error('store ' + r.status);
    return (await r.json()).map(x => { if (x && x.error) throw new Error(x.error); return x ? x.result : null; });
  };
  return {
    name: 'redis',
    async list() {
      const [ids] = await run([['ZREVRANGE', INDEX, '0', String(MAX_NOTES - 1)]]);
      if (!ids || !ids.length) return [];
      const [rows] = await run([['HMGET', DATA, ...ids]]);
      const out = [];
      for (const row of rows || []) { try { if (row) { const n = JSON.parse(row); out.push({ id: n.id, text: n.text, by: n.by, color: n.color, at: n.at }); } } catch (e) { /* skip */ } }
      return out;
    },
    async hit(visitor) {
      const key = 'pofs:rl:' + visitor;
      const [count] = await run([['INCR', key], ['EXPIRE', key, String(RATE_WINDOW_MS / 1000), 'NX']]);
      return Number(count);
    },
    async add(n) {
      await run([['HSET', DATA, n.id, JSON.stringify(n)], ['ZADD', INDEX, String(n.at), n.id]]);
      const [total] = await run([['ZCARD', INDEX]]);
      if (Number(total) > MAX_NOTES) {
        const [old] = await run([['ZRANGE', INDEX, '0', String(Number(total) - MAX_NOTES - 1)]]);
        if (old && old.length) await run([['ZREM', INDEX, ...old], ['HDEL', DATA, ...old]]);
      }
    },
    async get(id) { const [row] = await run([['HGET', DATA, id]]); return row ? JSON.parse(row) : null; },
    async del(id) { await run([['ZREM', INDEX, id], ['HDEL', DATA, id]]); }
  };
}

function storage() { return redisStore() || postgres(); }

/* ---------------- HTTP ---------------- */
function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}
function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  return (Array.isArray(f) ? f[0] : String(f || '')).split(',')[0].trim() || req.headers['x-real-ip'] || 'unknown';
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  let db;
  try { db = storage(); } catch (e) { db = null; }
  if (!db) { res.status(503).json({ error: 'Notes storage is not connected yet.' }); return; }

  try {
    if (req.method === 'GET') {
      if (req.query && req.query.health) { await db.list(); res.status(200).json({ ok: true, storage: db.name }); return; }
      res.status(200).json({ notes: await db.list() });
      return;
    }

    if (req.method === 'POST') {
      const b = readBody(req);
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      const by = typeof b.by === 'string' ? b.by.trim().slice(0, MAX_BY) : '';
      const color = COLORS.includes(b.color) ? b.color : 'cream';
      const token = typeof b.token === 'string' ? b.token.slice(0, 200) : '';
      if (!text || text.length > MAX_TEXT) { res.status(400).json({ error: `Notes are 1 to ${MAX_TEXT} characters.` }); return; }

      const now = Date.now();
      const count = await db.hit(hash(clientIp(req)).slice(0, 32), now);
      if (count > RATE_LIMIT) { res.status(429).json({ error: 'Too many notes. Try again in a few minutes.' }); return; }

      const note = { id: 'n' + now.toString(36) + crypto.randomBytes(5).toString('hex'), text, by, color, at: now,
        tokenHash: token ? hash(token) : '' };
      await db.add(note);
      res.status(201).json({ note: { id: note.id, text, by, color, at: now } });
      return;
    }

    if (req.method === 'DELETE') {
      const b = readBody(req);
      const id = typeof b.id === 'string' ? b.id.slice(0, 80) : '';
      if (!id) { res.status(400).json({ error: 'Missing note id.' }); return; }
      const note = await db.get(id);
      if (!note) { res.status(404).json({ error: 'Note not found.' }); return; }
      const admin = process.env.NOTES_ADMIN_KEY;
      const isAdmin = Boolean(admin) && safeEqual(req.headers['x-admin-key'] || '', admin);
      const isAuthor = Boolean(note.tokenHash) && typeof b.token === 'string' && b.token && safeEqual(hash(b.token), note.tokenHash);
      if (!isAdmin && !isAuthor) { res.status(403).json({ error: 'You can only remove your own notes.' }); return; }
      await db.del(id);
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).json({ error: 'Method not allowed.' });
  } catch (e) {
    console.error('notes api:', e && e.message);
    res.status(500).json({ error: 'The notes board is having a moment. Try again shortly.' });
  }
}

module.exports = handler;
