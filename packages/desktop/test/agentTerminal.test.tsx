// #141 Phase 2 — 데스크탑 쪽 회귀선. 두 가지를 지킨다:
//   4. 소유자·admin 이 아니면 진입점이 **렌더되지 않는다**(비활성 아님 — 부재).
//   8. 패널을 닫으면 구독이 끊긴다(WS 메시지가 더 오지 않는다).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { AgentSessionView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { TerminalChip } from '../src/components/TerminalChip';
import { TerminalPanel } from '../src/components/TerminalPanel';
import { setTerminalSinkFactory, type TerminalSinkOptions } from '../src/lib/terminalSink';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, fakeApi, msg } from './helpers/fakeApi';

const agent = (id: string, handle: string, ownerAccountId: string | null) =>
  ({ ...acc(id, handle, 'agent'), ownerAccountId });

// #339: 칩은 이제 눌린 메시지를 안다 — 렌더 판정만 보는 테스트도 메시지를 넘겨야 한다.
// 채널 최상위 메시지라 앵커는 자기 자신(m1)이다.
const chipMsg = msg('m1', 'c1', 1, '다 됐다', 'a1');

const session = (overrides: Partial<AgentSessionView> = {}): AgentSessionView => ({
  sessionId: 'sess-1',
  // #369: 기본은 입력이 닿는 세션이다 — 관찰 전용(멘션 턴)은 테스트가 명시한다.
  acceptsInput: true,
  agentAccountId: 'a1',
  channelId: 'c1',
  threadRootId: 'm1',
  harness: 'claude-code',
  startedAt: '2026-09-04T00:00:00.000Z',
  ...overrides,
});

/**
 * jsdom 에는 `WebSocket` 이 있지만 실제로 접속을 시도한다. 여기서 필요한 것은 접속이
 * 아니라 **닫혔는지**와 **닫힌 뒤에도 프레임이 화면에 닿는지**이므로 가짜로 바꾼다.
 */
class FakeSocket {
  static last: FakeSocket | null = null;
  /** 브라우저 WebSocket 의 상수. `sendInput` 이 이 값으로 열림을 판정한다(#315). */
  static readonly OPEN = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  readyState = 1;
  /** 클라이언트가 서버로 보낸 원문 프레임들(#315 — 사람이 친 것이 여기 실린다). */
  sent: string[] = [];
  constructor(public url: string) { FakeSocket.last = this; }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  /** 서버가 프레임을 보낸 것처럼 흉내낸다. */
  deliver(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

beforeEach(() => {
  useAppStore.getState().reset();
  FakeSocket.last = null;
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setController(null as unknown as Controller);
});

describe('#141-4 진입점은 소유자·admin 에게만 렌더된다', () => {
  it('소유자에게는 칩이 뜬다', () => {
    useAppStore.getState().set({ me: acc('u1', 'owner'), accounts: { a1: agent('a1', 'forge', 'u1') } });
    render(<TerminalChip account={agent('a1', 'forge', 'u1')} message={chipMsg} />);
    expect(screen.getByText('터미널 보기')).toBeTruthy();
  });

  it('admin 에게도 뜬다 — 서버의 checkOwnerOrAdmin 과 같은 판정이어야 한다', () => {
    useAppStore.getState().set({ me: acc('u9', 'admin', 'human', true) });
    render(<TerminalChip account={agent('a1', 'forge', 'u1')} message={chipMsg} />);
    expect(screen.getByText('터미널 보기')).toBeTruthy();
  });

  it('소유자도 admin 도 아니면 **아무것도 렌더하지 않는다** — 비활성 버튼이 아니다', () => {
    useAppStore.getState().set({ me: acc('u2', 'stranger') });
    const { container } = render(<TerminalChip account={agent('a1', 'forge', 'u1')} message={chipMsg} />);
    // 부재를 본다. `disabled` 버튼을 찾는 방식으로 쓰면 "비활성으로 보여 주기"가 통과한다 —
    // 그것은 남의 러너 셸이 여기 있다는 사실을 새게 하므로 스펙 §5 의 요구가 아니다.
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('소유자가 없는 에이전트(null)에는 admin 에게만 뜬다', () => {
    // `008` 이 backfill 을 넣지 않은 것은 의도였다(#181) — null 은 "아무나"가 아니라
    // "아직 아무도"다. null 을 "일치"로 읽으면 소유자 미지정 에이전트가 전원에게 열린다.
    useAppStore.getState().set({ me: acc('u1', 'owner') });
    const { container } = render(<TerminalChip account={agent('a2', 'orphan', null)} message={chipMsg} />);
    expect(container.innerHTML).toBe('');

    cleanup();
    useAppStore.getState().set({ me: acc('u9', 'admin', 'human', true) });
    render(<TerminalChip account={agent('a2', 'orphan', null)} message={chipMsg} />);
    expect(screen.getByText('터미널 보기')).toBeTruthy();
  });

  it('사람 계정에는 칩을 만들지 않는다', () => {
    useAppStore.getState().set({ me: acc('u9', 'admin', 'human', true) });
    const { container } = render(<TerminalChip account={acc('u3', 'alice')} message={chipMsg} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('#141-8 패널을 닫으면 구독이 끊긴다', () => {
  const mountPanel = async (sessions: AgentSessionView[] = [session()]) => {
    const written: Uint8Array[] = [];
    setTerminalSinkFactory(() => ({
      write: (bytes) => written.push(bytes),
      dispose: () => { /* 가짜라 정리할 것이 없다 */ },
    }));
    const api = {
      baseUrl: 'http://localhost:8080',
      agentSessions: vi.fn(async () => sessions),
      attachAgentSession: vi.fn(async () => ({ ticket: 'murt_x', session: sessions[0]! })),
    };
    setController({ api } as unknown as Controller);
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { a1: agent('a1', 'forge', 'u1') },
      terminalTarget: { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1' },
    });
    const view = render(<TerminalPanel />);
    // attach 왕복(두 번의 await)이 끝날 때까지 마이크로태스크를 흘린다.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return { written, api, view };
  };

  it('열려 있는 동안 받은 바이트는 터미널에 쓰인다', async () => {
    const { written } = await mountPanel();
    expect(FakeSocket.last).not.toBeNull();
    await act(async () => { FakeSocket.last!.deliver({ type: 'output', data: b64('이전 화면') }); });
    expect(written).toHaveLength(1);
    expect(Buffer.from(written[0]!).toString('utf8')).toBe('이전 화면');
  });

  it('닫기를 누르면 소켓이 닫히고, 그 뒤 프레임은 터미널에 닿지 않는다', async () => {
    const { written } = await mountPanel();
    const socket = FakeSocket.last!;
    await act(async () => { socket.deliver({ type: 'output', data: b64('전') }); });
    expect(written).toHaveLength(1);

    await act(async () => { screen.getByLabelText('터미널 닫기').click(); });

    // 소켓이 실제로 닫혔다. 이것만 보면 "닫았다고 주장하지만 계속 받는" 경우를 못 잡는다.
    expect(socket.closed).toBe(true);
    // 그래서 닫힌 뒤에 프레임을 하나 더 밀어 넣어 본다 — 늘어나면 구독이 살아 있는 것이다.
    await act(async () => { socket.deliver({ type: 'output', data: b64('후') }); });
    expect(written).toHaveLength(1);
    // 패널 자체도 사라진다(스토어의 terminalTarget 이 null 이 된다).
    expect(screen.queryByLabelText('에이전트 터미널')).toBeNull();
  });

  it('진행 중인 턴이 없으면 그 사실을 말하고 소켓을 열지 않는다', async () => {
    // "없다"와 "못 읽었다"를 같은 화면으로 그리지 않는다(docs/design.md §4).
    await mountPanel([]);
    expect(screen.getByText(/진행 중인 턴이 없다/)).toBeTruthy();
    expect(FakeSocket.last).toBeNull();
  });
});

/**
 * #337 — 진행 중인 턴이 없어도 사람이 스스로 연다. no-session 화면의 [터미널 열기]가
 * REST 로 러너에 인터랙티브 PTY 를 띄우게 하고, 돌아온 티켓으로 **기존 attach 흐름에
 * 합류한다** — 열기 전용 소켓 경로를 따로 만들지 않는 것이 이 배선의 요점이다.
 */
describe('#337 [터미널 열기] — 세션이 없어도 스스로 연다', () => {
  const mountNoSession = async (api: Record<string, unknown>) => {
    setTerminalSinkFactory(() => ({ write: () => { /* 배선만 본다 */ }, dispose: () => {} }));
    setController({ api } as unknown as Controller);
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { a1: agent('a1', 'forge', 'u1') },
      terminalTarget: { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1' },
    });
    render(<TerminalPanel />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  };

  it('버튼이 스토어의 target 세 필드로 REST 를 부르고, 받은 티켓으로 attach 소켓이 열린다', async () => {
    const api = {
      baseUrl: 'http://localhost:8080',
      agentSessions: vi.fn(async () => []),
      attachAgentSession: vi.fn(),
      openInteractiveSession: vi.fn(async () => ({ ticket: 'murt_opened', session: session() })),
    };
    await mountNoSession(api);
    expect(FakeSocket.last).toBeNull();

    await act(async () => { screen.getByText('터미널 열기').click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // 스레드 스코프 그대로 — 세션이 없으므로 세션 id 가 아니라 (에이전트, 채널, 스레드)다.
    expect(api.openInteractiveSession).toHaveBeenCalledWith('a1', 'c1', 'm1');
    // 기존 attach 경로에 합류했다 — 별도 소켓 경로가 아니라 같은 티켓 소켓이다.
    expect(FakeSocket.last).not.toBeNull();
    expect(FakeSocket.last!.url).toContain('murt_opened');
    // attach REST 는 부르지 않는다 — 인터랙티브 open 의 응답이 이미 티켓이다.
    expect(api.attachAgentSession).not.toHaveBeenCalled();
  });

  it('열기 실패(러너 오프라인·구버전·codex 거절)는 서버 문구 그대로 error 화면에 온다', async () => {
    const api = {
      baseUrl: 'http://localhost:8080',
      agentSessions: vi.fn(async () => []),
      openInteractiveSession: vi.fn(async () => {
        throw new Error('codex 인터랙티브 턴은 지원하지 않는다');
      }),
    };
    await mountNoSession(api);

    await act(async () => { screen.getByText('터미널 열기').click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // 화면이 문구를 다시 쓰지 않는다 — 원인을 아는 것은 서버(러너)다.
    expect(screen.getByText(/codex 인터랙티브 턴은 지원하지 않는다/)).toBeTruthy();
    expect(FakeSocket.last).toBeNull();
  });

  it('세션이 이미 있으면 열기 버튼 없이 곧장 붙는다 — 열기는 no-session 의 것이다', async () => {
    const api = {
      baseUrl: 'http://localhost:8080',
      agentSessions: vi.fn(async () => [session()]),
      attachAgentSession: vi.fn(async () => ({ ticket: 'murt_x', session: session() })),
      openInteractiveSession: vi.fn(),
    };
    await mountNoSession(api);
    expect(screen.queryByText('터미널 열기')).toBeNull();
    expect(api.openInteractiveSession).not.toHaveBeenCalled();
    expect(api.attachAgentSession).toHaveBeenCalledWith('sess-1');
  });
});

/**
 * #315·#346 — 사람이 이 패널에 타이핑한다. 쓰기 차례는 서버의 `writer` 프레임이 정한다
 * (스펙 §5-2 결정 2 — 마지막 attach 가 writer). 화면 쪽이 지켜야 하는 것 세 가지:
 *   1. writer 통지를 받은 창의 타이핑만 소켓으로 나간다.
 *   2. 통지가 **한 번도 안 오면**(구 서버) 아무것도 보내지 않는다 — 4방향 호환의 절반.
 *   3. 강등(writer:false)이 오면 그 순간부터 다시 보내지 않고, 왜인지가 화면에 있다.
 */
describe('#315 writer 인 창만 친다 — 차례는 서버가 정한다', () => {
  const mountPanel = async () => {
    let opts: { onInput?: (data: string) => void } | undefined;
    setTerminalSinkFactory((_el, o) => {
      opts = o;
      return { write: () => { /* 이 describe 는 출력이 아니라 입력을 본다 */ }, dispose: () => {} };
    });
    const api = {
      baseUrl: 'http://localhost:8080',
      agentSessions: vi.fn(async () => [session()]),
      attachAgentSession: vi.fn(async () => ({ ticket: 'murt_x', session: session() })),
    };
    setController({ api } as unknown as Controller);
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { a1: agent('a1', 'forge', 'u1') },
      terminalTarget: { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1' },
    });
    render(<TerminalPanel />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return { sinkOpts: () => opts };
  };

  it('writer 통지를 받은 창의 타이핑이 input 프레임으로 나간다', async () => {
    const { sinkOpts } = await mountPanel();
    await act(async () => { FakeSocket.last!.deliver({ type: 'writer', writer: true, resize: true, reason: null }); });

    // xterm 이 키를 넘기는 것을 흉내낸다. 제어 시퀀스를 섞는다 — 글자만 보내면
    // 인코딩이 깨져도 통과한다.
    await act(async () => { sinkOpts()!.onInput!('\x1b[Ayes\r'); });

    expect(FakeSocket.last!.sent).toHaveLength(1);
    const frame = JSON.parse(FakeSocket.last!.sent[0]!) as { type: string; data: string };
    expect(frame.type).toBe('input');
    expect(Buffer.from(frame.data, 'base64').toString('utf8')).toBe('\x1b[Ayes\r');
    // 차례가 있다는 사실도 화면에 있다 — 두 창을 쓰는 사람이 어느 쪽이 살아 있는지
    // 여기서 읽는다.
    expect(screen.getByTestId('writer-note').textContent).toContain('입력 가능');
  });

  it('writer 프레임이 한 번도 안 오면(구 서버) 아무것도 보내지 않는다', async () => {
    const { sinkOpts } = await mountPanel();
    // 통지 없이 바로 친다 — 구 서버는 writer 프레임을 모르고, 그때 보낸 input 은 서버가
    // 해석하지 못한다. 보내지 않는 것이 "자연스러운 읽기 전용 저하"다(스펙 §5-2 결정 2).
    await act(async () => { sinkOpts()!.onInput!('hello\r'); });
    expect(FakeSocket.last!.sent).toEqual([]);
  });

  it('강등(writer:false)이 오면 그 뒤의 타이핑은 나가지 않고 이유가 화면에 있다', async () => {
    const { sinkOpts } = await mountPanel();
    await act(async () => { FakeSocket.last!.deliver({ type: 'writer', writer: true, resize: true, reason: null }); });
    await act(async () => { sinkOpts()!.onInput!('a'); });
    expect(FakeSocket.last!.sent).toHaveLength(1);

    // 다른 창이 attach 해 서버가 이 창을 강등시켰다.
    await act(async () => { FakeSocket.last!.deliver({ type: 'writer', writer: false, resize: false, reason: 'other-writer' }); });
    await act(async () => { sinkOpts()!.onInput!('b'); });

    // 강등 뒤에 친 것은 나가지 않는다 — state 가 아니라 ref 가 가드해야 이 순간이 잡힌다.
    expect(FakeSocket.last!.sent).toHaveLength(1);
    // 이유가 보인다. 비활성만 하고 이유를 안 적으면 사람은 고장으로 읽는다.
    expect(screen.getByTestId('writer-note').textContent).toContain('읽기 전용');
    expect(screen.getByTestId('writer-note').textContent).toContain('다른 창');
  });
});

/**
 * #335 — 패널 크기가 PTY 크기가 된다. 화면 쪽 절반이다:
 *   1(클라이언트 절반). writer 패널의 크기가 attach 소켓으로 나간다.
 *   3. **writer 가 아닌 패널의 크기는 아무것도 안 바꾼다** — 화면이 그 값을 버린다.
 *
 * #346(writer 규칙) 이후 판정 주체가 canInput(attach 시점 고정)에서 writer 통지(차례)로
 * 옮겨졌다 — "읽기 전용은 아무것도 바꾸지 않는다"는 원 근거는 그대로다. 이것만으로 3 을
 * 단언했다고 하면 안 된다(`#315` 에서 실측된 함정). 브라우저가 소켓에 직접 프레임을
 * 보내는 경로는 이 테스트가 못 지나고, 그 절반은 서버 쪽 `agentResize.test.ts` 의
 * `#335-2` 가 실제 소켓으로 잰다.
 */
describe('#335 writer 의 폭이 PTY 폭이 되고, 읽기 전용 창의 폭은 아무것도 안 바꾼다', () => {
  const mountPanel = async () => {
    let opts: TerminalSinkOptions | undefined;
    const refit = vi.fn();
    setTerminalSinkFactory((_el, o) => {
      opts = o;
      return { write: () => { /* 이 describe 는 출력이 아니라 크기를 본다 */ }, refit, dispose: () => {} };
    });
    const api = {
      baseUrl: 'http://localhost:8080',
      agentSessions: vi.fn(async () => [session()]),
      attachAgentSession: vi.fn(async () => ({ ticket: 'murt_x', session: session() })),
    };
    setController({ api } as unknown as Controller);
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { a1: agent('a1', 'forge', 'u1') },
      // #339 이후 대상은 3필드다 — `session()` 기본값(a1/c1/m1)과 일치해야 패널이 붙는다.
      terminalTarget: { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1' },
    });
    render(<TerminalPanel />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return { sinkOpts: () => opts, refit };
  };

  it('writer 패널의 크기가 attach 소켓에 resize 프레임으로 나간다', async () => {
    const { sinkOpts } = await mountPanel();
    await act(async () => { FakeSocket.last!.deliver({ type: 'writer', writer: true, resize: true, reason: null }); });

    // 터미널이 컨테이너에 맞춘 결과를 알려 오는 것을 흉내낸다.
    await act(async () => { sinkOpts()!.onResize!(100, 30); });

    expect(FakeSocket.last!.sent).toHaveLength(1);
    const frame = JSON.parse(FakeSocket.last!.sent[0]!) as { type: string; cols: number; rows: number };
    expect(frame).toEqual({ type: 'resize', cols: 100, rows: 30 });
  });

  it('writer 통지가 없으면(구 서버 포함) 크기를 아무 데도 보내지 않는다', async () => {
    const { sinkOpts } = await mountPanel();

    // **가드가 값을 버린다.** writer 규칙에서는 배선 자체는 항상 있고(차례가 언제든
    // 올 수 있다) 가드가 최신 차례를 읽는다 — 읽기 전용은 아무것도 바꾸지 않는다.
    await act(async () => { sinkOpts()!.onResize!(40, 10); });
    // 소켓으로 아무것도 나가지 않았다.
    expect(FakeSocket.last!.sent).toEqual([]);
  });

  it('승격 직후 refit 으로 자기 크기를 한 번 보고한다 — 승격 전의 보고는 버려졌다', async () => {
    const { refit } = await mountPanel();
    expect(refit).not.toHaveBeenCalled();
    await act(async () => { FakeSocket.last!.deliver({ type: 'writer', writer: true, resize: true, reason: null }); });
    // 스펙 §5 "attach 시 writer 의 크기로 resize" — 이 재보고가 없으면 PTY 가 이전
    // writer(또는 spawn 기본값)의 크기로 남는다.
    expect(refit).toHaveBeenCalledTimes(1);
    // 강등은 재보고할 것이 없다.
    await act(async () => { FakeSocket.last!.deliver({ type: 'writer', writer: false, resize: false, reason: 'other-writer' }); });
    expect(refit).toHaveBeenCalledTimes(1);
  });
});

/**
 * #369 — 진행 중인 멘션 턴은 관찰 전용이고, 화면이 **왜**인지 말한다.
 *
 * 이 결함의 본체는 "입력이 안 간다"가 아니라 **화면이 거짓말을 했다**는 것이다: 사람이
 * 입력 가능 상태를 보고 타이핑하는데 바이트가 조용히 사라졌다. 그래서 여기서 지키는 것은
 * 세 가지다 — 못 친다는 것, 커서가 깜빡이지 않는다는 것(입력창 비활성), 그리고 **왜**가
 * 글로 있다는 것. 셋 중 마지막이 빠지면 "눌러도 아무 일이 없는 버튼"이 그대로 남는다.
 *
 * 그리고 **폭은 계속 나간다**(#335 회귀 금지). 관찰 전용 창도 폭의 주인이다 — 여기서
 * 폭까지 막으면 진행 중인 턴을 보는 화면이 러너의 spawn 기본값(120x40)에 갇혀 접힌다.
 */
describe('#369 관찰 전용 세션 — 못 치는 이유가 화면에 있다', () => {
  const mountPanel = async () => {
    let opts: { onInput?: (data: string) => void; onResize?: (c: number, r: number) => void } | undefined;
    const readOnly: boolean[] = [];
    setTerminalSinkFactory((_el, o) => {
      opts = o;
      return {
        write: () => { /* 이 describe 는 출력이 아니라 개입 가능 여부를 본다 */ },
        setReadOnly: (v: boolean) => { readOnly.push(v); },
        dispose: () => {},
      };
    });
    const api = {
      baseUrl: 'http://localhost:8080',
      // 진행 중인 멘션 턴이다 — 러너가 "이 세션은 입력을 받을 수 없다"로 announce 한 것.
      agentSessions: vi.fn(async () => [session({ acceptsInput: false, mode: 'mention' })]),
      attachAgentSession: vi.fn(async () => ({ ticket: 'murt_x', session: session({ acceptsInput: false }) })),
    };
    setController({ api } as unknown as Controller);
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { a1: agent('a1', 'forge', 'u1') },
      terminalTarget: { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1' },
    });
    render(<TerminalPanel />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return { sinkOpts: () => opts, readOnly };
  };

  it('입력창이 비활성이고, 왜 못 치는지가 화면에 적혀 있다', async () => {
    const { sinkOpts, readOnly } = await mountPanel();
    await act(async () => {
      FakeSocket.last!.deliver({ type: 'writer', writer: false, resize: true, reason: 'observe-only' });
    });

    // 쳐도 나가지 않는다.
    await act(async () => { sinkOpts()!.onInput!('yes\r'); });
    expect(FakeSocket.last!.sent).toEqual([]);

    // 입력창 자체가 비활성이다 — 가드가 바이트를 버리는 것만으로는 커서가 계속 깜빡여
    // "칠 수 있다"로 보인다.
    expect(readOnly.at(-1)).toBe(true);

    // **이유가 있다.** "관찰 전용"만 적으면 임의의 제약으로 읽혀 "왜 안 되냐"가 다시
    // 결함으로 올라온다 — 프롬프트를 파일로 받는다는 사실이 이 제약의 전부다.
    const note = screen.getByTestId('writer-note');
    expect(note.getAttribute('data-writer-reason')).toBe('observe-only');
    expect(note.textContent).toContain('관찰 전용');
    expect(note.textContent).toContain('프롬프트를 파일로');
    // 다른 창 탓으로 돌리지 않는다 — 아무도 안 붙었는데 없는 사람을 만들어 내면 안 된다.
    expect(note.textContent).not.toContain('다른 창');
  });

  it('관찰 전용이어도 폭은 나간다 — resize 는 stdin 과 무관하다 (#335 회귀 금지)', async () => {
    const { sinkOpts } = await mountPanel();
    await act(async () => {
      FakeSocket.last!.deliver({ type: 'writer', writer: false, resize: true, reason: 'observe-only' });
    });

    await act(async () => { sinkOpts()!.onResize!(100, 30); });

    expect(FakeSocket.last!.sent).toHaveLength(1);
    expect(JSON.parse(FakeSocket.last!.sent[0]!)).toEqual({ type: 'resize', cols: 100, rows: 30 });
  });
});

/**
 * #141 배선 — 진입점과 패널이 **앱에서 실제로 닿는가**.
 *
 * 위의 두 describe 는 `TerminalChip`·`TerminalPanel` 을 손으로 props 를 넘겨 띄운다.
 * 그것만으로는 두 컴포넌트가 앱 트리에 **연결돼 있지 않아도** 전부 초록이다 — 실측했다:
 * `MessageItem` 의 `<TerminalChip>` 한 줄과 `Workspace` 의 `<TerminalPanel>` 한 줄을
 * 각각 지워도 데스크탑 테스트 879건이 모두 통과했다. 그러면 이 기능은 코드로는 존재하고
 * 앱에서는 없는 상태가 되고, 회귀선은 그것을 한마디도 말하지 않는다.
 *
 * 그래서 여기서는 `Workspace` 를 통째로 띄워, 메시지 행의 칩을 눌러 패널이 열리는
 * **한 경로**를 끝까지 지난다.
 */
describe('#141 배선 — Workspace 에서 칩을 눌러 패널이 열린다', () => {
  const mountApp = (extra: Record<string, unknown> = {}, api = fakeApi()) => {
    setController({
      api,
      openChannel: vi.fn().mockResolvedValue(undefined),
      openThread: vi.fn(), closeThread: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
      notifyTyping: vi.fn(), refreshAccounts: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(), loadOlder: vi.fn(),
      goBack: vi.fn().mockResolvedValue(false), goForward: vi.fn().mockResolvedValue(false),
    } as unknown as Controller);
    setTerminalSinkFactory(() => ({ write: () => { /* 배선만 본다 */ }, dispose: () => { /* 같음 */ } }));
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'forge', 'u1'), a2: agent('a2', 'other', 'u9') },
      channels: [chan('c1', 'general')],
      connected: true,
      activeChannelId: 'c1',
      ...extra,
    });
    return render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
  };

  it('내가 소유한 에이전트의 메시지 행에 칩이 있고, 누르면 터미널 패널이 열린다', async () => {
    const api = fakeApi({ agentSessions: vi.fn(async () => [session({ agentAccountId: 'a1' })]) });
    mountApp({ messages: { c1: [msg('m1', 'c1', 1, '다 됐다', 'a1')] } }, api);

    // 패널은 아직 없다 — 칩을 누르기 전에 열려 있으면 이 테스트가 아무것도 지키지 않는다.
    expect(screen.queryByLabelText('에이전트 터미널')).toBeNull();

    await act(async () => { screen.getByText('터미널 보기').click(); });

    // 패널이 실제로 트리에 붙었다 — `Workspace` 가 `TerminalPanel` 을 렌더한다는 뜻이다.
    expect(screen.getByLabelText('에이전트 터미널')).toBeTruthy();
    // 그리고 그 패널이 세션을 물어 소켓까지 열었다 — 칩 → 스토어 → 패널 → attach 가
    // 한 경로로 이어져 있다는 뜻이고, 그것이 이 배선 테스트가 지키려는 전부다.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(api.agentSessions).toHaveBeenCalled();
    expect(FakeSocket.last).not.toBeNull();
  });

  it('남이 소유한 에이전트의 메시지 행에는 앱 어디에도 칩이 없다', () => {
    mountApp({ messages: { c1: [msg('m1', 'c1', 1, '다 됐다', 'a2')] } });
    expect(screen.queryByText('터미널 보기')).toBeNull();
  });

  it('사람이 쓴 메시지 행에는 칩이 없다', () => {
    mountApp({ messages: { c1: [msg('m1', 'c1', 1, '안녕', 'u1')] } });
    expect(screen.queryByText('터미널 보기')).toBeNull();
  });
});

/**
 * #339 — 칩·패널은 스레드에 스코프된다.
 *
 * 세션은 (에이전트, 스레드)당 하나라(스펙 §5), 같은 에이전트가 스레드 여럿에서 동시에
 * 턴을 돌 수 있다. 예전 상태(`terminalAgentId` 하나)에서는 패널이 에이전트 일치만 보고
 * **임의의 첫 세션**에 붙었다 — A 스레드에서 눌렀는데 B 스레드의 PTY 가 열렸다. 여기서
 * 지키는 것은 두 문장이다: 칩은 눌린 메시지의 스레드 세션을 고르고, 다른 스레드의
 * 세션에는 붙지 않는다.
 */
describe('#339 칩·패널은 스레드에 스코프된다 — 같은 에이전트 다중 세션', () => {
  const mountApp = (extra: Record<string, unknown> = {}, api = fakeApi()) => {
    setController({
      api,
      openChannel: vi.fn().mockResolvedValue(undefined),
      openThread: vi.fn(), closeThread: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
      notifyTyping: vi.fn(), refreshAccounts: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(), loadOlder: vi.fn(),
      goBack: vi.fn().mockResolvedValue(false), goForward: vi.fn().mockResolvedValue(false),
    } as unknown as Controller);
    setTerminalSinkFactory(() => ({ write: () => { /* 스코프만 본다 */ }, dispose: () => { /* 같음 */ } }));
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'forge', 'u1') },
      channels: [chan('c1', 'general')],
      connected: true,
      activeChannelId: 'c1',
      ...extra,
    });
    return render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
  };

  it('칩은 눌린 메시지의 스레드 세션을 고른다 — 같은 에이전트의 다른 스레드 세션이 앞에 있어도', async () => {
    // 같은 에이전트 a1 의 세션 셋: 첫 스레드(m1) · 다른 채널의 같은 스레드 id(c9/m2) ·
    // 눌릴 스레드(m2). 목록 순서가 함정이다 — 에이전트 일치만 보면 sess-A 에 붙고,
    // 채널을 안 보면 sess-X 에 붙는다. 정답은 sess-B 하나뿐이다.
    const sessions = [
      session({ sessionId: 'sess-A', threadRootId: 'm1' }),
      session({ sessionId: 'sess-X', channelId: 'c9', threadRootId: 'm2' }),
      session({ sessionId: 'sess-B', threadRootId: 'm2' }),
    ];
    const api = fakeApi({ agentSessions: vi.fn(async () => sessions) });
    // 채널 최상위 멘션 둘 = 스레드 둘. 앵커는 각 메시지 자신이다(#98).
    mountApp({ messages: { c1: [msg('m1', 'c1', 1, '첫 스레드', 'a1'), msg('m2', 'c1', 2, '둘째 스레드', 'a1')] } }, api);

    // 두 번째 행(m2)의 칩을 누른다 — 행은 seq 순이므로 인덱스 1 이 m2 다.
    await act(async () => { screen.getAllByText('터미널 보기')[1]!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // 칩이 앵커식으로 target 을 채웠고(최상위라 자기 자신이 루트),
    expect(useAppStore.getState().terminalTarget).toEqual({ agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm2' });
    // 패널이 세 필드 일치로 **그 스레드의** 세션에 붙었다.
    expect(api.attachAgentSession).toHaveBeenCalledTimes(1);
    expect(api.attachAgentSession).toHaveBeenCalledWith('sess-B');
  });

  it('스레드 안 메시지의 칩은 자기 id 가 아니라 스레드 루트를 앵커로 채운다', async () => {
    useAppStore.getState().set({ me: acc('u1', 'owner') });
    render(<TerminalChip
      account={agent('a1', 'forge', 'u1')}
      message={msg('m7', 'c1', 7, '진행 중', 'a1', { threadRootId: 't1' })}
    />);
    await act(async () => { screen.getByText('터미널 보기').click(); });
    // m7 을 앵커로 쓰면 러너의 세션 키(스레드 루트)와 어긋나 패널이 세션을 못 찾는다.
    expect(useAppStore.getState().terminalTarget).toEqual({ agentAccountId: 'a1', channelId: 'c1', threadRootId: 't1' });
  });

  it('다른 스레드의 세션이나 스레드 미상(null) 세션에는 붙지 않는다', async () => {
    // target 은 m1 스레드인데 목록에는 m2 세션과 threadRootId 미상 세션뿐이다.
    // 예전처럼 에이전트 일치만 보면 여기서 sess-B 에 붙는다 — 그것이 이 이슈의 결함이다.
    const api = {
      baseUrl: 'http://localhost:8080',
      agentSessions: vi.fn(async () => [
        session({ sessionId: 'sess-B', threadRootId: 'm2' }),
        session({ sessionId: 'sess-N', threadRootId: null }),
      ]),
      attachAgentSession: vi.fn(),
    };
    setController({ api } as unknown as Controller);
    setTerminalSinkFactory(() => ({ write: () => { /* 붙지 않아야 한다 */ }, dispose: () => { /* 같음 */ } }));
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { a1: agent('a1', 'forge', 'u1') },
      terminalTarget: { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1' },
    });
    render(<TerminalPanel />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // attach 자체가 없어야 한다 — 엉뚱한 세션의 티켓을 받는 순간 이미 결함이다.
    expect(api.attachAgentSession).not.toHaveBeenCalled();
    expect(FakeSocket.last).toBeNull();
    expect(screen.getByText(/진행 중인 턴이 없다/)).toBeTruthy();
  });

  it('헤더가 어느 채널·스레드의 터미널인지 적는다', async () => {
    const api = fakeApi({ agentSessions: vi.fn(async () => [session()]) });
    setController({ api } as unknown as Controller);
    setTerminalSinkFactory(() => ({ write: () => { /* 헤더만 본다 */ }, dispose: () => { /* 같음 */ } }));
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { a1: agent('a1', 'forge', 'u1') },
      channels: [chan('c1', 'general')],
      messages: { c1: [msg('m1', 'c1', 1, '배포 준비', 'a1')] },
      terminalTarget: { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1' },
    });
    render(<TerminalPanel />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // 채널 이름과 스레드 루트 본문이 함께 보인다 — 같은 에이전트의 터미널이 여럿일 수
    // 있으니, 지금 보는 화면이 어느 스레드의 것인지 헤더가 말해야 한다.
    expect(screen.getByTestId('terminal-scope').textContent).toBe('#general · 배포 준비');
  });
});
