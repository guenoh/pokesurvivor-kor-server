import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, tokenHash } from './auth.js';
import { listNotices, claimNotice, noticeConfig, grantAutomaticRewards } from './notices.js';
import { createCommunity } from './community.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
function validSave(value, depth = 0) {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(v => validSave(v, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.entries(value).every(([k, v]) => !['__proto__', 'constructor', 'prototype'].includes(k) && validSave(v, depth + 1));
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'JSON 요청만 지원합니다.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) fail(413, '저장 데이터가 너무 큽니다.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, '잘못된 JSON입니다.'); }
}

export function createApp({ pool, origin, secureCookies = true, authLimit = 20, logger = console, notices = noticeConfig, clock = Date.now }) {
  if (!origin || new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be one exact origin without a trailing slash');
  const cookieName = secureCookies ? '__Host-pskor' : 'pskor_dev';
  const buckets = new Map();
  const cookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  function rateLimit(req) {
    // Deliberately ignore client-supplied X-Forwarded-For. Edge proxy should add its own per-IP limits.
    const key = req.socket.remoteAddress, now = Date.now();
    for (const [ip, b] of buckets) if (b.until <= now) buckets.delete(ip);
    let b = buckets.get(key);
    if (!b) { b = { n: 0, until: now + 15 * 60_000 }; buckets.set(key, b); }
    if (++b.n > authLimit) fail(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  }
  async function session(req) {
    const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!raw || !/^[a-f0-9]{64}$/.test(raw)) fail(401, '로그인이 필요합니다.');
    const result = await pool.query('SELECT a.id, a.name, a.password_hash, a.created_at FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now()', [tokenHash(raw)]);
    if (!result.rows[0]) fail(401, '다시 로그인해 주세요.');
    return { ...result.rows[0], token: tokenHash(raw) };
  }
  async function openSession(res, account) {
    await grantAutomaticRewards(pool, account, notices, clock());
    const token = randomBytes(32).toString('hex');
    await pool.query('DELETE FROM sessions WHERE expires_at<=now()');
    await pool.query('INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)', [tokenHash(token), account.id, new Date(Date.now() + 7 * 86400_000)]);
    res.setHeader('Set-Cookie', cookie(token, 7 * 86400));
    const { rows } = await pool.query('SELECT data,revision FROM saves WHERE account_id=$1', [account.id]);
    return { user: { id: account.id, name: account.name }, save: rows[0].data, revision: rows[0].revision };
  }
  const community = createCommunity({ pool, origin, session, clock, logger });
  const app = http.createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, origin), route = `${req.method} ${url.pathname}`;
      if (req.headers.origin && req.headers.origin !== origin) fail(403, '허용되지 않은 출처입니다.');
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) fail(403, '출처 확인에 실패했습니다.');
      if (route === 'GET /api/health') {
        await pool.query('SELECT 1'); return send(200, { ok: true });
      }
      if (route === 'POST /api/auth/register' || route === 'POST /api/auth/login') {
        rateLimit(req);
        const data = await body(req), name = typeof data?.name === 'string' ? data.name.trim().normalize('NFKC') : '';
        const password = data?.password;
        if (!/^[\p{L}\p{N}_]{3,16}$/u.test(name) || typeof password !== 'string' || password.length < 4 || password.length > 128) fail(400, '이름은 3~16자, 비밀번호는 4~128자로 입력해 주세요.');
        const nameKey = name.toLocaleLowerCase('en-US');
        if (route.endsWith('/register')) {
          const hash = await hashPassword(password), id = randomUUID();
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('INSERT INTO accounts(id,name,name_key,password_hash) VALUES($1,$2,$3,$4)', [id, name, nameKey, hash]);
            await client.query('INSERT INTO saves(account_id) VALUES($1)', [id]);
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK');
            if (e.code === '23505') fail(409, '이미 사용 중인 이름입니다.');
            throw e;
          } finally { client.release(); }
          return send(201, await openSession(res, { id, name }));
        }
        const { rows } = await pool.query('SELECT id,name,password_hash FROM accounts WHERE name_key=$1', [nameKey]);
        // Equal-cost password work for unknown users.
        const encoded = rows[0]?.password_hash || '00000000000000000000000000000000:' + '00'.repeat(64);
        const valid = await verifyPassword(password, encoded);
        if (!rows[0] || !valid) fail(401, '이름 또는 비밀번호가 올바르지 않습니다.');
        return send(200, await openSession(res, rows[0]));
      }
      if (route === 'GET /api/notices') {
        let account = null;
        try { account = await session(req); } catch (e) { if (e.status !== 401) throw e; }
        return send(200, await listNotices(pool, account, notices, clock()));
      }
      const claim = route.match(/^POST \/api\/notices\/([a-z0-9-]+)\/claim$/);
      if (claim) {
        const account = await session(req), data = await body(req);
        return send(200, await claimNotice(pool, account, claim[1], data?.revision, notices, clock()));
      }
      if (url.pathname === '/api/community' || url.pathname.startsWith('/api/community/')) {
        const account = await session(req);
        community.live.rate(account.id, 'http', 90, 60000);
        const data = ['POST', 'PUT'].includes(req.method) ? await body(req) : undefined;
        return send(200, await community.handle(req, account, url, data));
      }
      const supported = ['GET /api/session', 'GET /api/save', 'PUT /api/save', 'POST /api/auth/logout', 'DELETE /api/account'];
      if (!supported.includes(route)) fail(404, '찾을 수 없습니다.');
      const account = await session(req);
      if (route === 'GET /api/session' || route === 'GET /api/save') {
        await grantAutomaticRewards(pool, account, notices, clock());
        const { rows } = await pool.query('SELECT data,revision FROM saves WHERE account_id=$1', [account.id]);
        return send(200, { user: { id: account.id, name: account.name }, save: rows[0].data, revision: rows[0].revision });
      }
      if (route === 'PUT /api/save') {
        const data = await body(req);
        if (data?.accountId !== undefined && data.accountId !== account.id) fail(403, '다른 창에서 로그인 계정이 바뀌었습니다. 현재 기기의 백업을 내보낸 뒤 다시 로그인해 주세요.');
        if (!Number.isSafeInteger(data?.revision) || data.revision < 0 || !data.save || typeof data.save !== 'object' || Array.isArray(data.save) || !validSave(data.save)) fail(400, '올바르지 않은 저장 데이터입니다.');
        const result = await pool.query('UPDATE saves SET data=$1,revision=revision+1,updated_at=now() WHERE account_id=$2 AND revision=$3 RETURNING revision', [JSON.stringify(data.save), account.id, data.revision]);
        if (!result.rows[0]) fail(409, '다른 기기에서 저장되었습니다. 현재 데이터를 백업한 뒤 다시 로그인해 주세요.');
        return send(200, { revision: result.rows[0].revision });
      }
      if (route === 'DELETE /api/account') {
        const data = await body(req);
        if (typeof data?.password !== 'string' || data.password.length > 128 || !await verifyPassword(data.password, account.password_hash)) fail(401, '비밀번호가 올바르지 않습니다.');
        const peers = (await community.live.snapshot(account)).friends.map(f => f.uid);
        await pool.query('DELETE FROM survival_records WHERE id IN (SELECT record_id FROM record_members WHERE account_id=$1)', [account.id]);
        await pool.query('DELETE FROM accounts WHERE id=$1', [account.id]);
        community.live.disconnect(account.id);
        await community.live.refresh(peers);
      } else await pool.query('DELETE FROM sessions WHERE token_hash=$1', [account.token]);
      community.live.disconnect(account.id, account.token);
      res.setHeader('Set-Cookie', cookie('', 0));
      return send(200, { ok: true });
    } catch (e) {
      if (!e.status) logger.error('API request failed', { code: e.code || 'internal' });
      if (!res.headersSent) send(e.status || 503, { error: e.status ? e.message : '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' });
      else res.end();
    }
  });
  community.live.attach(app);
  app.community = community;
  return app;
}
