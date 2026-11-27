import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleRequest } from '../server/worker.mjs';

async function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../drizzle/0000_baduk.sql', import.meta.url), 'utf8'));
  function prepare(sql, args = []) {
    const stmt = sqlite.prepare(sql);
    return {
      bind: (...values) => prepare(sql, values),
      first: async () => stmt.get(...args),
      all: async () => ({ results: stmt.all(...args) }),
      execute: () => stmt.columns().length
        ? { results: stmt.all(...args), meta: { changes: 0 } }
        : { results: [], meta: stmt.run(...args) },
    };
  }
  return {
    sqlite, prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

async function httpSession(t) {
  const db = await database();
  const tasks = [];
  t.after(async () => { await Promise.all(tasks); db.sqlite.close(); });
  const ctx = { waitUntil: task => tasks.push(task) };
  async function invoke(path, payload, token) {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    const request = new Request('https://game.example' + path, {
      method: payload === undefined ? 'GET' : 'POST', headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const response = await handleRequest(request, { DB: db }, ctx);
    return { status: response.status, data: await response.json() };
  }
  const command = (token, op, fields, id = crypto.randomUUID()) => invoke('/api/command', { type: 'command', id, op, ...fields }, token);
  return { db, invoke, command };
}

test('D1 transport preserves ordered state, private profiles, command replay and concurrent settlement', async t => {
  const { db, invoke, command } = await httpSession(t);
  const health = await invoke('/health');
  assert.equal(health.data.ok, true);
  const [a, b] = await Promise.all([
    invoke('/api/hello', { type: 'hello', name: 'A' }),
    invoke('/api/hello', { type: 'hello', name: 'B' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const tokenA = a.data.token, tokenB = b.data.token;
  const made = await command(tokenA, 'create', { size: 19, mode: 'friend' });
  assert.equal(made.status, 200);
  const code = made.data.events[0].room.code;
  const joined = await command(tokenB, 'join', { code });
  assert.equal(joined.status, 200);
  const revision = joined.data.events[0].room.revision;
  const move = await command(tokenA, 'action', { code, revision, action: { type: 'play', x: 1, y: 1 } });
  assert.equal(move.status, 200);
  const id = crypto.randomUUID();
  const fields = { code, revision: revision + 1, action: { type: 'resign' } };
  const [finish1, finish2] = await Promise.all([command(tokenB, 'action', fields, id), command(tokenB, 'action', fields, id)]);
  assert.equal(finish1.status, 200);
  assert.equal(finish2.status, 200);

  const log = await invoke('/api/events?wait=0&after=' + a.data.cursor, undefined, tokenA);
  assert.deepEqual(log.data.events.map(event => event.room.revision), [1, 2, 3, 4]);
  assert.ok(log.data.events.every(event => event.profile.id === a.data.profile.id && !('token' in event)));
  const restored = await invoke('/api/hello', { type: 'hello', token: tokenB });
  assert.equal(restored.data.profile.coins, 90);
  assert.equal(restored.data.profile.history.length, 1);
  assert.equal(restored.data.room.game.phase, 'finished');
  assert.equal((await invoke('/api/events?wait=0', undefined, '0'.repeat(64))).status, 401);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM baduk_receipts').get().n, 4);
  const allData = db.sqlite.prepare('SELECT body FROM baduk_entities').all().map(row => row.body).join('');
  assert.equal(allData.includes(tokenA) || allData.includes(tokenB), false);
  assert.ok(db.sqlite.prepare("SELECT COUNT(*) AS n FROM baduk_entities WHERE kind='accounts'").get().n >= 2);
  assert.ok(db.sqlite.prepare("SELECT COUNT(*) AS n FROM baduk_entities WHERE kind='rooms'").get().n >= 1);
  // Both clients submit against the same rendered revision while the D1 writers race.
  const finished = restored.data.room;
  const rematch = { code, matchId: finished.matchId, revision: finished.revision };
  const votes = await Promise.all([command(tokenA, 'rematch', rematch), command(tokenB, 'rematch', rematch)]);
  assert.ok(votes.every(result => result.status === 200));
  const secondGame = (await invoke('/api/hello', { type: 'hello', token: tokenB })).data.room;
  assert.equal(secondGame.you, 1);
  assert.notEqual(secondGame.matchId, finished.matchId);
  const pass = { code, matchId: secondGame.matchId, action: { type: 'pass' } };
  await command(tokenB, 'action', { ...pass, revision: secondGame.revision, action: { type: 'play', x: 3, y: 3 } });
  await command(tokenA, 'action', { ...pass, revision: secondGame.revision + 1 });
  const scoring = await command(tokenB, 'action', { ...pass, revision: secondGame.revision + 2 });
  const proposal = scoring.data.events[0].room;
  assert.deepEqual([proposal.scorePreview.black, proposal.scorePreview.white], [0, 6.5]);
  const consent = { code, matchId: proposal.matchId, revision: proposal.revision, action: { type: 'confirmScore' } };
  const outdated = await command(tokenA, 'action', consent);
  assert.equal(outdated.data.code, 'scoring_rule_mismatch');
  consent.action.scoringRule = proposal.scorePreview.rule;
  const confirmationId = crypto.randomUUID();
  const approvals = await Promise.all([
    command(tokenA, 'action', consent, confirmationId), command(tokenB, 'action', consent),
    command(tokenA, 'action', consent, confirmationId),
  ]);
  assert.ok(approvals.every(result => result.status === 200));
  const summary = (await invoke('/api/hello', { type: 'hello', token: tokenA })).data;
  assert.equal(summary.room.game.phase, 'finished');
  assert.equal(summary.room.scorePreview, null);
  assert.deepEqual([summary.room.game.result.black, summary.room.game.result.white], [0, 6.5]);
  assert.equal(summary.profile.history.filter(row => row.matchId === proposal.matchId).length, 1);
  assert.equal(summary.profile.coins, 175);
});

test('the D1 outbox and reconnect return the same initial dead proposal and its later manual correction', async t => {
  const { invoke, command } = await httpSession(t);
  const a = (await invoke('/api/hello', { type: 'hello', name: '흑' })).data;
  const b = (await invoke('/api/hello', { type: 'hello', name: '백' })).data;
  const waiting = await command(a.token, 'create', { mode: 'friend' });
  const code = waiting.data.events[0].room.code;
  const joined = await command(b.token, 'join', { code });
  let room = joined.data.events[0].room;
  // Two connected corner stones share one liberty, which cannot be used to escape.
  const moves = [[0,0], [1,0], [0,1], [1,1], [18,18], [1,2], [17,18], [0,3]];
  for (const [index, coordinates] of [...moves, null, null].entries()) {
    const action = coordinates ? { type: 'play', x: coordinates[0], y: coordinates[1] } : { type: 'pass' };
    const res = await command(index % 2 ? b.token : a.token, 'action', { code, matchId: room.matchId, revision: room.revision, action });
    assert.equal(res.status, 200);
    room = res.data.events[0].room;
  }
  const events = await invoke('/api/events?wait=0&after=' + a.cursor, undefined, a.token);
  const last = events.data.events.at(-1).room;
  assert.deepEqual(last.game.suggestedDead, [0, 19]);
  assert.deepEqual(last.game.dead, [0, 19]);
  assert.deepEqual(last.scorePreview, room.scorePreview);
  assert.equal(last.scorePreview.breakdown[2].dead, 2);
  const fields = { code, matchId: room.matchId, revision: room.revision, action: { type: 'markDead', x: 0, y: 1 } };
  const id = crypto.randomUUID();
  const edits = await Promise.all([command(a.token, 'action', fields, id), command(a.token, 'action', fields, id)]);
  assert.ok(edits.every(result => result.status === 200));
  for (const token of [a.token, b.token]) {
    const restored = (await invoke('/api/hello', { type: 'hello', token })).data;
    assert.equal(restored.room.revision, room.revision + 1);
    assert.deepEqual(restored.room.game.suggestedDead, [0, 19]);
    assert.deepEqual(restored.room.game.dead, []);
    assert.equal(restored.room.scorePreview.breakdown[2].dead, 0);
    assert.equal(restored.profile.history.length, 0);
    assert.equal(restored.profile.coins, 100);
  }
});

