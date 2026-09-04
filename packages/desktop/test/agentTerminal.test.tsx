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

const session = (overrides: Partial<AgentSessionView> = {}): AgentSessionView => ({
  sessionId: 'sess-1',
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
    render(<TerminalChip account={agent('a1', 'forge', 'u1')} />);
    expect(screen.getByText('터미널 보기')).toBeTruthy();
  });

  it('admin 에게도 뜬다 — 서버의 checkOwnerOrAdmin 과 같은 판정이어야 한다', () => {
    useAppStore.getState().set({ me: acc('u9', 'admin', 'human', true) });
    render(<TerminalChip account={agent('a1', 'forge', 'u1')} />);
    expect(screen.getByText('터미널 보기')).toBeTruthy();
  });

  it('소유자도 admin 도 아니면 **아무것도 렌더하지 않는다** — 비활성 버튼이 아니다', () => {
    useAppStore.getState().set({ me: acc('u2', 'stranger') });
    const { container } = render(<TerminalChip account={agent('a1', 'forge', 'u1')} />);
    // 부재를 본다. `disabled` 버튼을 찾는 방식으로 쓰면 "비활성으로 보여 주기"가 통과한다 —
    // 그것은 남의 러너 셸이 여기 있다는 사실을 새게 하므로 스펙 §5 의 요구가 아니다.
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('소유자가 없는 에이전트(null)에는 admin 에게만 뜬다', () => {
    // `008` 이 backfill 을 넣지 않은 것은 의도였다(#181) — null 은 "아무나"가 아니라
    // "아직 아무도"다. null 을 "일치"로 읽으면 소유자 미지정 에이전트가 전원에게 열린다.
    useAppStore.getState().set({ me: acc('u1', 'owner') });
    const { container } = render(<TerminalChip account={agent('a2', 'orphan', null)} />);
    expect(container.innerHTML).toBe('');

    cleanup();
    useAppStore.getState().set({ me: acc('u9', 'admin', 'human', true) });
    render(<TerminalChip account={agent('a2', 'orphan', null)} />);
    expect(screen.getByText('터미널 보기')).toBeTruthy();
  });

  it('사람 계정에는 칩을 만들지 않는다', () => {
    useAppStore.getState().set({ me: acc('u9', 'admin', 'human', true) });
    const { container } = render(<TerminalChip account={acc('u3', 'alice')} />);
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
      // 이 describe 의 주인공은 소유자다 — #315 이후로는 그 사실을 명시해야 패널이
      // 입력을 연다(안 적으면 읽기 전용으로 떠서 무엇을 검증하는지 흐려진다).
      attachAgentSession: vi.fn(async () => ({ ticket: 'murt_x', session: sessions[0]!, canInput: true })),
    };
    setController({ api } as unknown as Controller);
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { a1: agent('a1', 'forge', 'u1') },
      terminalAgentId: 'a1',
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
    // 패널 자체도 사라진다(스토어의 terminalAgentId 가 null 이 된다).
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
 * #315 — 사람이 이 패널에 타이핑한다. 두 가지를 가른다:
 *   1(클라이언트 절반). 소유자가 친 것이 attach 소켓으로 나간다.
 *   5. admin 에게는 **입력 자체가 열리지 않고**, 왜인지가 화면에 있다.
 *
 * sink 팩토리가 받은 옵션을 붙잡는다 — 여기가 "입력이 열렸는가"의 실제 경계다.
 * 화면에 문구만 확인하면, 문구는 맞는데 xterm 은 입력을 받는 상태로도 초록이 된다.
 */
describe('#315 소유자는 치고 admin 은 못 친다', () => {
  const mountPanel = async (canInput: boolean) => {
    let opts: { onInput?: (data: string) => void } | undefined;
    setTerminalSinkFactory((_el, o) => {
      opts = o;
      return { write: () => { /* 이 describe 는 출력이 아니라 입력을 본다 */ }, dispose: () => {} };
    });
    const api = {
      baseUrl: 'http://localhost:8080',
      agentSessions: vi.fn(async () => [session()]),
      attachAgentSession: vi.fn(async () => ({ ticket: 'murt_x', session: session(), canInput })),
    };
    setController({ api } as unknown as Controller);
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { a1: agent('a1', 'forge', 'u1') },
      terminalAgentId: 'a1',
    });
    render(<TerminalPanel />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return { sinkOpts: () => opts };
  };

  it('소유자가 친 것이 attach 소켓에 input 프레임으로 나간다', async () => {
    const { sinkOpts } = await mountPanel(true);
    // 입력이 열려 있다 — 열려 있지 않으면 아래 호출 자체가 불가능하다.
    expect(sinkOpts()?.onInput).toBeTypeOf('function');

    // xterm 이 키를 넘기는 것을 흉내낸다. 제어 시퀀스를 섞는다 — 글자만 보내면
    // 인코딩이 깨져도 통과한다.
    await act(async () => { sinkOpts()!.onInput!('\x1b[Ayes\r'); });

    expect(FakeSocket.last!.sent).toHaveLength(1);
    const frame = JSON.parse(FakeSocket.last!.sent[0]!) as { type: string; data: string };
    expect(frame.type).toBe('input');
    expect(Buffer.from(frame.data, 'base64').toString('utf8')).toBe('\x1b[Ayes\r');
  });

  it('admin 에게는 입력이 열리지 않고 왜인지가 화면에 있다', async () => {
    const { sinkOpts } = await mountPanel(false);

    // **입력창이 없다.** sink 에 onInput 이 안 가면 terminalSink 가 xterm 의 stdin 자체를
    // 끈다 — 여기가 "눌러도 아무 일이 없는 입력창"을 막는 자리다.
    expect(sinkOpts()?.onInput).toBeUndefined();
    // 그리고 이유가 보인다. 비활성만 하고 이유를 안 적으면 사람은 고장으로 읽는다.
    expect(screen.getByText(/읽기 전용/)).toBeTruthy();
    expect(screen.getByText(/소유자/)).toBeTruthy();
    // 소켓으로도 아무것도 나가지 않았다 — 화면 문구만 보면 못 잡는 절반이다.
    expect(FakeSocket.last!.sent).toEqual([]);
  });
});

/**
 * #335 — 패널 크기가 PTY 크기가 된다. 화면 쪽 절반이다:
 *   1(클라이언트 절반). 소유자 패널의 크기가 attach 소켓으로 나간다.
 *   3. **admin 패널의 크기는 소유자에게 전파되지 않는다** — 화면이 그 길을 안 연다.
 *
 * 이것만으로 3 을 단언했다고 하면 안 된다(`#315` 에서 실측된 함정). admin 브라우저가
 * 소켓에 직접 프레임을 보내는 경로는 이 테스트가 못 지나고, 그 절반은 서버 쪽
 * `agentResize.test.ts` 의 `#335-2` 가 실제 소켓으로 잰다.
 */
describe('#335 소유자의 폭이 PTY 폭이 되고, admin 의 폭은 아무것도 안 바꾼다', () => {
  const mountPanel = async (canInput: boolean) => {
    let opts: TerminalSinkOptions | undefined;
    setTerminalSinkFactory((_el, o) => {
      opts = o;
      return { write: () => { /* 이 describe 는 출력이 아니라 크기를 본다 */ }, dispose: () => {} };
    });
    const api = {
      baseUrl: 'http://localhost:8080',
      agentSessions: vi.fn(async () => [session()]),
      attachAgentSession: vi.fn(async () => ({ ticket: 'murt_x', session: session(), canInput })),
    };
    setController({ api } as unknown as Controller);
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { a1: agent('a1', 'forge', 'u1') },
      terminalAgentId: 'a1',
    });
    render(<TerminalPanel />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return { sinkOpts: () => opts };
  };

  it('소유자 패널의 크기가 attach 소켓에 resize 프레임으로 나간다', async () => {
    const { sinkOpts } = await mountPanel(true);
    // 크기 보고가 열려 있다 — 열려 있지 않으면 아래 호출 자체가 불가능하다.
    expect(sinkOpts()?.onResize).toBeTypeOf('function');

    // 터미널이 컨테이너에 맞춘 결과를 알려 오는 것을 흉내낸다.
    await act(async () => { sinkOpts()!.onResize!(100, 30); });

    expect(FakeSocket.last!.sent).toHaveLength(1);
    const frame = JSON.parse(FakeSocket.last!.sent[0]!) as { type: string; cols: number; rows: number };
    expect(frame).toEqual({ type: 'resize', cols: 100, rows: 30 });
  });

  it('admin 패널은 크기를 아예 보고하지 않는다 — 소유자의 화면이 안 좁아진다', async () => {
    const { sinkOpts } = await mountPanel(false);

    // **크기 보고의 길이 없다.** sink 에 onResize 가 안 가면 그 터미널은 자기 폭을
    // 어디에도 말하지 않는다 — 읽기 전용은 아무것도 바꾸지 않는다(운영자 결정 A).
    expect(sinkOpts()?.onResize).toBeUndefined();
    // 소켓으로도 아무것도 나가지 않았다.
    expect(FakeSocket.last!.sent).toEqual([]);
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
