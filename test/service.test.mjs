import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction } from '../shared/go.mjs';
import { createService } from '../server/service.mjs';

const connect = (service, name) => service.hello({ type: 'hello', name });
function send(service, account, op, fields = {}, id = crypto.randomUUID()) {
  return service.command(account.accountId, { type: 'command', id, op, ...fields });
}
function roomCommand(service, account, op, fields = {}, id) {
  const { room } = service.view(account.accountId);
  return send(service, account, op, { code: room.code, revision: room.revision, ...fields }, id);
}
function action(service, account, type, fields = {}, id) {
  return roomCommand(service, account, 'action', { action: { type, ...fields } }, id);
}

test('new rooms reject smaller sizes and legacy waiting rooms start on 19 lines', async () => {
  const service = createService();
  const a = await connect(service, '새 대국');
  const b = await connect(service, '상대');
  for (const mode of ['friend', 'bot']) {
    for (const size of [9, 13]) {
      assert.throws(() => send(service, a, 'create', { mode, size }), { code: 'invalid_settings' });
    }
  }
  assert.equal(service.view(a.accountId).room, null);
  send(service, a, 'create', { mode: 'friend' });
  const code = service.view(a.accountId).room.code;
  const stored = service.snapshot();
  stored.rooms[code].size = 13;
  const restored = createService(stored);
  assert.equal(restored.view(a.accountId).room.size, 19);
  send(restored, b, 'join', { code });
  assert.equal(restored.view(a.accountId).room.game.board.length, 361);
});

for (const size of [9, 13]) {
  test('restore, finish and record an existing ' + size + '-line game before a 19-line rematch', async () => {
    const service = createService();
    const a = await connect(service, '기존 계정');
    const b = await connect(service, '친구');
    send(service, a, 'create', { mode: 'bot', difficulty: 'easy' });
    action(service, a, 'resign');
    const pastRecord = service.view(a.accountId).profile.history[0];
    roomCommand(service, a, 'leave');
    send(service, a, 'create', { mode: 'friend' });
    const code = service.view(a.accountId).room.code;
    send(service, b, 'join', { code });
    const stored = service.snapshot();
    const room = stored.rooms[code];
    room.size = size;
    // Pre-update snapshots encode three empty points per 'A' in the superko history.
    const board = Array(size * size).fill(0);
    room.game = { ...room.game, size, board, history: ['A'.repeat(Math.ceil(board.length / 3))] };
    room.game = applyAction(room.game, 1, { type: 'play', x: size - 1, y: size - 1 });
    const oldMatch = room.matchId;

    const restored = createService(stored);
    const resumed = (await restored.hello({ type: 'hello', token: a.message.token })).message;
    assert.equal(resumed.room.size, size);
    assert.equal(resumed.room.game.board.at(-1), 1);
    assert.deepEqual(resumed.profile.history, [pastRecord]);
    action(restored, b, 'play', { x: 0, y: 0 });
    action(restored, a, 'pass');
    action(restored, b, 'pass');
    action(restored, a, 'confirmScore');
    action(restored, b, 'confirmScore');
    const finished = restored.view(a.accountId);
    assert.equal(finished.room.size, size);
    assert.equal(finished.profile.history[0].matchId, oldMatch);
    assert.deepEqual(finished.profile.history[1], pastRecord);

    const reloaded = createService(restored.snapshot());
    roomCommand(reloaded, a, 'rematch');
    roomCommand(reloaded, b, 'rematch');
    const next = reloaded.view(a.accountId);
    assert.equal(next.room.size, 19);
    assert.equal(next.room.game.size, 19);
    assert.equal(next.room.game.board.length, 361);
    assert.notEqual(next.room.matchId, oldMatch);
    assert.deepEqual(next.profile, finished.profile);
  });
}

test('two accounts play, reconnect, settle once, rematch with swapped colors, and leave', async () => {
  let service = createService();
  const a = await connect(service, '흑돌');
  const b = await connect(service, '백돌');
  assert.notEqual(a.message.token, b.message.token);
  send(service, a, 'create', { size: 19, mode: 'friend' });
  const code = service.view(a.accountId).room.code;
  const joined = send(service, b, 'join', { code: code.toLowerCase() });
  assert.equal(joined.updates.length, 2);
  assert.equal(service.view(b.accountId).room.you, 2);
  const firstId = crypto.randomUUID();
  const first = action(service, a, 'play', { x: 2, y: 2 }, firstId);
  assert.equal(first.updates[1].message.room.game.board[40], 1);
  const firstRevision = first.updates[0].message.room.revision;
  assert.throws(() => send(service, b, 'action', { code, revision: firstRevision - 1, action: { type: 'pass' } }), { code: 'stale_revision' });
  send(service, a, 'action', { code, revision: 2, action: { type: 'play', x: 2, y: 2 } }, firstId);
  assert.equal(service.view(a.accountId).room.revision, firstRevision);
  assert.equal(service.view(a.accountId).room.game.moveNumber, 1);

  const stored = service.snapshot();
  assert.equal(JSON.stringify(stored).includes(a.message.token), false);
  service = createService(stored);
  const resumed = await service.hello({ type: 'hello', token: a.message.token });
  assert.equal(resumed.accountId, a.accountId);
  assert.equal(resumed.message.room.code, code);
  assert.equal(resumed.message.room.game.moveNumber, 1);
  assert.equal('history' in resumed.message.room.game, false);
  assert.equal(JSON.stringify(resumed.message).includes(b.message.token), false);

  const resignationId = crypto.randomUUID();
  const oldGame = service.view(b.accountId).room;
  action(service, b, 'resign', {}, resignationId);
  assert.deepEqual([service.view(a.accountId).profile.coins, service.view(b.accountId).profile.coins], [110, 90]);
  const finished = service.view(b.accountId).room;
  assert.equal(finished.game.result.winner, 1);
  service = createService(service.snapshot());
  send(service, b, 'action', { code, revision: oldGame.revision, action: { type: 'resign' } }, resignationId);
  assert.equal(service.view(b.accountId).profile.history.length, 1);
  assert.equal(service.view(a.accountId).profile.wins, 1);
  roomCommand(service, a, 'rematch');
  assert.deepEqual(service.view(a.accountId).room.rematch, [1]);
  roomCommand(service, b, 'rematch');
  const next = service.view(b.accountId).room;
  assert.equal(next.you, 1);
  assert.equal(next.game.moveNumber, 0);
  assert.notEqual(next.matchId, finished.matchId);
  send(service, b, 'action', { code, revision: oldGame.revision, action: { type: 'resign' } }, resignationId);
  assert.equal(service.view(b.accountId).room.matchId, next.matchId);
  assert.equal(service.view(b.accountId).room.game.phase, 'playing');
  assert.throws(() => roomCommand(service, b, 'leave'), { code: 'game_active' });
  action(service, b, 'resign');
  const left = roomCommand(service, a, 'leave');
  assert.equal(left.updates.length, 2);
  assert.ok(left.updates.every(update => update.message.room === null));
});

test('two-pass scoring requires both humans and half points transfer exact coins', async () => {
  const service = createService();
  const a = await connect(service, '봄');
  const b = await connect(service, '가을');
  send(service, a, 'create', { mode: 'friend', size: 19 });
  send(service, b, 'join', { code: service.view(a.accountId).room.code });
  action(service, a, 'pass');
  action(service, b, 'pass');
  action(service, a, 'confirmScore');
  assert.equal(service.view(a.accountId).profile.history.length, 0);
  action(service, b, 'confirmScore');
  const { room, profile } = service.view(b.accountId);
  assert.equal(room.game.result.margin, 6.5);
  assert.equal(profile.history[0].delta, 65);
  assert.equal(service.view(a.accountId).profile.history[0].delta, -65);
});

test('friend scores transfer the full amount and later bot losses cannot increase debt', async () => {
  const initial = createService();
  const a = await connect(initial, '여울');
  const b = await connect(initial, '하늘');
  const snapshot = initial.snapshot();
  snapshot.accounts[a.accountId].coins = 3;
  const service = createService(snapshot);
  send(service, a, 'create', { mode: 'friend', size: 19 });
  send(service, b, 'join', { code: service.view(a.accountId).room.code });
  action(service, a, 'pass');
  action(service, b, 'pass');
  action(service, a, 'confirmScore');
  action(service, b, 'confirmScore');
  assert.equal(service.view(a.accountId).profile.coins, -62);
  assert.equal(service.view(b.accountId).profile.coins, 165);
  assert.equal(service.view(a.accountId).profile.history[0].delta, -65);
  roomCommand(service, a, 'leave');
  send(service, a, 'create', { mode: 'bot', difficulty: 'hard', size: 19 });
  action(service, a, 'resign');
  assert.equal(service.view(a.accountId).profile.coins, -62);
  assert.equal(service.view(a.accountId).profile.history[0].delta, 0);
});

test('a consent cannot cross a dead-group edit, a resumption, or a match boundary', async () => {
  const service = createService();
  const a = await connect(service, '흑');
  const b = await connect(service, '백');
  send(service, a, 'create', { size: 19, mode: 'friend' });
  const code = service.view(a.accountId).room.code;
  send(service, b, 'join', { code });
  action(service, a, 'play', { x: 1, y: 1 });
  action(service, b, 'pass');
  action(service, a, 'pass');
  const proposal = service.view(a.accountId).room;
  const consent = { code, revision: proposal.revision, matchId: proposal.matchId, action: { type: 'confirmScore' } };
  action(service, b, 'markDead', { x: 1, y: 1 });
  assert.throws(() => send(service, a, 'action', consent), { code: 'stale_revision' });
  action(service, b, 'markDead', { x: 1, y: 1 });
  assert.throws(() => send(service, a, 'action', consent), { code: 'stale_revision' });
  const changed = { ...consent, revision: service.view(a.accountId).room.revision };
  action(service, b, 'resume');
  assert.throws(() => send(service, a, 'action', changed), { code: 'stale_revision' });
  action(service, b, 'pass');
  action(service, a, 'pass');
  assert.throws(() => send(service, a, 'action', changed), { code: 'stale_revision' });
  const current = { ...consent, revision: service.view(a.accountId).room.revision };
  send(service, a, 'action', current);
  assert.throws(() => send(service, b, 'action', { ...current, matchId: null }), { code: 'stale_revision' });
  assert.throws(() => send(service, b, 'action', { ...current, matchId: crypto.randomUUID() }), { code: 'stale_revision' });
  for (const type of ['resign', 'markDead', 'resume', 'play']) {
    assert.throws(() => send(service, b, 'action', { ...current, action: { type, x: 1, y: 1 } }), { code: 'stale_revision' });
  }
  const secondId = crypto.randomUUID();
  send(service, b, 'action', current, secondId);
  send(service, b, 'action', current, secondId);
  const finished = service.view(a.accountId).room;
  assert.equal(finished.game.phase, 'finished');
  assert.equal(service.view(a.accountId).profile.history.length, 1);
  const sameResult = { code, revision: finished.revision, matchId: finished.matchId };
  send(service, a, 'rematch', sameResult);
  assert.throws(() => send(service, b, 'rematch', { ...sameResult, revision: proposal.revision }), { code: 'stale_revision' });
  send(service, b, 'rematch', sameResult);
  assert.notEqual(service.view(a.accountId).room.matchId, finished.matchId);
  assert.throws(() => send(service, a, 'rematch', sameResult), { code: 'stale_revision' });
});

test('third account cannot inspect a private room, move, evict players, or impersonate by name', async () => {
  const service = createService();
  const a = await connect(service, '바람');
  const b = await connect(service, '바람');
  const c = await connect(service, '바람');
  assert.notEqual(a.accountId, b.accountId);
  send(service, a, 'create', { mode: 'friend', size: 19 });
  const { code } = service.view(a.accountId).room;
  send(service, b, 'join', { code });
  const args = { code, revision: service.view(a.accountId).room.revision, action: { type: 'resign' } };
  for (const op of ['action', 'rematch', 'leave']) {
    assert.throws(() => send(service, c, op, args), { code: 'not_member' });
  }
  assert.throws(() => send(service, c, 'join', { code }), { code: 'room_full' });
  assert.equal(service.view(c.accountId).room, null);
  await assert.rejects(() => service.hello({ type: 'hello', token: '0'.repeat(64) }), { code: 'invalid_token' });
  assert.throws(() => action(service, b, 'play', { x: 0, y: 0 }));
  assert.equal(service.view(a.accountId).room.game.moveNumber, 0);
});

test('bot challenges a proposed removal before confirming the score', async () => {
  const initial = createService();
  const a = await connect(initial, '바다');
  send(initial, a, 'create', { mode: 'bot', size: 19 });
  const code = initial.view(a.accountId).room.code;
  const db = initial.snapshot();
  const room = db.rooms[code];
  for (const move of [{ type: 'play', x: 1, y: 1 }, { type: 'play', x: 6, y: 6 }, { type: 'pass' }, { type: 'pass' }]) {
    room.game = applyAction(room.game, room.game.turn, move);
  }
  const service = createService(db);
  action(service, a, 'markDead', { x: 6, y: 6 });
  action(service, a, 'confirmScore');
  service.botStep(code);
  assert.equal(service.view(a.accountId).room.game.phase, 'scoring');
  assert.deepEqual(service.view(a.accountId).room.game.dead, []);
  assert.deepEqual(service.view(a.accountId).room.game.confirmed, []);
  service.botStep(code);
  assert.deepEqual(service.view(a.accountId).room.game.confirmed, [2]);
});

for (const [difficulty, win, loss] of [['easy', 5, 10], ['normal', 10, 10], ['hard', 20, 20]]) {
  test('bot settlements and debit limit: ' + difficulty, async () => {
    const initial = createService();
    const a = await connect(initial, '단풍');
    send(initial, a, 'create', { mode: 'bot', size: 19, difficulty });
    const code = initial.view(a.accountId).room.code;
    const baseline = initial.snapshot();
    for (const [humanWon, coins, expected] of [[true, 0, win], [false, 30, -loss], [false, 3, -3], [false, 0, 0]]) {
      const db = structuredClone(baseline);
      const room = db.rooms[code];
      db.accounts[a.accountId].coins = coins;
      if (humanWon) room.game = applyAction(room.game, 1, { type: 'play', x: 2, y: 2 });
      for (let i = 0; i < 2; i++) room.game = applyAction(room.game, room.game.turn, { type: 'pass' });
      const service = createService(db);
      assert.deepEqual(service.pendingBots(), [code]);
      service.botStep(code);
      assert.deepEqual(service.pendingBots(), []);
      action(service, a, 'confirmScore');
      const profile = service.view(a.accountId).profile;
      assert.equal(profile.history.length, 1);
      assert.equal(profile.history[0].delta, expected);
      assert.equal(profile.coins, coins + expected);
      service.botStep(code);
      assert.equal(service.view(a.accountId).profile.history.length, 1);
    }
    // On the second game the bot plays black and acts after restart.
    action(initial, a, 'resign');
    roomCommand(initial, a, 'rematch');
    const resumed = createService(initial.snapshot());
    assert.deepEqual(resumed.pendingBots(), [code]);
    const placed = resumed.botStep(code);
    assert.equal(placed.updates.length, 1);
    assert.equal(placed.updates[0].message.room.game.moveNumber, 1);
    assert.deepEqual(resumed.botStep(code).updates, []);
  });
}

