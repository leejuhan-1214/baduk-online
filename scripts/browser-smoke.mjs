import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const site = new URL(process.argv[2] || process.env.BADUK_SITE_URL || 'http://localhost:4189/');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const desktops = [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 1024, height: 600 }];
const phones = [{ width: 390, height: 844 }, { width: 360, height: 640 }, { width: 568, height: 320 }];
const desktop = await browser.newContext({ viewport: desktops[1] });
const mobile = await browser.newContext({ viewport: phones[1], deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const host = await desktop.newPage();
const guest = await mobile.newPage();
const participants = [host, guest];
const pageErrors = [];
const forceHttp = process.env.BADUK_BLOCK_WEBSOCKET === '1';
const allowHttp = forceHttp || process.env.BADUK_ALLOW_HTTP === '1';
const simultaneous = process.env.BADUK_SIMULTANEOUS === '1';
const screenshotDirectory = process.env.BADUK_SCREENSHOTS;

// Observe the app's actual transport. Duplicate one user-submitted command on demand,
// preserving its original ID, revision and match. Never record login frames or tokens.
function instrumentTransport() {
  const state = window.badukTest = { socket: null, welcomed: false, httpWelcomed: false, duplicate: null, duplicated: null, lastState: null, timeline: [] };
  const NativeSocket = window.WebSocket;
  class ObservedSocket extends NativeSocket {
    constructor(...args) {
      super(...args);
      state.socket = this;
      const start = performance.now();
      const note = label => state.timeline.push([label, Math.round(performance.now() - start)]);
      this.addEventListener('open', () => note('open'));
      this.addEventListener('close', event => note('close ' + event.code));
      this.addEventListener('error', () => note('error'));
      this.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === 'welcome') { state.welcomed = true; note('welcome'); }
        if (message.type === 'state') state.lastState = message;
      });
    }
    send(payload) {
      const msg = JSON.parse(payload);
      const decision = msg.op === 'action' ? msg.action?.type : msg.op;
      if (msg.type === 'command' && decision && decision === state.hold) {
        state.held = msg;
        return;
      }
      super.send(payload);
      if (msg.type === 'command' && msg.op === 'action' && msg.action.type === state.duplicate) {
        state.duplicate = null;
        state.duplicated = msg;
        super.send(payload);
      }
    }
  }
  window.WebSocket = ObservedSocket;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    const response = await originalFetch(input, init);
    if (path === '/api/hello' && response.ok) state.httpWelcomed = true;
    if (path === '/api/events' && response.ok) {
      const batch = await response.clone().json();
      if (batch.events?.length) state.lastState = batch.events.at(-1);
    }
    if (path === '/api/command' && init?.body) {
      const msg = JSON.parse(init.body);
      if (msg.op === 'action' && msg.action.type === state.duplicate) {
        state.duplicate = null;
        state.duplicated = msg;
        await originalFetch(input, init);
      }
    }
    return response;
  };
}

function waitText(page, selector, expected) {
  return page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent.includes(expected), { selector, expected });
}

function waitMove(page, number) {
  return page.waitForFunction(n => document.getElementById('moves').textContent === n + '수', number);
}

function waitTurn(page, colorName) {
  return waitText(page, '#statusText', colorName + '돌을 놓을 차례');
}

async function playPoint(page, x, y) {
  const canvas = page.locator('#board');
  const width = (await canvas.boundingBox()).width;
  const pad = Math.max(16, width * 0.052);
  const gap = (width - 2 * pad) / 18;
  const position = { x: pad + x * gap, y: pad + y * gap };
  if (page === guest) await canvas.tap({ position });
  else await canvas.click({ position });
}

const commonControls = ['#board', '#boardSize', '#modeTag', '#moves', '#seatBlack', '#seatWhite', '#blackName', '#whiteName', '#statusText', '#friendQuick', '#settingsOpen', '#moreTools > summary'];
const phaseControls = {
  practice: ['#pass', '#resign'], waiting: ['#roomCode', '#copyRoom'], active: ['#pass', '#resign', '#roomCode', '#copyRoom'],
  scoring: ['#confirmScore', '#resume', '#phaseNote', '#roomCode', '#copyRoom'], finished: ['#rematch', '#phaseNote', '#roomCode', '#copyRoom'],
};
const layoutSamples = [];

async function assertGeometry(page, label, size, selectors) {
  const measurement = await page.evaluate(async required => {
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const problems = [];
    const margin = 1.5;
    if (root.scrollWidth > root.clientWidth + 1 || root.scrollHeight > root.clientHeight + 1 || scrollX !== 0 || scrollY !== 0) {
      problems.push(`document ${root.scrollWidth}×${root.scrollHeight}, scroll ${scrollX},${scrollY}`);
    }
    for (const selector of required) {
      const el = document.querySelector(selector);
      if (!el) { problems.push(`${selector} missing`); continue; }
      const box = el.getBoundingClientRect();
      const outside = box.left < -margin || box.top < -margin || box.right > width + margin || box.bottom > height + margin;
      if (box.width < 1 || box.height < 1 || outside || getComputedStyle(el).visibility === 'hidden') {
        problems.push(`${selector} bounds ${[box.left, box.top, box.right, box.bottom].map(Math.round)}`);
        continue;
      }
      // Probe rendered pixels, not just boxes: overflow:hidden and overlapping panels can hide a control inside the viewport.
      const samples = [[.5,.5]];
      if (selector === '#board') samples.push([.06,.06], [.94,.06], [.06,.94], [.94,.94]);
      for (const [fx, fy] of samples) {
        const hit = document.elementFromPoint(box.left + box.width * fx, box.top + box.height * fy);
        if (!hit || (!el.contains(hit) && !hit.contains(el))) problems.push(`${selector} behind ${hit?.id || hit?.tagName || 'viewport'}`);
      }
    }
    const board = document.getElementById('board').getBoundingClientRect();
    return { width, height, problems, boardWidth: Math.round(board.width), boardHeight: Math.round(board.height) };
  }, selectors);
  assert.equal(Math.round(measurement.width), size.width, `${label}: viewport width`);
  assert.equal(Math.round(measurement.height), size.height, `${label}: viewport height`);
  assert.deepEqual(measurement.problems, [], `${label} ${size.width}×${size.height}: ${measurement.problems.join(', ')}`);
  if (selectors.includes('#board')) {
    assert.ok(measurement.boardWidth >= Math.min(205, size.height * .6), `board size at ${size.width}×${size.height}`);
    assert.ok(Math.abs(measurement.boardWidth - measurement.boardHeight) <= 1, 'board remains square');
    assert.equal((await page.locator('#boardSize').textContent()).trim(), '19줄');
    layoutSamples.push(`${label} ${size.width}×${size.height}`);
  }
}

async function auditLayouts(page, label, sizes) {
  const initial = page.viewportSize();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await assertGeometry(page, label, size, [...commonControls, ...phaseControls[label]]);
    if (screenshotDirectory && label === 'active' && (size.width === 1440 || size.width === 390)) {
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({ path: path.join(screenshotDirectory, `baduk-19-${size.width}x${size.height}.png`) });
    }
  }
  await page.setViewportSize(initial);
}

const auditBoth = label => Promise.all([auditLayouts(host, label, desktops), auditLayouts(guest, label, phones)]);

async function setMoreMenu(page, open) {
  if ((await page.locator('#moreTools').evaluate(el => el.open)) !== open) await page.locator('#moreTools > summary').click();
}

async function openTool(page, selector) {
  await setMoreMenu(page, true);
  await page.locator(selector).click();
}

async function auditSettings(page, sizes) {
  const initial = page.viewportSize();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await setMoreMenu(page, true);
    await assertGeometry(page, '더보기', size, ['#moreTools > summary', '#soundButton', '#historyNav', '#guideNav']);
    await setMoreMenu(page, false);
    await page.locator('#settingsOpen').click();
    assert.equal(await page.locator('#sizes, [data-value="9"], [data-value="13"]').count(), 0, 'smaller boards cannot be selected');
    await page.locator('[data-mode="bot"]').click();
    await assertGeometry(page, '봇 설정', size, ['#settingsDialog .modal-close', '[data-mode="bot"]', '#nickname', '#levels [data-value="hard"]', '#createGame']);
    await page.locator('#levels [data-value="hard"]').click();
    await page.locator('[data-mode="friend"]').click();
    await assertGeometry(page, '친구 설정', size, ['#settingsDialog .modal-close', '[data-mode="friend"]', '#nickname', '#createGame', '#joinCode', '#joinGame']);
    await page.locator('#settingsDialog .modal-close').click();
    if (size.height <= 320) {
      await openTool(page, '#historyNav');
      await assertGeometry(page, '기록', size, ['#historyTitle', '#historyList li', '#historyDialog .modal-close']);
      await page.locator('#historyDialog .modal-close').click();
      await openTool(page, '#guideNav');
      const sections = page.locator('#guideDialog summary');
      for (let i = 0; i < await sections.count(); i++) {
        await sections.nth(i).click();
        await assertGeometry(page, '안내', size, ['#guideTitle', '#guideDialog .modal-close', '#guideDialog details:first-child summary', '#guideDialog details:last-child summary']);
      }
      await page.locator('#guideDialog .modal-close').click();
    }
  }
  await page.setViewportSize(initial);
}

async function checkLegacyPractice() {
  const context = await browser.newContext({ viewport: desktops[1] });
  try {
    const page = await context.newPage();
    await page.goto(site.href, { waitUntil: 'domcontentloaded' });
    for (const size of [9, 13]) {
      await page.evaluate(size => {
        const board = Array(size * size).fill(0);
        board[0] = 1;
        localStorage.setItem('sudam-go.practice.v1', JSON.stringify({ size, difficulty: 'hard', mode: 'practice', game: { size, phase: 'playing', board, turn: 2, moveNumber: 1, history: ['old'] } }));
        localStorage.setItem('sudam-go.localHistory', JSON.stringify([{ matchId: 'older-completed-game', mode: 'practice', won: true, reason: 'resign', margin: null, at: '2026-01-01T12:00:00Z' }]));
      }, size);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitTurn(page, '흑');
      await waitMove(page, 0);
      assert.equal((await page.locator('#boardSize').textContent()).trim(), '19줄');
      await openTool(page, '#historyNav');
      await waitText(page, '#historyList', '승리');
      assert.equal(await page.locator('#historyList li').count(), 1);
      await page.locator('#historyDialog .modal-close').click();
    }
  } finally { await context.close(); }
}

const profile = page => page.evaluate(() => JSON.parse(localStorage.getItem('sudam-go.profile')));
const duplicateNext = (page, action) => page.evaluate(type => { window.badukTest.duplicate = type; }, action);

async function simultaneousDecision(decision, selector) {
  // Both browsers click using the same visible board. Hold both outgoing frames
  // until both UI handlers have built their commands so network speed cannot serialize the clicks.
  await Promise.all(participants.map(page => page.evaluate(type => {
    window.badukTest.hold = type;
    window.badukTest.held = null;
  }, decision)));
  await Promise.all(participants.map(page => page.locator(selector).click()));
  const messages = await Promise.all(participants.map(page => page.evaluate(() => window.badukTest.held)));
  assert.ok(messages.every(message => message?.id), 'two UI commands were captured');
  assert.equal(messages[0].code, messages[1].code);
  assert.equal(messages[0].revision, messages[1].revision, 'both clicks used the very same room revision');
  assert.equal(messages[0].matchId, messages[1].matchId);
  await Promise.all(participants.map(page => page.evaluate(() => {
    window.badukTest.hold = null;
    window.badukTest.socket.send(JSON.stringify(window.badukTest.held));
  })));
}

async function checkLedger(page, won, matchId) {
  const entry = await profile(page);
  assert.equal(entry.coins, won ? 165 : 35);
  assert.equal(entry.wins, won ? 1 : 0);
  assert.equal(entry.losses, won ? 0 : 1);
  assert.equal(entry.history.length, 1);
  assert.equal(entry.history[0].delta, won ? 65 : -65);
  assert.equal(entry.history[0].matchId, matchId);
}

try {
  await Promise.all(participants.map(async page => {
    page.setDefaultTimeout(25000);
    page.on('pageerror', error => { pageErrors.push(error.message); });
    if (forceHttp) await page.routeWebSocket('**/ws', route => route.close({ code: 1001 }));
    await page.addInitScript(instrumentTransport);
    await page.goto(site.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitTurn(page, '흑');
  }));
  await auditBoth('practice');
  await checkLegacyPractice();
  await Promise.all([auditSettings(host, desktops), auditSettings(guest, phones)]);
  if (await host.locator('#fullscreenButton').isVisible()) {
    await host.locator('#fullscreenButton').click();
    await host.waitForFunction(() => Boolean(document.fullscreenElement));
    await host.locator('#fullscreenButton').click();
    await host.waitForFunction(() => !document.fullscreenElement);
  }
  await host.locator('#friendQuick').click();
  await host.locator('#nickname').fill('흑돌 검증');
  await host.locator('#createGame').click();
  await host.locator('#roomStrip').waitFor({ state: 'visible' });
  const code = (await host.locator('#roomCode').textContent()).trim();
  assert.match(code, /^[A-Z2-9]{6}$/);
  await auditLayouts(host, 'waiting', [...desktops, ...phones]);
  await desktop.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: site.origin });
  await host.locator('#copyRoom').click();
  const invitation = new URL(await host.evaluate(() => navigator.clipboard.readText()));
  assert.equal(invitation.origin, site.origin);
  assert.equal(invitation.pathname, site.pathname);
  assert.equal(invitation.searchParams.get('room'), code);
  await guest.goto(invitation.href, { waitUntil: 'domcontentloaded' });
  assert.equal(await guest.locator('#joinCode').inputValue(), code);
  await guest.locator('#nickname').fill('백돌 검증');
  await guest.locator('#joinGame').click();
  await Promise.all([waitTurn(host, '흑'), waitText(guest, '#blackName', '흑돌 검증'), waitText(host, '#whiteName', '백돌 검증')]);
  assert.notEqual((await profile(host)).id, (await profile(guest)).id);
  const transports = await Promise.all(participants.map(page => page.evaluate(() => window.badukTest.welcomed ? 'WebSocket' : window.badukTest.httpWelcomed ? 'HTTP' : 'unknown')));
  assert.ok(transports.every(t => t === 'WebSocket' || (allowHttp && t === 'HTTP')), `online transports: ${transports.join(', ')}`);
  if (simultaneous) assert.deepEqual(transports, ['WebSocket', 'WebSocket']);

  await duplicateNext(host, 'play');
  await playPoint(host, 0, 0);
  await Promise.all(participants.map(page => waitMove(page, 1)));
  const earlyState = await guest.evaluate(() => window.badukTest.lastState);
  assert.equal(earlyState.room.size, 19);
  assert.equal(earlyState.room.game.board.length, 361);
  assert.equal(earlyState.room.game.board[0], 1);
  assert.ok(await host.evaluate(() => window.badukTest.duplicated?.action.type === 'play'));
  assert.equal(await host.locator('#pass').isDisabled(), true);
  await playPoint(host, 9, 9); // a second click while the opponent owns the turn
  assert.equal(await host.locator('#moves').textContent(), '1수');

  // Close the host's active connection while its opponent makes the next move.
  if (transports[0] === 'WebSocket') {
    await desktop.setOffline(true);
    await host.evaluate(() => window.badukTest.socket.close());
    await waitText(host, '#statusText', '다시 연결');
  } else {
    // HTTP stream recovery across a fresh document uses the same stored account.
    await host.goto('about:blank');
  }
  await waitTurn(guest, '백');
  await playPoint(guest, 18, 18);
  await waitMove(guest, 2);
  if (earlyState && transports[1] === 'WebSocket') {
    // Simulate a delayed notification already superseded by the next move.
    // Detect a rollback even if a newer event fixes the display shortly afterwards.
    await guest.evaluate(stale => {
      window.badukTest.rollback = false;
      const moves = document.getElementById('moves');
      const observer = new MutationObserver(() => {
        if (parseInt(moves.textContent, 10) < 2) window.badukTest.rollback = true;
      });
      observer.observe(moves, { childList: true });
      window.badukTest.stopObserving = () => observer.disconnect();
      window.badukTest.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(stale) }));
    }, earlyState);
  }
  if (transports[0] === 'WebSocket') await desktop.setOffline(false);
  else await host.goto(site.href, { waitUntil: 'domcontentloaded' });
  await waitMove(host, 2);
  await waitTurn(host, '흑');
  assert.equal((await host.locator('#roomCode').textContent()).trim(), code);
  await host.reload({ waitUntil: 'domcontentloaded' });
  await waitMove(host, 2);
  await waitTurn(host, '흑');
  assert.equal((await host.locator('#roomCode').textContent()).trim(), code);
  assert.equal((await profile(host)).coins, 100);

  await playPoint(host, 0, 18);
  await waitTurn(guest, '백');
  await playPoint(guest, 18, 0);
  await Promise.all(participants.map(page => waitMove(page, 4)));
  const corners = await guest.evaluate(() => [0, 18, 342, 360].map(point => window.badukTest.lastState.room.game.board[point]));
  assert.deepEqual(corners, [1, 2, 1, 2], 'all four outer intersections accept real clicks/taps');
  await auditBoth('active');

  await host.locator('#pass').click();
  await waitTurn(guest, '백');
  await guest.locator('#pass').click();
  await Promise.all(participants.map(page => page.locator('#scoringControls').waitFor({ state: 'visible' })));
  await auditBoth('scoring');
  assert.ok(await guest.evaluate(() => { window.badukTest.stopObserving?.(); return !window.badukTest.rollback; }), 'late state rolled back the board');
  await duplicateNext(host, 'confirmScore');
  if (simultaneous) {
    await duplicateNext(guest, 'confirmScore');
    await simultaneousDecision('confirmScore', '#confirmScore');
  } else {
    await guest.locator('#confirmScore').click();
    await waitText(guest, '#statusText', '기다립니다');
    await host.waitForFunction(() => window.badukTest.lastState?.room?.game.confirmed.includes(2));
    assert.equal((await profile(guest)).history.length, 0);
    await host.locator('#confirmScore').click();
  }
  await Promise.all(participants.map(page => waitText(page, '#statusText', '백 6.5집 승')));
  await auditBoth('finished');
  const finalCommand = await host.evaluate(() => window.badukTest.duplicated);
  assert.equal(finalCommand.action.type, 'confirmScore');
  await Promise.all([checkLedger(host, false, finalCommand.matchId), checkLedger(guest, true, finalCommand.matchId)]);
  await openTool(host, '#historyNav');
  await waitText(host, '#profileStats', '35코인');
  assert.equal(await host.locator('#historyList li').count(), 1);
  await waitText(host, '#historyList', '-65코인');
  await host.locator('#historyDialog .modal-close').click();

  if (simultaneous) {
    await simultaneousDecision('rematch', '#rematch');
  } else {
    await host.locator('#rematch').click();
    await waitText(host, '#rematch', '기다리는 중');
    await guest.waitForFunction(() => window.badukTest.lastState?.room?.rematch.includes(1));
    await guest.locator('#rematch').click();
  }
  await Promise.all(participants.map(page => waitMove(page, 0)));
  await waitTurn(guest, '흑');
  await waitText(host, '#blackName', '백돌 검증');
  if (await host.evaluate(() => window.badukTest.socket?.readyState === WebSocket.OPEN)) {
    await host.evaluate(command => window.badukTest.socket.send(JSON.stringify(command)), finalCommand);
  }
  await playPoint(guest, 4, 4);
  await Promise.all(participants.map(page => waitMove(page, 1)));
  await waitTurn(host, '백');
  await Promise.all([checkLedger(host, false, finalCommand.matchId), checkLedger(guest, true, finalCommand.matchId)]);

  // Close the test accounts' rematch and leave their room through normal controls.
  await host.locator('#resign').click();
  await host.locator('#confirmYes').click();
  await Promise.all(participants.map(page => waitText(page, '#statusText', '흑 불계승')));
  const closedRoomState = await guest.evaluate(() => window.badukTest.lastState);
  await host.locator('#settingsOpen').click();
  await host.locator('[data-mode="practice"]').click();
  await host.locator('#createGame').click();
  await Promise.all(participants.map(page => waitText(page, '#modeTag', '연습 대국')));
  if (closedRoomState && transports[1] === 'WebSocket') {
    await guest.evaluate(stale => {
      window.badukTest.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(stale) }));
    }, closedRoomState);
    assert.equal(await guest.locator('#modeTag').textContent(), '연습 대국', 'late state reopened the closed room');
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ site: site.href, transports, room: 'created, joined, restored, rematched, closed', board: '19×19', corners, simultaneous, settlement: { margin: 6.5, debit: 65, credit: 65, copiesPerAccount: 1 }, viewportChecks: layoutSamples.length, viewports: [...desktops, ...phones].map(s => `${s.width}×${s.height}`) }));
} catch (error) {
  if (pageErrors.length) console.error('Browser errors:', pageErrors);
  for (const [i, page] of participants.entries()) {
    const status = await page.locator('#statusText').textContent({ timeout: 1500 }).catch(() => '');
    const setup = await page.locator('#setupStatus').textContent({ timeout: 1500 }).catch(() => '');
    const toast = await page.locator('#toast').textContent({ timeout: 1500 }).catch(() => '');
    const timeline = await page.evaluate(() => window.badukTest?.timeline).catch(() => []);
    console.error(`Browser ${i + 1}: ${status} ${setup} ${toast} ${JSON.stringify(timeline)}`);
  }
  throw error;
} finally {
  await browser.close();
}
