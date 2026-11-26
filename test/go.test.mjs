import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, areaScore, chooseBotAction } from '../shared/go.mjs';

const play = (x, y) => ({ type: 'play', x, y });
const pass = { type: 'pass' };
const confirm = { type: 'confirmScore' };
const mark = (x, y) => ({ type: 'markDead', x, y });
const next = (game, action) => applyAction(game, game.turn, action);
const sequence = (actions, size = 9) => actions.reduce(next, createGame(size));
const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code);

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

test('supported board sizes, turn validation, integer coordinates and occupied points', () => {
  for (const size of [9, 13, 19]) {
    const game = createGame(size);
    assert.equal(game.board.length, size ** 2);
    deepFreeze(game);
    const opened = next(game, play(size - 1, size - 1));
    assert.equal(opened.board.at(-1), 1);
    assert.equal(game.board.at(-1), 0);
    throwsCode(() => next(opened, play(size - 1, size - 1)), 'occupied');
    throwsCode(() => applyAction(game, 2, play(0, 0)), 'turn');
    for (const x of [-1, 0.5, size, '2', NaN]) throwsCode(() => next(game, play(x, 0)), 'bounds');
    throwsCode(() => applyAction(game, 4, pass), 'color');
  }
  throwsCode(() => createGame(17), 'size');
});

test('one play takes two distinct chains and leaves the previous state intact', () => {
  const game = sequence([
    play(1, 0), play(1, 1), play(3, 0), play(3, 1), play(0, 1), play(8, 8),
    play(4, 1), play(8, 7), play(1, 2), play(8, 6), play(3, 2), play(8, 5),
  ]);
  deepFreeze(game);
  const captured = next(game, play(2, 1));
  assert.equal(captured.board[10], 0);
  assert.equal(captured.board[12], 0);
  assert.equal(captured.captures[1], 2);
  assert.equal(game.board[10], 2);
  assert.equal(game.captures[1], 0);
});

test('suicide at the edge is rejected and capture can supply the only liberty', () => {
  const surrounded = sequence([play(1, 0), play(8, 8), play(0, 1)]);
  throwsCode(() => next(surrounded, play(0, 0)), 'suicide');
  const capture = sequence([play(2, 0), play(1, 0), play(1, 1), play(0, 1)]);
  const played = next(capture, play(0, 0));
  assert.equal(played.board[1], 0);
  assert.equal(played.captures[1], 1);
});

test('positional superko survives passes and scoring resumption, and a ko threat changes the position', () => {
  const game = sequence([
    play(1, 0), play(2, 0), play(0, 1), play(3, 1), play(1, 2), play(2, 2),
    play(8, 8), play(1, 1), play(2, 1),
  ]);
  throwsCode(() => next(game, play(1, 1)), 'superko');
  const scoring = next(next(game, pass), pass);
  const confirmed = applyAction(scoring, 2, confirm);
  const resumed = applyAction(confirmed, 1, { type: 'resume' });
  assert.equal(resumed.turn, 2);
  assert.equal(resumed.passes, 0);
  assert.deepEqual(resumed.confirmed, []);
  throwsCode(() => next(resumed, play(1, 1)), 'superko');
  const recaptured = next(next(next(game, play(8, 0)), play(7, 8)), play(1, 1));
  assert.equal(recaptured.board[11], 0);
  assert.equal(recaptured.captures[2], 1);
});

test('area scoring counts stones, single-color empty regions and komi, leaving mixed regions neutral', () => {
  const position = sequence([play(0, 1), play(8, 8), play(1, 0)]);
  const tally = areaScore(position);
  assert.equal(tally.territory[0], 1);
  assert.equal(tally.territory[40], 0);
  assert.equal(tally.black, 3);
  assert.equal(tally.white, 7.5);
  assert.equal(tally.margin, 4.5);
  const empty = areaScore(createGame(9));
  assert.equal(empty.black, 0);
  assert.equal(empty.white, 6.5);
});

test('changing an entire dead chain invalidates both approvals until the new score is accepted', () => {
  const scoring = sequence([play(0, 0), play(8, 8), play(0, 1), pass, pass]);
  assert.equal(scoring.phase, 'scoring');
  const accepted = applyAction(scoring, 1, confirm);
  throwsCode(() => applyAction(accepted, 1, confirm), 'already_confirmed');
  throwsCode(() => applyAction(scoring, 1, mark(2, 3)), 'no_stone');
  const marked = applyAction(accepted, 2, mark(0, 0));
  assert.deepEqual(marked.confirmed, []);
  assert.deepEqual(marked.dead, [0, 9]);
  assert.deepEqual(applyAction(marked, 1, mark(0, 1)).dead, []);
  assert.equal(marked.board[9], 1);
  const finished = applyAction(applyAction(marked, 2, confirm), 1, confirm);
  assert.equal(finished.phase, 'finished');
  assert.deepEqual(finished.result, { winner: 2, reason: 'score', black: 0, white: 87.5, margin: 87.5 });
  throwsCode(() => applyAction(finished, 1, confirm), 'finished');
});

test('nonconsecutive passes leave play open; resignation by either seat is final', () => {
  const playing = sequence([pass, play(0, 0), pass]);
  assert.equal(playing.phase, 'playing');
  assert.equal(playing.passes, 1);
  const ended = applyAction(playing, 1, { type: 'resign' });
  assert.deepEqual(ended.result, { winner: 2, reason: 'resign', black: null, white: null, margin: null });
  throwsCode(() => applyAction(ended, 2, pass), 'finished');
});

test('all bot levels produce legal moves, capture urgent stones, and can decline a disputed dead chain', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    const game = createGame(19);
    const choice = chooseBotAction(game, level, () => 0.4);
    assert.equal(choice.type, 'play');
    assert.equal(next(game, choice).moveNumber, 1);
  }
  const atari = sequence([play(2, 0), play(1, 0), play(1, 1), play(0, 1)]);
  assert.deepEqual(chooseBotAction(atari, 'hard', () => 0.5), play(0, 0));
  const scoring = sequence([play(0, 0), play(8, 8), pass, pass]);
  const disputed = applyAction(scoring, 1, mark(8, 8));
  assert.deepEqual(chooseBotAction(disputed, 'hard'), mark(8, 8));
  const clean = applyAction(disputed, 2, mark(8, 8));
  assert.deepEqual(chooseBotAction(clean), confirm);
});

test('scoring bot accepts a trapped group but disputes a group saved by countercapture', () => {
  function propose(actions) {
    const scoring = sequence([...actions, pass, pass]);
    return applyAction(scoring, 2, mark(0, 0));
  }
  const trapped = propose([play(0, 0), play(1, 0), play(8, 8), play(1, 1), play(7, 8), play(0, 2)]);
  assert.deepEqual(chooseBotAction(trapped, 'normal'), confirm);
  const countercapture = propose([play(0, 0), play(1, 0), play(2, 0), play(0, 2), play(8, 8), play(1, 2)]);
  assert.deepEqual(chooseBotAction(countercapture, 'hard'), mark(0, 0));
});
