import { createService } from './service.mjs';

const CLOCK = '(SELECT COALESCE(MAX(revision), 0) FROM baduk_clock)';
const GUARD = CLOCK + ' = ?';
const localWakeups = new Map();
let localChange = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
};

function failure(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function errorMessage(error, id) {
  return {
    type: 'error', id, code: error.code ?? 'server_error',
    message: error.code ? error.message : '서버 연결을 확인해 주세요.',
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}

async function tokenHash(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw failure('invalid_token', '계정 접속 정보를 확인해 주세요.', 401);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
async function findAccount(db, hash) {
  const row = await db.prepare("SELECT body FROM baduk_entities WHERE kind='tokens' AND entity_id=? AND part=0").bind(hash).first();
  if (!row) throw failure('invalid_token', '이 계정의 접속 정보를 찾을 수 없습니다.', 401);
  return JSON.parse(row.body);
}

async function read(db, id, code, hash, receipt) {
  // Fetch only the actor, current or requested room, and the players in those rooms.
  const statements = [
    db.prepare('SELECT ' + CLOCK + ' AS revision'),
    db.prepare(`WITH room_ids(r) AS (
      SELECT ref_one FROM baduk_entities WHERE kind='accounts' AND entity_id=? AND part=0
      UNION SELECT ?
    ), member_ids(m) AS (
      SELECT ?
      UNION SELECT ref_one FROM baduk_entities WHERE kind='rooms' AND entity_id IN (SELECT r FROM room_ids) AND part=0
      UNION SELECT ref_two FROM baduk_entities WHERE kind='rooms' AND entity_id IN (SELECT r FROM room_ids) AND part=0
    )
    SELECT kind, entity_id, part, body FROM baduk_entities
      WHERE (kind='rooms' AND entity_id IN (SELECT r FROM room_ids))
      OR (kind='accounts' AND entity_id IN (SELECT m FROM member_ids))
      OR (kind='tokens' AND entity_id=?)
      ORDER BY kind,entity_id,part`).bind(id, code, id, hash),
    db.prepare('SELECT 1 AS seen FROM baduk_receipts WHERE account_id=? AND command_id=?').bind(id, receipt),
  ];
  const [clock, entities, receipts] = await db.batch(statements);
  const snapshot = { version: 1, accounts: {}, rooms: {}, tokens: {} };
  for (const row of entities.results) {
    const map = snapshot[row.kind];
    map[row.entity_id] = (map[row.entity_id] ?? '') + row.body;
  }
  for (const kind of ['accounts', 'rooms', 'tokens']) {
    for (const key of Object.keys(snapshot[kind])) snapshot[kind][key] = JSON.parse(snapshot[kind][key]);
  }
  return { snapshot, revision: clock.results[0].revision, duplicate: receipts.results.length > 0 };
}

function chunks(text) {
  // Parts fit comfortably below the D1 row limit, including UTF-8 Korean names.
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 16000);
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff && end < text.length) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

async function commit(db, before, after, revision, updates, receipt) {
  const statements = [];
  for (const kind of ['rooms', 'accounts', 'tokens']) {
    const keys = new Set([...Object.keys(before[kind]), ...Object.keys(after[kind])]);
    for (const key of keys) {
      const previous = before[kind][key], value = after[kind][key];
      const body = JSON.stringify(value);
      if (body === JSON.stringify(previous)) continue;
      if (previous !== undefined) {
        statements.push(db.prepare('DELETE FROM baduk_entities WHERE kind=? AND entity_id=? AND ' + GUARD).bind(kind, key, revision));
      }
      if (value === undefined) continue;
      const ref1 = kind === 'accounts' ? value.room : kind === 'rooms' ? value.players[1] : null;
      const ref2 = kind === 'rooms' ? value.players[2] : null;
      for (const [index, part] of chunks(body).entries()) {
        statements.push(db.prepare('INSERT INTO baduk_entities(kind,entity_id,part,ref_one,ref_two,body) SELECT ?,?,?,?,?,? WHERE ' + GUARD)
          .bind(kind, key, index, index === 0 ? ref1 : null, index === 0 ? ref2 : null, part, revision));
      }
    }
  }
  if (receipt) {
    statements.push(db.prepare('INSERT INTO baduk_receipts(account_id,command_id) SELECT ?,? WHERE ' + GUARD)
      .bind(receipt.accountId, receipt.id, revision));
  }
  if (!statements.length) return { success: true, cursor: revision };
  const cursor = revision + 1;
  for (const { accountId, message } of updates) {
    statements.push(db.prepare('INSERT INTO baduk_events(account_id,cursor,body) SELECT ?,?,? WHERE ' + GUARD)
      .bind(accountId, cursor, JSON.stringify({ ...message, cursor }), revision));
    statements.push(db.prepare(`DELETE FROM baduk_events WHERE account_id=? AND cursor <
      COALESCE((SELECT cursor FROM baduk_events WHERE account_id=? ORDER BY cursor DESC LIMIT 1 OFFSET 127),0)
      AND ` + GUARD).bind(accountId, accountId, revision));
  }
  // D1 executes a batch transactionally. Losing writers change zero rows in every statement.
  statements.push(db.prepare('INSERT INTO baduk_clock(id,revision) SELECT 1,? WHERE ' + GUARD
    + ' ON CONFLICT(id) DO UPDATE SET revision=excluded.revision').bind(cursor, revision));
  const results = await db.batch(statements);
  return { success: results.at(-1).meta.changes === 1, cursor };
}

function wake(accountId) {
  localChange++;
  for (const notify of localWakeups.get(accountId) ?? []) notify();
}
async function waitForEvent(id, ms) {
  let callbacks = localWakeups.get(id);
  if (!callbacks) localWakeups.set(id, callbacks = new Set());
  let notify, timer;
  try {
    await new Promise(resolve => {
      notify = resolve;
      callbacks.add(notify);
      timer = setTimeout(notify, ms);
    });
  } finally {
    // Clean up a request's timer in its own I/O context after a peer wakes it.
    clearTimeout(timer);
    callbacks.delete(notify);
    if (!callbacks.size) localWakeups.delete(id);
  }
}

async function transact(db, op, message, accountId = '', code = '') {
  const hash = op === 'hello' && message.token != null ? await tokenHash(message.token) : '';
  if (hash) accountId = await findAccount(db, hash);
  const wanted = typeof message?.code === 'string' ? message.code.trim().toUpperCase().slice(0,6) : code;
  const id = op === 'command' && typeof message?.id === 'string' ? message.id : '';
  for (let retry = 0; retry < 8; retry++) {
    const { snapshot, revision, duplicate } = await read(db, accountId, wanted, hash, id);
    const service = createService(snapshot);
    let output, updates = [], receipt = null;
    if (op === 'hello') {
      output = await service.hello(message);
    } else if (op === 'command' && duplicate) {
      return { reply: { type: 'ack', id }, updates: [], cursor: revision, pending: service.pendingBots() };
    } else if (op === 'command') {
      output = service.command(accountId, message);
      updates = output.updates;
      receipt = { accountId, id };
    } else {
      output = service.botStep(code);
      updates = output.updates;
    }
    const after = service.snapshot();
    // Command IDs have their own indexed table; past IDs don't inflate account rows.
    if (receipt) after.accounts[accountId].receipts = {};
    let result;
    try {
      result = await commit(db, snapshot, after, revision, updates, receipt);
    } catch (error) {
      // A randomly chosen invite code could already exist outside the scoped read.
      if (message?.op !== 'create' || !/UNIQUE constraint/i.test(error.message)) throw error;
      result = { success: false };
    }
    if (result.success) {
      for (const update of updates) wake(update.accountId);
      return { ...output, updates, cursor: result.cursor, pending: service.pendingBots() };
    }
    await sleep(8 + Math.random() * 22);
  }
  throw failure('server_busy', '대국 서버가 바쁩니다. 잠시 후 다시 시도해 주세요.', 503);
}

async function runBots(db, pending) {
  for (const code of new Set(pending)) {
    let again = true;
    for (let i = 0; again && i < 8; i++) {
      const move = await transact(db, 'bot', {}, '', code);
      again = move.pending.includes(code);
    }
  }
}
function continueBots(db, pending, ctx) {
  if (!pending.length) return;
  ctx.waitUntil((async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await runBots(db, pending); return; }
      catch { if (attempt < 2) await sleep(250 * (attempt + 1)); }
    }
  })());
}

async function events(db, id, after, timeout = 0, hub = false) {
  const end = Date.now() + timeout;
  for (;;) {
    const observed = localChange;
    const result = await db.prepare('SELECT cursor,body FROM baduk_events WHERE account_id=? AND cursor>? ORDER BY cursor LIMIT 32').bind(id, after).all();
    if (result.results.length) {
      return { events: result.results.map(row => JSON.parse(row.body)), cursor: result.results.at(-1).cursor };
    }
    const remaining = end - Date.now();
    if (remaining <= 0) return { events: [], cursor: after };
    if (observed === localChange) await waitForEvent(id, Math.min(hub ? 15000 : 850, remaining));
  }
}

function socketEndpoint(request, db, ctx, hub) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ type: 'error', code: 'upgrade_required' }, 426);
  if (typeof WebSocketPair !== 'function') return json({ type: 'error', code: 'websocket_unavailable' }, 501);
  const [client, socket] = Object.values(new WebSocketPair());
  socket.accept();
  let accountId = '', cursor = 0, closed = false, chain = Promise.resolve();
  function transmit(value) {
    if (!closed) socket.send(JSON.stringify(value));
  }
  async function flush() {
    const batch = await events(db, accountId, cursor);
    for (const event of batch.events) {
      if (event.cursor <= cursor) continue;
      transmit(event);
      cursor = event.cursor;
    }
    return batch.events.length;
  }
  async function deliver() {
    while (!closed) {
      const observed = localChange;
      const count = await flush();
      if (!count && !closed && observed === localChange) await waitForEvent(accountId, hub ? 15000 : 850);
    }
  }
  function terminate() {
    closed = true;
    if (accountId) wake(accountId);
    try { socket.close(1011, 'Reconnect'); } catch {}
  }
  socket.addEventListener('close', () => { closed = true; if (accountId) wake(accountId); });
  socket.addEventListener('error', terminate);
  socket.addEventListener('message', event => {
    chain = chain.then(async () => {
      let message;
      try {
        if (typeof event.data !== 'string' || event.data.length > 16384) throw failure('invalid_message', '메시지 크기를 확인해 주세요.');
        message = JSON.parse(event.data);
        if (!accountId) {
          if (message?.type !== 'hello') throw failure('unauthorized', '먼저 계정에 접속해 주세요.', 401);
          const result = await transact(db, 'hello', message);
          accountId = result.accountId;
          cursor = result.cursor;
          transmit({ ...result.message, cursor });
          ctx.waitUntil(deliver().catch(terminate));
          continueBots(db, result.pending, ctx);
        } else if (message.type === 'ping') {
          transmit({ type: 'pong' });
          await flush();
        } else {
          const result = await transact(db, 'command', message, accountId);
          transmit(result.reply);
          continueBots(db, result.pending, ctx);
        }
      } catch (error) {
        transmit(errorMessage(error, message?.id));
      }
    }).catch(terminate);
    ctx.waitUntil(chain);
  });
  return new Response(null, { status: 101, webSocket: client });
}

async function body(request) {
  const source = request.body?.getReader();
  if (!source) throw failure('invalid_request', '요청 내용을 확인해 주세요.');
  const decoder = new TextDecoder();
  let size = 0, text = '';
  for (;;) {
    const { value, done } = await source.read();
    if (done) break;
    size += value.length;
    if (size > 16384) { await source.cancel(); throw failure('too_large', '요청 크기가 너무 큽니다.', 413); }
    text += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); }
  catch { throw failure('invalid_request', '요청 내용을 확인해 주세요.'); }
}

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  let commandId;
  try {
    if (!env.DB) throw failure('storage_unavailable', '대국 저장소를 연결해 주세요.', 503);
    // Direct D1 queries use the primary, so independent sockets see committed moves.
    const db = env.DB;
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      await db.prepare('SELECT ' + CLOCK + ' AS revision').first();
      return json({ ok: true, service: 'baduk-online', websocket: typeof WebSocketPair === 'function', longPoll: true, durableHub: !!env.BADUK_HUB });
    }
    if (request.method === 'GET' && url.pathname === '/ws') return socketEndpoint(request, db, ctx, !!env.BADUK_HUB);
    if (request.method === 'POST' && url.pathname === '/api/hello') {
      const message = await body(request);
      if (message?.type !== 'hello') throw failure('invalid_hello', '먼저 접속 정보를 보내 주세요.');
      const result = await transact(db, 'hello', message);
      continueBots(db, result.pending, ctx);
      return json({ ...result.message, cursor: result.cursor });
    }
    if ((request.method === 'POST' && url.pathname === '/api/command') || (request.method === 'GET' && url.pathname === '/api/events')) {
      const header = request.headers.get('Authorization') ?? '';
      const hash = await tokenHash(header.startsWith('Bearer ') ? header.slice(7) : '');
      const id = await findAccount(db, hash);
      if (url.pathname === '/api/command') {
        const message = await body(request);
        commandId = message?.id;
        const result = await transact(db, 'command', message, id);
        continueBots(db, result.pending, ctx);
        const own = result.updates.filter(update => update.accountId === id).map(update => ({ ...update.message, cursor: result.cursor }));
        return json({ reply: result.reply, events: own, cursor: result.cursor });
      }
      const after = Number(url.searchParams.get('after') ?? 0);
      const wait = Number(url.searchParams.get('wait') ?? 15);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(wait)) throw failure('invalid_cursor', '상태 번호를 확인해 주세요.');
      return json(await events(db, id, after, Math.min(15, Math.max(0, wait)) * 1000, !!env.BADUK_HUB));
    }
    return json({ type: 'error', code: 'not_found' }, 404);
  } catch (error) {
    return json(errorMessage(error, commandId), error.status ?? (error.code === 'stale_revision' ? 409 : error.code ? 400 : 500));
  }
}

export class BadukHub {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  fetch(request) { return handleRequest(request, this.env, this.ctx); }
}
export default {
  fetch(request, env, ctx) {
    if (env.BADUK_HUB) return env.BADUK_HUB.get(env.BADUK_HUB.idFromName('baduk')).fetch(request);
    return handleRequest(request, env, ctx);
  },
};

