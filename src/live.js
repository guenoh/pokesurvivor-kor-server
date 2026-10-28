import { randomUUID, randomInt } from 'node:crypto';
import { halloweenAt } from './event-calendar.js';
import { WebSocketServer, WebSocket } from 'ws';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const GRACE = 45000, INVITE_TTL = 180000;
function safe(value, depth = 0) {
  if (depth > 18) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 1024;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 1e10;
  if (Array.isArray(value)) return value.length <= 10000 && value.every(v => safe(v, depth + 1));
  return typeof value === 'object' && Object.keys(value).length <= 80 && Object.entries(value).every(([k, v]) => !['__proto__', 'constructor', 'prototype'].includes(k) && safe(v, depth + 1));
}
export function createLive({ origin, session, serial, friends, accepted, member, begin, clock, logger }) {
  const instances = new Map(), sockets = new Map(), rooms = new Map(), membership = new Map(), invites = new Map(), timers = new Map(), limits = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 384 * 1024, perMessageDeflate: false });
  const online = uid => sockets.get(uid)?.readyState === WebSocket.OPEN;
  const playing = uid => !!sockets.get(uid)?.playing;
  function send(uid, data) {
    const ws = sockets.get(uid);
    if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) ws.send(JSON.stringify(data));
  }
  function rate(uid, kind, max, window) {
    const key = uid + ':' + kind, now = clock();
    let b = limits.get(key);
    if (!b || now >= b.end) { b = { end: now + window, n: 0 }; limits.set(key, b); }
    if (++b.n > max) fail(429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  }
  function roomView(uid) {
    const room = rooms.get(membership.get(uid));
    return room ? { id: room.id, host: room.host, isHost: room.host === uid, playing: room.playing,
      members: [...room.members.values()].map(m => ({ ...m, online: !!online(m.uid), ready: !!sockets.get(m.uid)?.ready && !playing(m.uid) })) } : null;
  }
  function inbox(uid) {
    const list = invites.get(uid);
    if (!list) return [];
    for (const [from, invite] of list) if (clock() - invite.at > INVITE_TTL || !rooms.has(invite.room)) list.delete(from);
    return [...list.values()];
  }
  async function snapshot(account) {
    return { me: { uid: account.id, name: account.name }, friends: await friends(account.id), invites: inbox(account.id), room: roomView(account.id) };
  }
  async function refresh(uids) {
    for (const uid of new Set(uids)) {
      const ws = sockets.get(uid);
      if (ws) send(uid, { type: 'friends', friends: await friends(uid) });
    }
  }
  async function presence(uid) {
    const f = await friends(uid);
    for (const friend of f) if (friend.status === 'ok') send(friend.uid, { type: 'presence', uid, online: !!online(uid), play: playing(uid) });
  }
  function emitRoom(room) {
    for (const uid of room.members.keys()) send(uid, { type: 'room', room: roomView(uid) });
  }
  function leave(uid) {
    const room = rooms.get(membership.get(uid));
    if (!room) return;
    membership.delete(uid);
    if (room.host === uid) {
      rooms.delete(room.id);
      for (const u of room.members.keys()) { membership.delete(u); send(u, { type: 'room', room: null, closed: true }); }
      for (const [to, list] of invites) {
        if (list.delete(uid)) send(to, { type: 'invites', invites: inbox(to) });
      }
    } else {
      room.members.delete(uid); send(uid, { type: 'room', room: null }); emitRoom(room);
    }
  }
  function revoke(a, b) {
    for (const [to, from] of [[a, b], [b, a]]) {
      invites.get(to)?.delete(from); send(to, { type: 'invites', invites: inbox(to) });
    }
  }
  async function command(account, action, data) {
    const uid = account.id;
    rate(uid, 'control', 40, 10000);
    if (['invite', 'drop'].includes(action) && (typeof data.uid !== 'string' || data.uid.length > 64)) fail(400, '트레이너를 확인해 주세요.');
    if (['join', 'decline'].includes(action) && (typeof data.from !== 'string' || data.from.length > 64)) fail(400, '초대를 확인해 주세요.');
    if (action === 'leave') { leave(uid); return { ok: true }; }
    if (!online(uid)) fail(409, '실시간 서버에 연결한 뒤 다시 시도해 주세요.');
    let room = rooms.get(membership.get(uid));
    if (action === 'invite') {
      if (typeof data.uid !== 'string' || !await accepted(uid, data.uid)) fail(403, '친구에게만 협동 초대를 보낼 수 있습니다.');
      if (!online(data.uid)) fail(409, '친구가 접속한 뒤 초대해 주세요.');
      if (playing(data.uid)) fail(409, '친구가 현재 전투 중입니다.');
      if (room && room.host !== uid) fail(403, '방장만 친구를 초대할 수 있습니다.');
      if (room?.playing || room?.members.size >= 4) fail(409, '이미 시작했거나 가득 찬 대기실입니다.');
      if (!room) {
        room = { id: randomUUID(), host: uid, playing: false, members: new Map([[uid, await member(account)]]) };
        rooms.set(room.id, room); membership.set(uid, room.id); emitRoom(room);
      }
      const list = invites.get(data.uid) || new Map(); invites.set(data.uid, list);
      list.set(uid, { from: uid, name: account.name, room: room.id, at: clock() });
      send(data.uid, { type: 'invites', invites: inbox(data.uid) });
      return { ok: true, msg: '협동 초대를 보냈습니다.' };
    }
    if (action === 'decline') { invites.get(uid)?.delete(data.from); send(uid, { type: 'invites', invites: inbox(uid) }); return { ok: true }; }
    if (action === 'join') {
      const invite = inbox(uid).find(i => i.from === data.from), target = invite && rooms.get(invite.room);
      if (!target || !await accepted(uid, target.host)) fail(403, '초대가 만료되었습니다. 다시 초대해 주세요.');
      if (target.playing || target.members.size >= 4) fail(409, '이미 시작했거나 가득 찬 대기실입니다.');
      if (playing(uid)) fail(409, '전투를 끝낸 뒤 대기실에 들어와 주세요.');
      const m = await member(account);
      if (room && room.id !== target.id) leave(uid);
      target.members.set(uid, m); membership.set(uid, target.id);
      invites.delete(uid); send(uid, { type: 'invites', invites: [] }); emitRoom(target);
      return { ok: true };
    }
    if (!room) fail(404, '대기실이 없습니다. 친구를 초대해 주세요.');
    if (action === 'member') {
      if (!room.playing) { room.members.set(uid, await member(account)); emitRoom(room); }
      return { ok: true };
    }
    if (room.host !== uid) fail(403, '방장만 할 수 있습니다.');
    if (action === 'drop') {
      if (data.uid !== uid && room.members.has(data.uid)) leave(data.uid);
      return { ok: true };
    }
    if (action === 'reopen') { room.playing = false; emitRoom(room); return { ok: true }; }
    if (action === 'start') {
      if (room.playing || room.members.size < 2 || room.members.size > 4) fail(409, '2~4명이 대기실에 모여야 합니다.');
      if ([...room.members.keys()].some(u => !online(u) || playing(u) || !sockets.get(u)?.ready)) fail(409, '모든 친구가 연결되고 전투를 마칠 때까지 기다려 주세요.');
      // Load the saved selection for every participant, rather than trusting a client roster.
      const roster = [];
      for (const m of room.members.values()) roster.push(await member({ id: m.uid, name: m.name }));
      const runId = await begin(account, 'g', roster);
      room.members = new Map(roster.map(m => [m.uid, m])); room.playing = true;
      emitRoom(room);
      const cfg = { k: 'start', seed: randomInt(1000000), host: uid, hw: halloweenAt(clock()), members: roster };
      for (const u of room.members.keys()) {
        const ws = sockets.get(u); if (ws) ws.playing = true;
        send(u, { type: 'start', cfg, runId: u === uid ? runId : null });
      }
      return { ok: true };
    }
    fail(404, '지원하지 않는 대기실 요청입니다.');
  }
  function attach(app) {
    app.on('upgrade', async (req, socket, head) => {
      socket.on('error', () => {});
      try {
        const url = new URL(req.url, origin), instance = url.searchParams.get('instance') || randomUUID();
        if (url.pathname !== '/api/live' || req.url.length > 200 || !/^[a-f0-9-]{36}$/.test(instance) || req.headers.origin !== origin) fail(403, 'Forbidden');
        const account = await session(req);
        if (wss.clients.size >= 200 && !sockets.has(account.id)) fail(503, 'Busy');
        if (socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, ws => connect(ws, account, req, instance));
      } catch (e) { if (!socket.destroyed) socket.end(`HTTP/1.1 ${e.status || 503} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
    });
    app.on('close', close);
  }
  function connect(ws, account, req, instance) {
    const uid = account.id, old = sockets.get(uid);
    const resuming = (old?.instance || instances.get(uid)) === instance;
    if (!resuming && rooms.get(membership.get(uid))?.playing) leave(uid);
    instances.set(uid, instance);
    ws.instance = instance; ws.account = account; ws.playing = resuming ? !!old?.playing : false; ws.ready = false; ws.alive = true;
    ws.frames = 0; ws.bytes = 0; ws.window = clock(); ws.authAt = clock();
    clearTimeout(timers.get(uid)); timers.delete(uid);
    sockets.set(uid, ws);
    if (old) old.close(4001, '다른 창에서 접속했습니다.');
    ws.on('error', () => {});
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw, binary) => {
      if (binary) return ws.close(1003, 'JSON only');
      if (sockets.get(uid) !== ws) return;
      const now = clock();
      if (now - ws.window >= 1000) { ws.frames = 0; ws.bytes = 0; ws.window = now; }
      if (++ws.frames > 80 || (ws.bytes += raw.length) > 4 * 1024 * 1024) return ws.close(1008, 'Too many messages');
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return ws.close(1007, 'Invalid JSON'); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !safe(msg)) return ws.close(1008, 'Invalid frame');
      if (msg.type === 'presence') {
        try { rate(uid, 'presence', 20, 10000); } catch { ws.close(1008, 'Too many presence updates'); return; }
        const changed = ws.playing !== !!msg.playing, readyChanged = ws.ready !== !!msg.ready; ws.playing = !!msg.playing; ws.ready = !!msg.ready;
        const room = rooms.get(membership.get(uid)); if (room && (changed || readyChanged)) emitRoom(room);
        if (changed) serial(() => presence(uid)).catch(() => {});
        return;
      }
      const room = rooms.get(membership.get(uid));
      if (msg.type !== 'frame' || !room?.playing || !room.members.has(msg.to) || msg.to === uid || msg.message?.k !== 'f') return;
      // A star topology: guests can only talk to their host; only the host sends world state.
      if (uid !== room.host && msg.to !== room.host) return;
      if (uid !== room.host && (!Array.isArray(msg.message.p) || ['t', 'e', 'lv'].some(k => k in msg.message))) return;
      send(msg.to, { type: 'frame', from: uid, message: msg.message });
    });
    ws.on('close', () => {
      if (closed || sockets.get(uid) !== ws) return;
      sockets.delete(uid);
      const room = rooms.get(membership.get(uid)); if (room) emitRoom(room);
      serial(() => presence(uid)).catch(() => {});
      timers.set(uid, setTimeout(() => {
        timers.delete(uid);
        serial(() => { if (!online(uid)) { leave(uid); instances.delete(uid); } }).catch(() => {});
      }, GRACE).unref());
    });
    serial(async () => {
      send(uid, { type: 'snapshot', ...await snapshot(account) });
      const room = rooms.get(membership.get(uid)); if (room) emitRoom(room);
      await presence(uid);
    }).catch(() => ws.close(1011, '다시 연결해 주세요.'));
    ws.request = req;
  }
  const heartbeat = setInterval(() => {
    const now = clock();
    for (const [key, b] of limits) if (now > b.end) limits.delete(key);
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
      if (now - ws.authAt >= 60000) {
        ws.authAt = now;
        session(ws.request).then(a => { if (a.id !== ws.account.id) ws.close(4003, '다시 로그인해 주세요.'); }).catch(() => ws.close(4003, '다시 로그인해 주세요.'));
      }
    }
    for (const uid of invites.keys()) { const list = inbox(uid); if (!list.length) invites.delete(uid); }
  }, 25000); heartbeat.unref();
  function disconnect(uid, token) {
    const ws = sockets.get(uid);
    if (ws && (!token || ws.account.token === token)) { leave(uid); ws.close(4003, '로그아웃했습니다.'); }
  }
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    clearInterval(heartbeat);
    for (const t of timers.values()) clearTimeout(t);
    for (const ws of wss.clients) ws.terminate();
    wss.close(); instances.clear(); rooms.clear(); membership.clear(); invites.clear();
  }
  return { attach, close, snapshot, refresh, revoke, command, online, playing, disconnect, rate };
}
