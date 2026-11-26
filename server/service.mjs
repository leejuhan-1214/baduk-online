import { applyAction, chooseBotAction, createGame } from '../shared/go.mjs';

const BOT = '@bot';
const BOT_NAMES = { easy: '초급 바둑봇', normal: '중급 바둑봇', hard: '고급 바둑봇' };
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STARTING_COINS = 100;

function reject(code, message) {
  throw Object.assign(new Error(message), { code });
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), n => n.toString(16).padStart(2, '0')).join('');
}

async function tokenKey(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

function checkedName(raw) {
  if (typeof raw !== 'string') reject('invalid_name', '대국자 이름을 입력해 주세요.');
  const name = raw.trim().normalize('NFC');
  if (!name || [...name].length > 20 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    reject('invalid_name', '대국자 이름은 1~20자로 입력해 주세요.');
  }
  return name;
}

function roomCode(rooms) {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = Array.from(bytes, n => ROOM_ALPHABET[n % ROOM_ALPHABET.length]).join('');
    if (!Object.hasOwn(rooms, code)) return code;
  }
}

function colorOf(room, id) {
  if (room.players[1] === id) return 1;
  if (room.players[2] === id) return 2;
  return null;
}

function publicProfile(account) {
  const { id, name, coins, wins, losses, score, history } = account;
  return { id, name, coins, wins, losses, score, history: structuredClone(history.slice(-50).reverse()) };
}

export function createService(snapshot = null) {
  const db = snapshot == null
    ? { version: 1, accounts: {}, tokens: {}, rooms: {} }
    : structuredClone(snapshot);
  if (db.version !== 1 || !db.accounts || !db.tokens || !db.rooms) {
    throw new Error('바둑 서비스 저장 데이터 형식을 확인해 주세요.');
  }

  function accountFor(id) {
    if (!Object.hasOwn(db.accounts, id)) reject('unauthorized', '다시 접속해 주세요.');
    return db.accounts[id];
  }

  function publicRoom(room, id) {
    if (!room) return null;
    function player(color) {
      const playerId = room.players[color];
      if (!playerId) return null;
      const bot = playerId === BOT;
      return { name: bot ? BOT_NAMES[room.difficulty] : accountFor(playerId).name, bot };
    }
    let game = null;
    if (room.game) {
      // Superko history stays on the authoritative server.
      const { history, ...visibleGame } = room.game;
      game = structuredClone(visibleGame);
    }
    return {
      code: room.code, revision: room.revision, matchId: room.matchId,
      size: room.size, mode: room.mode, difficulty: room.difficulty,
      you: colorOf(room, id), players: { 1: player(1), 2: player(2) },
      game, rematch: [...room.rematch],
    };
  }

  function view(id) {
    const account = accountFor(id);
    return { type: 'state', profile: publicProfile(account), room: publicRoom(db.rooms[account.room], id) };
  }

  function getUpdates(ids) {
    return [...new Set(ids)].filter(id => id && id !== BOT).map(accountId => ({ accountId, message: view(accountId) }));
  }

  async function hello(message) {
    if (!message || message.type !== 'hello') reject('invalid_hello', '먼저 접속 정보를 보내 주세요.');
    let token = message.token;
    let id;
    if (token != null) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) reject('invalid_token', '계정 접속 정보가 올바르지 않습니다.');
      id = db.tokens[await tokenKey(token)];
      if (!id) reject('invalid_token', '이 계정의 접속 정보를 찾을 수 없습니다.');
    } else {
      const name = message.name == null || message.name === '' ? null : checkedName(message.name);
      token = randomHex(32);
      const hash = await tokenKey(token);
      id = crypto.randomUUID();
      db.accounts[id] = {
        id, name: name ?? '대국자 ' + randomHex(2).toUpperCase(),
        coins: STARTING_COINS, wins: 0, losses: 0, score: 0, history: [], room: null, receipts: {},
      };
      db.tokens[hash] = id;
    }
    return { accountId: id, message: { ...view(id), type: 'welcome', token } };
  }

  function startMatch(room) {
    room.matchId = crypto.randomUUID();
    room.game = createGame(room.size);
    room.rematch = [];
    room.settled = false;
    room.voteRevision = null;
  }

  function createRoom(account, message) {
    if (account.room) reject('already_in_room', '현재 대국방에서 먼저 나가 주세요.');
    const { mode = 'friend', size = 19, difficulty = 'normal' } = message;
    if (!['friend', 'bot'].includes(mode) || ![9, 13, 19].includes(size)
      || (mode === 'bot' && !Object.hasOwn(BOT_NAMES, difficulty))) {
      reject('invalid_settings', '대국 설정을 확인해 주세요.');
    }
    const code = roomCode(db.rooms);
    const room = {
      code, size, mode, difficulty: mode === 'bot' ? difficulty : null, revision: 1,
      players: { 1: account.id, 2: mode === 'bot' ? BOT : null },
      game: null, matchId: null, rematch: [], settled: false,
    };
    if (mode === 'bot') startMatch(room);
    db.rooms[code] = room;
    account.room = code;
    return [account.id];
  }

  function lookupRoom(code) {
    if (typeof code !== 'string') reject('bad_code', '대국방 코드를 입력해 주세요.');
    const key = code.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(key) || !Object.hasOwn(db.rooms, key)) reject('room_missing', '해당 대국방을 찾을 수 없습니다.');
    return db.rooms[key];
  }

  function joinRoom(account, message) {
    const room = lookupRoom(message.code);
    if (account.room) reject('already_in_room', '현재 대국방에서 먼저 나가 주세요.');
    if (room.players[2]) reject('room_full', '이미 두 명이 입장한 대국방입니다.');
    room.players[2] = account.id;
    account.room = room.code;
    startMatch(room);
    room.revision++;
    return Object.values(room.players);
  }

  function roomForCommand(account, message) {
    const room = lookupRoom(message.code);
    if (account.room !== room.code || !colorOf(room, account.id)) reject('not_member', '이 대국방의 참여자만 진행할 수 있습니다.');
    if (message.revision === room.revision && (message.matchId == null || message.matchId === room.matchId)) return room;

    const scoringVote = message.op === 'action' && message.action?.type === 'confirmScore' && room.game?.phase === 'scoring';
    const rematchVote = message.op === 'rematch' && room.game?.phase === 'finished';
    if ((scoringVote || rematchVote) && typeof room.matchId === 'string' && message.matchId === room.matchId
      && Number.isSafeInteger(message.revision) && Number.isSafeInteger(room.voteRevision)
      && message.revision >= room.voteRevision && message.revision < room.revision) return room;
    reject('stale_revision', '대국 상태가 바뀌었습니다. 최신 바둑판에서 다시 시도해 주세요.');
  }

  function settle(room) {
    const result = room.game.result;
    if (!result || room.settled) return;
    const loser = 3 - result.winner;
    let amount;
    if (room.mode === 'friend') {
      amount = result.reason === 'resign' ? 10 : Math.round(result.margin * 10);
    } else {
      // Bot payouts are fixed per game, independent of the score margin.
      const humanWon = room.players[result.winner] !== BOT;
      const desired = humanWon ? { easy: 5, normal: 10, hard: 20 }[room.difficulty]
        : { easy: 10, normal: 10, hard: 20 }[room.difficulty];
      amount = humanWon ? desired : Math.min(desired, Math.max(0, accountFor(room.players[loser]).coins));
    }
    const at = new Date().toISOString();
    for (const color of [1, 2]) {
      const id = room.players[color];
      if (id === BOT) continue;
      const account = accountFor(id);
      const won = result.winner === color;
      const delta = won ? amount : -amount || 0;
      account.coins += delta;
      if (won) {
        account.wins++;
        account.score += result.margin ?? 1;
      } else {
        account.losses++;
      }
      account.history.push({
        matchId: room.matchId, mode: room.mode, difficulty: room.difficulty, won, delta, at,
        reason: result.reason, margin: result.margin,
      });
    }
    room.settled = true;
  }

  function play(room, color, action) {
    if (!room.game) reject('waiting_for_guest', '상대가 입장하면 대국을 시작합니다.');
    const previousPhase = room.game.phase;
    room.game = applyAction(room.game, color, action);
    settle(room);
    room.revision++;
    // The players may vote concurrently only while the exact proposal they saw still exists.
    if (room.game.phase !== previousPhase || action.type === 'markDead') {
      room.voteRevision = room.game.phase === 'playing' ? null : room.revision;
    }
  }

  function rematch(room, color) {
    if (room.game?.phase !== 'finished') reject('game_not_finished', '대국이 끝난 뒤 재대국을 신청할 수 있습니다.');
    if (room.rematch.includes(color)) reject('already_requested', '상대의 재대국 동의를 기다리고 있습니다.');
    room.rematch.push(color);
    if (room.mode === 'bot' || room.rematch.length === 2) {
      [room.players[1], room.players[2]] = [room.players[2], room.players[1]];
      startMatch(room);
    }
    room.revision++;
  }

  function command(id, message) {
    const account = accountFor(id);
    if (message?.type !== 'command' || typeof message.id !== 'string' || !/^[\w:-]{1,100}$/.test(message.id)) {
      reject('invalid_command', '요청 식별자가 올바르지 않습니다.');
    }
    const reply = { type: 'ack', id: message.id };
    const receipt = ':' + message.id;
    if (Object.hasOwn(account.receipts, receipt)) return { reply, updates: getUpdates([id]) };
    let recipients;
    switch (message.op) {
      case 'create':
        recipients = createRoom(account, message);
        break;
      case 'join':
        recipients = joinRoom(account, message);
        break;
      case 'rename': {
        account.name = checkedName(message.name);
        const room = db.rooms[account.room];
        if (room) room.revision++;
        recipients = room ? Object.values(room.players) : [id];
        break;
      }
      case 'action':
      case 'rematch':
      case 'leave': {
        const room = roomForCommand(account, message);
        const color = colorOf(room, id);
        recipients = Object.values(room.players);
        if (message.op === 'action') {
          play(room, color, message.action);
        } else if (message.op === 'rematch') {
          rematch(room, color);
        } else {
          if (room.game && room.game.phase !== 'finished') reject('game_active', '진행 중인 대국은 기권한 뒤 나갈 수 있습니다.');
          for (const member of recipients) {
            if (member && member !== BOT) accountFor(member).room = null;
          }
          delete db.rooms[room.code];
        }
        break;
      }
      default:
        reject('invalid_command', '지원하지 않는 대국 요청입니다.');
    }
    account.receipts[receipt] = true;
    return { reply, updates: getUpdates(recipients) };
  }

  function botReady(room) {
    if (room?.mode !== 'bot' || !room.game) return false;
    const botColor = colorOf(room, BOT);
    return room.game.phase === 'scoring' ? !room.game.confirmed.includes(botColor)
      : room.game.phase === 'playing' && room.game.turn === botColor;
  }

  function botStep(code) {
    const room = db.rooms[code];
    if (!botReady(room)) return { updates: [] };
    const color = colorOf(room, BOT);
    // Both players may review scoring, even before the other has confirmed.
    const perspective = room.game.turn === color ? room.game : { ...room.game, turn: color };
    const action = chooseBotAction(perspective, room.difficulty);
    play(room, color, action);
    return { updates: getUpdates(Object.values(room.players)) };
  }

  return {
    snapshot: () => structuredClone(db), hello, command, view, botStep,
    pendingBots: () => Object.values(db.rooms).filter(botReady).map(room => room.code),
  };
}

