import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const site = new URL(process.argv[2] || process.env.BADUK_SITE_URL || 'http://localhost:4189/');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const desktop = await browser.newContext({ viewport: { width: 1320, height: 920 } });
const mobile = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const host = await desktop.newPage();
const guest = await mobile.newPage();
const participants = [host, guest];
const pageErrors = [];
const forceHttp = process.env.BADUK_BLOCK_WEBSOCKET === '1';
const allowHttp = forceHttp || process.env.BADUK_ALLOW_HTTP === '1';
const simultaneous = process.env.BADUK_SIMULTANEOUS === '1';

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
  const pad = Math.max(16, width * 0.061);
  const gap = (width - 2 * pad) / 8;
  await canvas.click({ position: { x: pad + x * gap, y: pad + y * gap } });
}

async function checkWidth(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
    board: document.getElementById('board').getBoundingClientRect().toJSON(),
  }));
  assert.equal(dimensions.viewport, 360);
  assert.ok(dimensions.content <= dimensions.viewport, 'mobile page scrolls horizontally');
  assert.ok(dimensions.board.width > 240 && dimensions.board.left >= 0 && dimensions.board.right <= dimensions.viewport, 'mobile board fits viewport');
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
  await checkWidth(guest);
  await host.locator('#friendQuick').click();
  await host.locator('#nickname').fill('흑돌 검증');
  await host.locator('#sizes [data-value="9"]').click();
  await host.locator('#createGame').click();
  await host.locator('#roomStrip').waitFor({ state: 'visible' });
  const code = (await host.locator('#roomCode').textContent()).trim();
  assert.match(code, /^[A-Z2-9]{6}$/);
  const invitation = new URL(site);
  invitation.searchParams.set('room', code);
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
  await playPoint(host, 2, 2);
  await Promise.all(participants.map(page => waitMove(page, 1)));
  await waitText(guest, '#moveLog', 'C7');
  const earlyState = await guest.evaluate(() => window.badukTest.lastState);
  assert.ok(await host.evaluate(() => window.badukTest.duplicated?.action.type === 'play'));
  assert.equal(await host.locator('#pass').isDisabled(), true);
  await playPoint(host, 0, 0); // a second click while the opponent owns the turn
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
  await playPoint(guest, 6, 6);
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

  await host.locator('#pass').click();
  await waitTurn(guest, '백');
  await guest.locator('#pass').click();
  await Promise.all(participants.map(page => page.locator('#scoringControls').waitFor({ state: 'visible' })));
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
  const finalCommand = await host.evaluate(() => window.badukTest.duplicated);
  assert.equal(finalCommand.action.type, 'confirmScore');
  await Promise.all([checkLedger(host, false, finalCommand.matchId), checkLedger(guest, true, finalCommand.matchId)]);
  await host.locator('#historyNav').click();
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
  await checkWidth(guest);

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
  console.log(JSON.stringify({ site: site.href, transports, room: 'created, joined, restored, rematched, closed', simultaneous, settlement: { margin: 6.5, debit: 65, credit: 65, copiesPerAccount: 1 }, mobileWidth: 360 }));
} catch (error) {
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
