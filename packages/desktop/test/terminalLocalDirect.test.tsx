// R1 PR-4(스레드 8d233406): 데스크톱이 같은 맥 러너의 터미널에 오퍼레이터 소켓으로 직결하는 경로 선택과 폴백.
// 지키는 것: 이 맥 세션일 때만 control 로 붙는다(security n3) · 서버가 보통 attach 로 되돌리면(옛 러너·옛 오퍼레이터)
// 지금처럼 서버 출력을 그린다(n6) · 오퍼레이터가 입력을 거절하면 같은 바이트를 서버로 보낸다(n5) · 구독이 실패하면
// 보통 attach 로 다시 붙는다 · 패널을 닫으면 직결 구독도 끊는다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import type { AgentSessionView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { usePrefsStore } from '../src/state/prefsStore';
import { TerminalPanel } from '../src/components/TerminalPanel';
import { setTerminalSinkFactory, type TerminalSinkOptions } from '../src/lib/terminalSink';
import { setLocalTerminalPort, type LocalRefusal, type LocalTerminalPort } from '../src/lib/localTerminal';
import { acc } from './helpers/fakeApi';

const session = (): AgentSessionView => ({
  sessionId: 'sess-1', acceptsInput: true, agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1',
  harness: 'claude-code', startedAt: '2026-10-12T00:00:00.000Z',
});

class FakeSocket {
  static all: FakeSocket[] = [];
  static readonly OPEN = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  readyState = 1;
  sent: string[] = [];
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  deliver(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const VIEW = 'v'.repeat(32);
const WKEY = 'w'.repeat(32);

function fakePort(opts: { local?: boolean; subscribe?: LocalRefusal | null; input?: LocalRefusal | null } = {}) {
  let out: ((b: string) => void) | null = null;
  let ended: ((r: string | null) => void) | null = null;
  const port = {
    isLocal: vi.fn(async () => opts.local ?? true),
    subscribe: vi.fn(async () => opts.subscribe ?? null),
    unsubscribe: vi.fn(async () => {}),
    input: vi.fn(async (_s: string, _k: string, _d: string): Promise<LocalRefusal | null> => opts.input ?? null),
    resize: vi.fn(async () => null),
    listen: vi.fn(async (_s: string, cb: { onOutput(b: string): void; onEnded(r: string | null): void }) => {
      out = cb.onOutput; ended = cb.onEnded;
      return () => { out = null; ended = null; };
    }),
  } satisfies LocalTerminalPort;
  return { port, emit: (s: string) => out?.(b64(s)), end: (r: string) => ended?.(r) };
}

async function mount(port: LocalTerminalPort | null) {
  const written: string[] = [];
  let sinkOpts: TerminalSinkOptions | undefined;
  const resets = { n: 0 };
  setTerminalSinkFactory((_el, o) => {
    sinkOpts = o;
    return {
      write: (bytes) => written.push(Buffer.from(bytes).toString('utf8')),
      resetLatency: () => { resets.n += 1; },
      dispose: () => {},
    };
  });
  setLocalTerminalPort(port);
  let n = 0;
  const api = {
    baseUrl: 'http://localhost:8080',
    agentSessions: vi.fn(async () => [session()]),
    attachAgentSession: vi.fn(async () => ({ ticket: `murt_${(n += 1)}`, session: session() })),
    openInteractiveSession: vi.fn(),
  };
  setController({ api } as unknown as Controller);
  useAppStore.getState().set({
    me: acc('u1', 'owner'),
    accounts: { a1: { ...acc('a1', 'forge', 'agent'), ownerAccountId: 'u1' } },
    terminalTarget: { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1' },
  });
  render(<TerminalPanel />);
  await act(flush);
  return {
    written, api, resets,
    type: (s: string) => sinkOpts!.onInput!(s),
    diag: () => sinkOpts!.onDiagnostics!({ renderer: 'webgl', compositions: 0, imeKeys: 0, hangulKeys: 0, echo: null }),
  };
}

beforeEach(() => {
  useAppStore.getState().reset();
  usePrefsStore.getState().setLocale('ko');
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLocalTerminalPort(undefined);
  setController(null as unknown as Controller);
});

describe('경로 선택(security n3)', () => {
  it('이 맥 세션이 아니면 control 로 붙지 않는다', async () => {
    const { port } = fakePort({ local: false });
    await mount(port);
    expect(port.isLocal).toHaveBeenCalledWith('sess-1');
    expect(FakeSocket.all[0]!.url).not.toContain('mode=control');
  });

  it('직결 표면이 없으면(웹·옛 앱) 묻지도 않고 서버 경유다', async () => {
    await mount(null);
    expect(FakeSocket.all[0]!.url).not.toContain('mode=control');
  });

  it('이 맥 세션이면 control 로 붙고, 받은 열람 키로 구독해 오퍼레이터 출력을 그린다', async () => {
    const { port, emit } = fakePort();
    const { written } = await mount(port);
    const ws = FakeSocket.all[0]!;
    expect(ws.url).toContain('mode=control');
    await act(async () => { ws.deliver({ type: 'local', viewKey: VIEW }); await flush(); });
    expect(port.subscribe).toHaveBeenCalledWith('sess-1', VIEW);
    await act(async () => { emit('직결 화면'); });
    expect(written).toEqual(['직결 화면']);
  });
});

describe('입력 경로와 폴백(n5)', () => {
  it('writer 키가 있으면 입력은 오퍼레이터 소켓으로 가고 서버 WS 로는 안 간다', async () => {
    const { port } = fakePort();
    const { type } = await mount(port);
    const ws = FakeSocket.all[0]!;
    await act(async () => {
      ws.deliver({ type: 'writer', writer: true, resize: true, reason: null, writerKey: WKEY });
      ws.deliver({ type: 'local', viewKey: VIEW });
      await flush();
    });
    await act(async () => { type('a'); await flush(); });
    expect(port.input).toHaveBeenCalledWith('sess-1', WKEY, b64('a'));
    expect(ws.sent.filter((f) => f.includes('"input"'))).toEqual([]);
  });

  it('오퍼레이터가 not-writer 로 거절하면 같은 바이트를 서버로 보내고, 그 뒤로는 서버로만 보낸다', async () => {
    const { port } = fakePort({ input: 'not-writer' });
    const { type } = await mount(port);
    const ws = FakeSocket.all[0]!;
    await act(async () => {
      ws.deliver({ type: 'writer', writer: true, resize: true, reason: null, writerKey: WKEY });
      ws.deliver({ type: 'local', viewKey: VIEW });
      await flush();
    });
    await act(async () => { type('a'); await flush(); });
    await act(async () => { type('b'); await flush(); });
    expect(port.input).toHaveBeenCalledTimes(1);
    expect(ws.sent.filter((f) => f.includes('"input"')).map((f) => (JSON.parse(f) as { data: string }).data)).toEqual([b64('a'), b64('b')]);
  });
});

describe('서버가 보통 attach 로 되돌렸을 때(n6)', () => {
  it('local 프레임이 안 오면(옛 러너·옛 오퍼레이터) 구독하지 않고 서버 출력을 그대로 그린다', async () => {
    const { port } = fakePort();
    const { written, type } = await mount(port);
    const ws = FakeSocket.all[0]!;
    await act(async () => {
      ws.deliver({ type: 'writer', writer: false, resize: false, reason: 'runner-outdated' });
      ws.deliver({ type: 'output', data: b64('서버 화면') });
      await flush();
    });
    expect(port.subscribe).not.toHaveBeenCalled();
    expect(written).toEqual(['서버 화면']);
    await act(async () => { type('x'); await flush(); });
    expect(port.input).not.toHaveBeenCalled();
  });

  it('writer 키 없이 차례만 오면(보통 attach) 입력은 서버로 간다', async () => {
    const { port } = fakePort();
    const { type } = await mount(port);
    const ws = FakeSocket.all[0]!;
    await act(async () => { ws.deliver({ type: 'writer', writer: true, resize: true, reason: null }); await flush(); });
    await act(async () => { type('y'); await flush(); });
    expect(port.input).not.toHaveBeenCalled();
    expect(ws.sent.some((f) => f.includes(b64('y')))).toBe(true);
  });
});

describe('구독 실패·회수·닫기', () => {
  it('구독이 거절되면 새 티켓으로 보통 attach 에 다시 붙는다', async () => {
    const { port } = fakePort({ subscribe: 'not-viewer' });
    const { api } = await mount(port);
    await act(async () => { FakeSocket.all[0]!.deliver({ type: 'local', viewKey: VIEW }); await flush(); });
    expect(api.attachAgentSession).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[0]!.closed).toBe(true);
    expect(FakeSocket.all[1]!.url).not.toContain('mode=control');
  });

  it('오퍼레이터가 구독을 거두면(revoked) 보통 attach 로 다시 붙는다', async () => {
    const { port, end } = fakePort();
    await mount(port);
    await act(async () => { FakeSocket.all[0]!.deliver({ type: 'local', viewKey: VIEW }); await flush(); });
    await act(async () => { end('revoked'); await flush(); });
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1]!.url).not.toContain('mode=control');
  });

  it('패널을 닫으면 직결 구독도 끊는다', async () => {
    const { port } = fakePort();
    await mount(port);
    await act(async () => { FakeSocket.all[0]!.deliver({ type: 'local', viewKey: VIEW }); await flush(); });
    await act(async () => { screen.getByLabelText('터미널 닫기').click(); });
    expect(port.unsubscribe).toHaveBeenCalledWith('sess-1');
  });
});

/** 직결로 붙고 writer 키·열람 키까지 받은 상태. */
async function attachedLocal(port: LocalTerminalPort) {
  const m = await mount(port);
  const ws = FakeSocket.all[0]!;
  await act(async () => {
    ws.deliver({ type: 'writer', writer: true, resize: true, reason: null, writerKey: WKEY });
    ws.deliver({ type: 'local', viewKey: VIEW });
    await flush();
  });
  return { ...m, ws };
}

describe('직결 입력의 순서(security #1340 F1)', () => {
  it('앞 요청이 끝나기 전에는 다음을 보내지 않고, 그동안 쌓인 바이트는 한 덩어리로 순서대로 보낸다', async () => {
    const { port } = fakePort();
    const releases: (() => void)[] = [];
    port.input.mockImplementation(() => new Promise<LocalRefusal | null>((resolve) => { releases.push(() => resolve(null)); }));
    const { type } = await attachedLocal(port);
    await act(async () => { type('a'); type('b'); type('\r'); await flush(); });
    // 첫 요청만 나가 있다 — 둘째·셋째 키는 기다린다.
    expect(port.input).toHaveBeenCalledTimes(1);
    expect(port.input.mock.calls[0]![2]).toBe(b64('a'));
    await act(async () => { releases[0]!(); await flush(); });
    expect(port.input).toHaveBeenCalledTimes(2);
    expect(port.input.mock.calls[1]![2]).toBe(b64('b\r'));
  });
});

describe('직결 실패 뒤의 입력(security #1340 n1, designer s1)', () => {
  it('invoke 가 던지면(unavailable) 그 바이트는 서버로 다시 보내지 않고, 다음부터 서버 경유다', async () => {
    const { port } = fakePort({ input: 'unavailable' });
    const { type, ws } = await attachedLocal(port);
    await act(async () => { type('\r'); await flush(); });
    expect(ws.sent.filter((f) => f.includes('"input"'))).toEqual([]);
    await act(async () => { type('z'); await flush(); });
    expect(port.input).toHaveBeenCalledTimes(1);
    expect(ws.sent.filter((f) => f.includes('"input"')).map((f) => (JSON.parse(f) as { data: string }).data)).toEqual([b64('z')]);
  });

  it('입력만 서버로 떨어지면 경로는 「로컬 직결(입력만 서버 경유)」이고, 길이 바뀔 때마다 지연 표본을 비운다', async () => {
    const { port } = fakePort({ input: 'not-writer' });
    const { type, diag, resets } = await attachedLocal(port);
    await act(async () => { diag(); });
    expect(screen.getByTestId('terminal-latency').getAttribute('data-path')).toBe('local');
    const before = resets.n;
    await act(async () => { type('a'); await flush(); });
    expect(screen.getByTestId('terminal-latency').getAttribute('data-path')).toBe('mixed');
    expect(screen.getByTestId('terminal-latency').textContent).toContain('로컬 직결(입력만 서버 경유)');
    expect(resets.n).toBe(before + 1);
  });
});

describe('구독 결과 전의 입력(security #1340 n4)', () => {
  function delayedSubscribe(result: LocalRefusal | null) {
    const f = fakePort();
    let release: () => void = () => {};
    f.port.subscribe.mockImplementation(() => new Promise<LocalRefusal | null>((resolve) => { release = () => resolve(result); }));
    return { ...f, release: () => release() };
  }

  it('구독 결과를 기다리는 동안 친 키는 잡아 두었다가, 성공하면 직결로 순서대로 보낸다', async () => {
    const { port, release } = delayedSubscribe(null);
    const { type } = await mount(port);
    const ws = FakeSocket.all[0]!;
    await act(async () => {
      ws.deliver({ type: 'local', viewKey: VIEW });
      ws.deliver({ type: 'writer', writer: true, resize: true, reason: null, writerKey: WKEY });
      await flush();
    });
    await act(async () => { type('l'); type('s'); await flush(); });
    expect(port.input).not.toHaveBeenCalled();
    expect(ws.sent.filter((f) => f.includes('"input"'))).toEqual([]);
    await act(async () => { release(); await flush(); });
    expect(port.input).toHaveBeenCalledTimes(1);
    expect(port.input.mock.calls[0]![2]).toBe(b64('ls'));
    expect(ws.sent.filter((f) => f.includes('"input"'))).toEqual([]);
  });

  it('구독이 실패하면 잡아 둔 키를 지금 소켓으로 먼저 흘리고 보통 attach 로 갈아탄다', async () => {
    const { port, release } = delayedSubscribe('not-viewer');
    const { type } = await mount(port);
    const ws = FakeSocket.all[0]!;
    await act(async () => {
      ws.deliver({ type: 'local', viewKey: VIEW });
      ws.deliver({ type: 'writer', writer: true, resize: true, reason: null, writerKey: WKEY });
      await flush();
    });
    await act(async () => { type('q'); await flush(); });
    expect(ws.sent.filter((f) => f.includes('"input"'))).toEqual([]);
    await act(async () => { release(); await flush(); });
    expect(ws.sent.filter((f) => f.includes('"input"')).map((f) => (JSON.parse(f) as { data: string }).data)).toEqual([b64('q')]);
    expect(port.input).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(2);
  });
});

