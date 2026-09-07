/**
 * 계정 풀 요청의 **dispatch 층** — 소켓 없이 잰다.
 *
 * `server.test.ts` 는 진짜 unix 소켓 위에서 도는데, 그것이 재는 것은 **소켓의 성질**이다
 * (임시 이름 bind 가 정규 이름을 서비스하는가 등 — 커널이 만드는 성질이라 실물이 필요하다).
 * 여기서 재는 것은 **말의 해석**이다: payload 를 어떻게 검증하고, 포트가 없을 때 무엇으로
 * 답하고, 어느 오류 갈래를 쓰는가. 그 셋은 소켓과 무관하므로 소켓을 세우지 않는다.
 *
 * `dispatch` 가 private 이라 캐스팅으로 부른다. 프로덕션 우회가 아니라 **우리 클래스의
 * 우리 테스트**이고, 이 층을 공개 표면으로 끌어올리면 소켓 밖에서 요청을 받을 수 있다는
 * 잘못된 신호가 된다 — 그쪽이 더 나쁘다.
 */
import { describe, expect, it, vi } from 'vitest';

import { REQUEST_TYPES, EVENT_NAMES, type DaemonRequest } from '@murmur/shared/daemonProtocol';

import { DaemonServer, type DaemonServerDeps } from '../src/server.js';
import type { ClaudeAccountsPort } from '../src/claudeAccounts.js';

const IDENTITY = { pid: 1, startedAtMs: 0, entryPath: '/x', appVersion: '0', launchNonce: 'n' };

function fakePort(over: Partial<ClaudeAccountsPort> = {}): ClaudeAccountsPort {
  return {
    list: vi.fn(async () => ({
      root: '/r', mode: 'flat' as const, defaultPool: null, agents: {}, pools: [], strays: [],
    })),
    configure: vi.fn(async () => undefined),
    removeAccount: vi.fn(async () => undefined),
    removePool: vi.fn(async () => undefined),
    move: vi.fn(async () => ({ loggedIn: true })),
    loginStart: vi.fn(async () => ({ loginId: 'lid' })),
    loginSubmit: vi.fn(async () => undefined),
    loginCancel: vi.fn(async () => undefined),
    shutdownLogins: vi.fn(async () => undefined),
    onLoginEvent: vi.fn(),
    ...over,
  };
}

function server(claudeAccounts?: ClaudeAccountsPort): {
  send: (type: string, payload?: unknown) => Promise<unknown>;
  logs: string[];
} {
  const logs: string[] = [];
  const deps = {
    token: 't', identity: IDENTITY,
    registry: { listRunners: () => [], currentIncarnation: () => null } as unknown as DaemonServerDeps['registry'],
    log: (l: string) => logs.push(l),
    ...(claudeAccounts ? { claudeAccounts } : {}),
  } as DaemonServerDeps;
  const srv = new DaemonServer(deps);
  const send = (type: string, payload?: unknown): Promise<unknown> =>
    (srv as unknown as { dispatch(r: DaemonRequest): Promise<unknown> })
      .dispatch({ id: 'i', type: type as DaemonRequest['type'], payload });
  return { send, logs };
}

function isError(v: unknown): v is { code: string; message: string } {
  return typeof v === 'object' && v !== null && 'code' in v && 'message' in v;
}

describe('프로토콜 등록', () => {
  it('여덟 요청이 REQUEST_TYPES 에 있다 — 없으면 소켓이 그 말을 거절한다', () => {
    for (const t of [
      'claudeAccountsList', 'claudeAccountsConfigure', 'claudeAccountLoginStart',
      'claudeAccountLoginSubmit', 'claudeAccountLoginCancel', 'claudeAccountRemove',
      'claudePoolRemove', 'claudeAccountMove',
    ]) {
      expect(REQUEST_TYPES as readonly string[]).toContain(t);
    }
  });

  it('로그인 출력 이벤트가 EVENT_NAMES 에 있다', () => {
    // 없으면 `parseEvent` 가 그 이벤트를 버려 앱이 URL 을 영원히 못 본다.
    expect(EVENT_NAMES as readonly string[]).toContain('claudeLoginOutput');
  });
});

describe('포트가 배선되지 않았을 때', () => {
  it('unknown-request 가 아니라 "못 한다"로 답한다', async () => {
    // 프로토콜이 아는 요청이므로 모른다고 하면 앱이 프로토콜 버전을 의심한다
    // (`adoptRunner` 가 같은 판단을 한 자리다).
    const { send } = server();
    const res = await send('claudeAccountsList');
    expect(isError(res)).toBe(true);
    if (isError(res)) {
      expect(res.code).not.toBe('unknown-request');
      expect(res.message).toMatch(/배선/);
    }
  });
});

describe('payload 검증', () => {
  it('계정 참조에 pool·account 가 둘 다 있어야 한다', async () => {
    const { send } = server(fakePort());
    for (const bad of [undefined, {}, { pool: 'work' }, { account: 'lime' }, { pool: 1, account: 'x' }]) {
      const res = await send('claudeAccountRemove', bad);
      expect(isError(res), JSON.stringify(bad)).toBe(true);
    }
    expect(isError(await send('claudeAccountRemove', { pool: 'work', account: 'lime' }))).toBe(false);
  });

  it('로그인 코드 제출에 loginId·code 가 둘 다 있어야 한다', async () => {
    const { send } = server(fakePort());
    for (const bad of [{}, { loginId: 'x' }, { code: 'c' }, { loginId: 'x', code: 1 }]) {
      expect(isError(await send('claudeAccountLoginSubmit', bad))).toBe(true);
    }
    expect(isError(await send('claudeAccountLoginSubmit', { loginId: 'x', code: 'c' }))).toBe(false);
  });

  it('너무 긴 코드를 거절한다 — stdin 에 통째로 붓기 전에 끊는다', async () => {
    const { send } = server(fakePort());
    const res = await send('claudeAccountLoginSubmit', { loginId: 'x', code: 'a'.repeat(5000) });
    expect(isError(res)).toBe(true);
  });

  it('설정 payload 의 모양을 잰다', async () => {
    const { send } = server(fakePort());
    for (const bad of [
      undefined, {},
      { defaultPool: 1, order: {}, agents: {} },
      { defaultPool: null, order: [], agents: {} },
      { defaultPool: null, order: {}, agents: [] },
      { defaultPool: null, order: { work: 'x' }, agents: {} },
      { defaultPool: null, order: {}, agents: { a1: 9 } },
    ]) {
      expect(isError(await send('claudeAccountsConfigure', bad)), JSON.stringify(bad)).toBe(true);
    }
    expect(isError(await send('claudeAccountsConfigure', {
      defaultPool: 'work', order: { work: ['lime'] }, agents: { a1: 'work' },
    }))).toBe(false);
  });

  it('설정 payload 를 정규화하지 않고 그대로 포트에 넘긴다', async () => {
    // 여기서 정규화하면 웹뷰가 보낸 잘못된 이름이 조용히 버려져, 포트의 "이름이 떨어져
    // 나가면 던진다"가 도달 불가능해진다 — 그 판정이 UI 와 디스크의 어긋남을 잡는
    // 유일한 자리다.
    const configure = vi.fn(async () => undefined);
    const { send } = server(fakePort({ configure }));
    await send('claudeAccountsConfigure', { defaultPool: '../escape', order: {}, agents: {} });
    expect(configure).toHaveBeenCalledWith({ defaultPool: '../escape', order: {}, agents: {} });
  });
});

describe('포트가 던지면 bad-request 갈래로 답한다', () => {
  it('삭제 실패가 소켓을 끊지 않는다', async () => {
    // 포트는 "없는 것을 지우려 하면" 던진다. 그것으로 연결이 끊기면 UI 가 다시 붙어야 한다.
    const { send } = server(fakePort({
      removeAccount: vi.fn(async () => { throw new Error('계정이 없다: work/ghost'); }),
    }));
    const res = await send('claudeAccountRemove', { pool: 'work', account: 'ghost' });
    expect(isError(res)).toBe(true);
    if (isError(res)) expect(res.message).toMatch(/계정이 없다/);
  });
});

describe('로그', () => {
  it('계정 이름은 적고 코드는 적지 않는다', async () => {
    // 코드로 자격증명을 교환할 수 있다 — PAT 를 로그에 안 적는 규율과 같다.
    const { send, logs } = server(fakePort());
    await send('claudeAccountLoginStart', { pool: 'work', account: 'lime' });
    await send('claudeAccountLoginSubmit', { loginId: 'lid', code: 'SECRET-CODE' });
    const joined = logs.join('\n');
    expect(joined).toContain('work/lime');
    expect(joined).not.toContain('SECRET-CODE');
  });
});
