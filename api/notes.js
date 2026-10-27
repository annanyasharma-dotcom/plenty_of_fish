// Shared sticky-note board for Plenty of Fish in the Sea.
// Vercel serverless function backed by Upstash Redis (added from Vercel's Storage tab / Marketplace).
//
//   GET    /api/notes                       -> { notes: [{ id, text, by, color, at }] }   newest first, max 300
//   POST   /api/notes  { text, by, color, token }  -> { note }                             201
//   DELETE /api/notes  { id, token }        (or header x-admin-key: NOTES_ADMIN_KEY)       200 / 404
//
// Env (set automatically by the Upstash integration): KV_REST_API_URL + KV_REST_API_TOKEN
// (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Optional: NOTES_ADMIN_KEY.

const crypto = require('crypto');

const MAX_TEXT = 220;
const MAX_BY = 40;
const MAX_NOTES = 300;
const COLORS = ['cream', 'lilac', 'coral', 'mint'];
const RATE_LIMIT = 5;          // notes per IP...
const RATE_WINDOW = 600;       // ...per 10 minutes
const DATA = 'pofs:notes:data';
const INDEX = 'pofs:notes:by-time';

function store() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function redis(db, commands) {
  const r = await fetch(db.url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + db.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!r.ok) throw new Error('store ' + r.status);
  const out = await r.json();
  return out.map(x => {
    if (x && x.error) throw new Error(x.error);
    return x ? x.result : null;
  });
}

const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function publicNote(n) {
  return { id: n.id, text: n.text, by: n.by, color: n.color, at: n.at };
}

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
  const db = store();
  if (!db) { res.status(503).json({ error: 'Notes storage is not connected yet.' }); return; }

  try {
    if (req.method === 'GET') {
      const [ids] = await redis(db, [['ZREVRANGE', INDEX, '0', String(MAX_NOTES - 1)]]);
      if (!ids || !ids.length) { res.status(200).json({ notes: [] }); return; }
      const [rows] = await redis(db, [['HMGET', DATA, ...ids]]);
      const notes = [];
      for (const row of rows || []) {
        if (!row) continue;
        try { notes.push(publicNote(JSON.parse(row))); } catch (e) { /* skip a bad row */ }
      }
      res.status(200).json({ notes });
      return;
    }

    if (req.method === 'POST') {
      const b = readBody(req);
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      const by = typeof b.by === 'string' ? b.by.trim().slice(0, MAX_BY) : '';
      const color = COLORS.includes(b.color) ? b.color : 'cream';
      const token = typeof b.token === 'string' ? b.token.slice(0, 200) : '';
      if (!text || text.length > MAX_TEXT) { res.status(400).json({ error: `Notes are 1 to ${MAX_TEXT} characters.` }); return; }

      const rlKey = 'pofs:rl:' + hash(clientIp(req)).slice(0, 32);
      const [count] = await redis(db, [['INCR', rlKey], ['EXPIRE', rlKey, String(RATE_WINDOW), 'NX']]);
      if (Number(count) > RATE_LIMIT) { res.status(429).json({ error: 'Too many notes. Try again in a few minutes.' }); return; }

      const note = { id: 'n' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex'), text, by, color, at: Date.now(),
        tokenHash: token ? hash(token) : '' };
      await redis(db, [['HSET', DATA, note.id, JSON.stringify(note)], ['ZADD', INDEX, String(note.at), note.id]]);

      // keep the board to the newest MAX_NOTES
      const [total] = await redis(db, [['ZCARD', INDEX]]);
      if (Number(total) > MAX_NOTES) {
        const [old] = await redis(db, [['ZRANGE', INDEX, '0', String(Number(total) - MAX_NOTES - 1)]]);
        if (old && old.length) await redis(db, [['ZREM', INDEX, ...old], ['HDEL', DATA, ...old]]);
      }
      res.status(201).json({ note: publicNote(note) });
      return;
    }

    if (req.method === 'DELETE') {
      const b = readBody(req);
      const id = typeof b.id === 'string' ? b.id.slice(0, 80) : '';
      if (!id) { res.status(400).json({ error: 'Missing note id.' }); return; }
      const [row] = await redis(db, [['HGET', DATA, id]]);
      if (!row) { res.status(404).json({ error: 'Note not found.' }); return; }
      const note = JSON.parse(row);
      const admin = process.env.NOTES_ADMIN_KEY;
      const isAdmin = Boolean(admin) && safeEqual(req.headers['x-admin-key'] || '', admin);
      const isAuthor = Boolean(note.tokenHash) && typeof b.token === 'string' && b.token && safeEqual(hash(b.token), note.tokenHash);
      if (!isAdmin && !isAuthor) { res.status(403).json({ error: 'You can only remove your own notes.' }); return; }
      await redis(db, [['ZREM', INDEX, id], ['HDEL', DATA, id]]);
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).json({ error: 'Method not allowed.' });
  } catch (e) {
    res.status(500).json({ error: 'The notes board is having a moment. Try again shortly.' });
  }
}

module.exports = handler;
