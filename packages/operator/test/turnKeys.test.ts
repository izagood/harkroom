// 턴 열쇠(좁은 턴 자격) — 장부(`turnKeys.ts`)와 링크 인증(`runnerLink.ts`)을 함께 잰다. 가짜 소켓 페어는
// runnerLink.test.ts 와 같은 꼴이다.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { encodeLine, NdjsonDecoder } from '@harkroom/shared/daemonProtocol';
import { TURN_KEYS_END_PATH, TURN_KEYS_PATH, type RunnerLinkKind, type RunnerLinkRequest, type RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { createRunnerLinkServer, type LinkSocket } from '../src/runnerLink.js';
import { createTurnKeyLedger, isWrapperCall, TURN_KEY_MAX_AGE_MS, TURN_KEYS_PER_RUNNER } from '../src/turnKeys.js';

function fakeSocket() {
  const em = new EventEmitter();
  const written: string[] = [];
  let destroyed = false;
  const socket: LinkSocket = {
    write: (line) => { written.push(String(line)); return true; },
    destroy: () => { destroyed = true; em.emit('close'); },
    on: (ev, fn) => { em.on(ev, fn); return socket; },
    removeAllListeners: (ev) => { em.removeAllListeners(ev); return socket; },
  };
  const feed = (value: unknown) => em.emit('data', Buffer.from(encodeLine(value)));
  const lines = (): unknown[] => new NdjsonDecoder().push(written.join('')).filter((l) => l.ok).map((l) => (l as { value: unknown }).value);
  return { socket, feed, lines, destroyed: () => destroyed };
}

const BRIDGE = 'a'.repeat(64);
const SHELL = 'b'.repeat(64);
const put = (body: unknown, path = TURN_KEYS_PATH): RunnerLinkRequest => ({ type: 'http.forward', id: 'q1', method: 'POST', path, body: JSON.stringify(body) });
const status = (res: RunnerLinkResponse | null) => (res && 'status' in res ? res.status : null);
const keyHello = (runnerId: string, turnKey: string, kind: RunnerLinkKind) => ({ type: 'hello', version: 1, role: 'runner', runnerId, turnKey, kind });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('턴 열쇠 장부', () => {
  it('relay 에서만 맡기고 끝낸다 — 하네스가 여는 소켓이면 403', () => {
    const ledger = createTurnKeyLedger();
    const body = { turnId: 't1', cause: 'm1', keys: { bridge: BRIDGE, shell: SHELL } };
    for (const kind of ['bridge', 'hook', 'wrapper'] as const) expect(status(ledger.maybeHandle('r-1', put(body), kind))).toBe(403);
    expect(ledger.size()).toBe(0);
    expect(status(ledger.maybeHandle('r-1', put(body), 'relay'))).toBe(200);
    expect(ledger.lookup(SHELL)).toEqual({ runnerId: 'r-1', scope: 'shell', turnId: 't1', cause: 'm1' });
    expect(ledger.lookup(BRIDGE)?.scope).toBe('bridge');
    expect(status(ledger.maybeHandle('r-1', put({ turnId: 't1' }, TURN_KEYS_END_PATH), 'hook'))).toBe(403);
    expect(status(ledger.maybeHandle('r-1', put({ turnId: 't1' }, TURN_KEYS_END_PATH), 'relay'))).toBe(200);
    expect(ledger.lookup(SHELL)).toBeNull();
    expect(ledger.lookup(BRIDGE)).toBeNull();
  });

  it('32바이트 hex 가 아니거나 두 열쇠가 같으면 거절한다 · 다른 경로는 넘긴다', () => {
    const ledger = createTurnKeyLedger();
    for (const keys of [{ bridge: 'short', shell: SHELL }, { bridge: BRIDGE, shell: BRIDGE }, { bridge: BRIDGE.toUpperCase(), shell: SHELL }, {}]) {
      expect(status(ledger.maybeHandle('r-1', put({ turnId: 't1', keys }), 'relay'))).toBe(400);
    }
    expect(ledger.maybeHandle('r-1', put({}, '/agent/turn-slots'), 'relay')).toBeNull();
  });

  it('러너를 잊으면 그 러너의 열쇠가 다 죽는다 · 수명이 지나면 못 쓴다', () => {
    let t = 1_000;
    const ledger = createTurnKeyLedger({ now: () => t });
    ledger.maybeHandle('r-1', put({ turnId: 't1', keys: { bridge: BRIDGE, shell: SHELL } }), 'relay');
    ledger.maybeHandle('r-2', put({ turnId: 't2', keys: { bridge: 'c'.repeat(64), shell: 'd'.repeat(64) } }), 'relay');
    ledger.forgetRunner('r-1');
    expect(ledger.lookup(SHELL)).toBeNull();
    expect(ledger.lookup('d'.repeat(64))?.runnerId).toBe('r-2');
    t += TURN_KEY_MAX_AGE_MS + 1;
    expect(ledger.lookup('d'.repeat(64))).toBeNull();
    ledger.sweep();
    expect(ledger.size()).toBe(0);
  });

  it('러너 하나가 쥘 턴 수에 상한이 있다', () => {
    const ledger = createTurnKeyLedger();
    const hex = (n: number, c: string) => n.toString(16).padStart(8, '0') + c.repeat(56);
    for (let i = 0; i < TURN_KEYS_PER_RUNNER; i++) {
      expect(status(ledger.maybeHandle('r-1', put({ turnId: `t${i}`, keys: { bridge: hex(i, 'a'), shell: hex(i, 'b') } }), 'relay'))).toBe(200);
    }
    expect(status(ledger.maybeHandle('r-1', put({ turnId: 'over', keys: { bridge: hex(999, 'a'), shell: hex(999, 'b') } }), 'relay'))).toBe(429);
  });
});

describe('턴 열쇠로 링크에 붙기', () => {
  const setup = () => {
    const ledger = createTurnKeyLedger();
    const seen: { req: RunnerLinkRequest; kind: RunnerLinkKind }[] = [];
    const link = createRunnerLinkServer({
      onFrame: () => {}, log: () => {}, turnKeys: ledger,
      onRequest: async (_r, _a, req, kind) => { seen.push({ req, kind }); return { type: 'mcp.response', id: req.id, messages: [] }; },
    });
    link.expect('r-1', 'agent-a', 'link-secret');
    ledger.maybeHandle('r-1', put({ turnId: 't1', cause: 'm-real', keys: { bridge: BRIDGE, shell: SHELL } }), 'relay');
    return { ledger, link, seen };
  };

  it('열쇠끼리 kind 를 못 넘는다 — 셸 열쇠는 hook·wrapper, 다리 열쇠는 bridge 만, 둘 다 relay 는 못 연다(K1)', () => {
    const { link } = setup();
    const cases: [string, RunnerLinkKind, boolean][] = [
      [SHELL, 'hook', true], [SHELL, 'wrapper', true], [SHELL, 'bridge', false], [SHELL, 'relay', false],
      [BRIDGE, 'bridge', true], [BRIDGE, 'hook', false], [BRIDGE, 'wrapper', false], [BRIDGE, 'relay', false],
    ];
    for (const [key, kind, ok] of cases) {
      const s = fakeSocket();
      expect([key === SHELL ? 'shell' : 'bridge', kind, link.accept(s.socket, keyHello('r-1', key, kind), [])]).toEqual([key === SHELL ? 'shell' : 'bridge', kind, ok]);
    }
    expect(link.isLinked('r-1')).toBe(false);
  });

  it('다른 러너 이름으로는 못 붙고, 끝난 턴·잊힌 러너의 열쇠도 거절한다', () => {
    const { ledger, link } = setup();
    link.expect('r-2', 'agent-b', 'other');
    expect(link.accept(fakeSocket().socket, keyHello('r-2', SHELL, 'wrapper'), [])).toBe(false);
    ledger.maybeHandle('r-1', put({ turnId: 't1' }, TURN_KEYS_END_PATH), 'relay');
    expect(link.accept(fakeSocket().socket, keyHello('r-1', SHELL, 'wrapper'), [])).toBe(false);
    ledger.maybeHandle('r-1', put({ turnId: 't2', keys: { bridge: BRIDGE, shell: SHELL } }), 'relay');
    link.forget('r-1');
    expect(ledger.lookup(SHELL)).toBeNull();
  });

  it('열쇠로 붙은 소켓의 요청은 cause·턴 id 를 장부 값으로 싣는다 — 셸이 지어 넣은 값은 버린다', async () => {
    const { link, seen } = setup();
    const s = fakeSocket();
    expect(link.accept(s.socket, keyHello('r-1', SHELL, 'wrapper'), [])).toBe(true);
    s.feed({ type: 'mcp.request', id: 'x1', payload: { method: 'tools/call' }, cause: 'm-forged', turnId: 't-forged' });
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('wrapper');
    expect(seen[0]?.req).toMatchObject({ cause: 'm-real', turnId: 't1' });
    // 옛 secret 으로 붙은 소켓은 지금처럼 요청의 값을 그대로 넘긴다(P3 까지 옛 길).
    const old = fakeSocket();
    expect(link.accept(old.socket, { type: 'hello', version: 1, role: 'runner', runnerId: 'r-1', secret: 'link-secret', kind: 'bridge' }, [])).toBe(true);
    old.feed({ type: 'mcp.request', id: 'x2', payload: {}, cause: 'm-env' });
    await flush();
    expect(seen[1]?.req).toMatchObject({ cause: 'm-env' });
  });

  it('열쇠로 붙은 소켓의 http.forward 는 403 — 서버로 나가지 않는다(다리·hook·래퍼 모두)', async () => {
    const { link, seen } = setup();
    for (const [key, kind] of [[BRIDGE, 'bridge'], [SHELL, 'hook'], [SHELL, 'wrapper']] as const) {
      const s = fakeSocket();
      expect(link.accept(s.socket, keyHello('r-1', key, kind), [])).toBe(true);
      s.feed({ type: 'http.forward', id: `f-${kind}`, method: 'POST', path: '/agent/anything', body: JSON.stringify({ cause: 'm-forged' }) });
      await flush();
      expect(s.lines()).toEqual([{ type: 'http.response', id: `f-${kind}`, status: 403, body: 'a turn-key link only carries mcp.request' }]);
    }
    expect(seen).toHaveLength(0);
  });
});

describe('래퍼 소켓이 받는 것', () => {
  it('머지·api 도구의 tools/call 만 — 다른 MCP 도구·REST 는 아니다(K4)', () => {
    const call = (name: string, method = 'tools/call'): RunnerLinkRequest => ({ type: 'mcp.request', id: 'x', payload: { jsonrpc: '2.0', id: 1, method, params: { name, arguments: {} } } });
    expect(isWrapperCall(call('repo.merge'))).toBe(true);
    expect(isWrapperCall(call('api.call'))).toBe(true);
    expect(isWrapperCall(call('message.post'))).toBe(false);
    expect(isWrapperCall(call('secret.mount'))).toBe(false);
    expect(isWrapperCall(call('repo.merge', 'tools/list'))).toBe(false);
    expect(isWrapperCall(put({}, '/agent/config'))).toBe(false);
  });
});
