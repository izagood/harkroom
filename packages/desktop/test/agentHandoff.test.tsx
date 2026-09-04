// #384 — 관찰 전용 화면의 [이어받기]. 데스크탑 쪽 회귀선.
//
// **이 파일의 첫 테스트가 이 작업의 정직성 전부다**: 진행 중인 멘션 턴을 멈추지 않고
// 기다리기로 했으므로(운영자 결정 A), 누른 뒤 실측 26초쯤은 화면이 그대로다 — 그 침묵을
// 메우는 한 줄이 없으면 "눌렀는데 아무 일이 없다"가 되고, 그것이 이 저장소가 오늘 반복해서
// 고친 결함이다(#368 러너 사유, #369 attach 입력, #381 work.link).
//
// 진짜 `TerminalPanel` 을 띄우고 진짜 `connectAgentAttach` 로 프레임을 흘린다 — 가짜는
// xterm sink 와 소켓뿐이다. 화면 판정을 흉내낸 테스트는 그 판정을 지워도 초록이다(실측).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { AgentSessionView, WriterDeniedReason } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { TerminalPanel } from '../src/components/TerminalPanel';
import { setTerminalSinkFactory } from '../src/lib/terminalSink';
import { acc } from './helpers/fakeApi';

const agent = (id: string, handle: string, ownerAccountId: string | null) =>
  ({ ...acc(id, handle, 'agent'), ownerAccountId });

const session = (overrides: Partial<AgentSessionView> = {}): AgentSessionView => ({
  sessionId: 'sess-mention',
  // 진행 중인 멘션 턴 — 프롬프트를 파일로 받아 PTY 입력이 자식에게 닿지 않는다(#369).
  acceptsInput: false,
  mode: 'mention',
  agentAccountId: 'a1',
  channelId: 'c1',
  threadRootId: 'm1',
  harness: 'claude-code',
  startedAt: '2026-09-04T00:00:00.000Z',
  ...overrides,
});

class FakeSocket {
  static last: FakeSocket | null = null;
  static opened: FakeSocket[] = [];
  static readonly OPEN = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  readyState = 1;
  sent: string[] = [];
  constructor(public url: string) { FakeSocket.last = this; FakeSocket.opened.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  deliver(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

beforeEach(() => {
  useAppStore.getState().reset();
  FakeSocket.last = null;
  FakeSocket.opened = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setController(null as unknown as Controller);
});

const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
};

interface MountOpts {
  /** 이어받기 요청의 답. 기본은 예약(기다린다). */
  handoffAnswer?: () => Promise<{ ticket: string; session: AgentSessionView; waiting: boolean }>;
}

/** 진행 중인 멘션 턴에 붙은 패널을 띄운다 — #369 가 관찰 전용이라고 적어 준 그 화면이다. */
async function mountAttached(opts: MountOpts = {}) {
  let sinkOpts: { onInput?: (data: string) => void; onResize?: (c: number, r: number) => void } | undefined;
  const readOnly: boolean[] = [];
  setTerminalSinkFactory((_el, o) => {
    sinkOpts = o;
    return {
      write: () => { /* 이 파일은 출력이 아니라 개입 가능 여부를 본다 */ },
      setReadOnly: (v: boolean) => { readOnly.push(v); },
      dispose: () => {},
    };
  });
  const openInteractiveSession = vi.fn(opts.handoffAnswer ?? (async () => ({
    // 예약됐다 — 세션·티켓은 **지금 도는 멘션 턴**의 것이다(기다리는 동안 볼 화면).
    ticket: 'murt_mention', session: session(), waiting: true,
  })));
  const api = {
    baseUrl: 'http://localhost:8080',
    agentSessions: vi.fn(async () => [session()]),
    attachAgentSession: vi.fn(async () => ({ ticket: 'murt_mention', session: session() })),
    openInteractiveSession,
  };
  setController({ api } as unknown as Controller);
  useAppStore.getState().set({
    me: acc('u1', 'owner'),
    accounts: { a1: agent('a1', 'forge', 'u1') },
    terminalTarget: { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1' },
  });
  render(<TerminalPanel />);
  await flush();
  return { api, openInteractiveSession, readOnly, sinkOpts: () => sinkOpts };
}

/** 서버가 writer 차례를 알린다. 관찰 전용 세션의 답이 이것이다(#369). */
const denyWriter = async (reason: WriterDeniedReason): Promise<void> => {
  await act(async () => {
    FakeSocket.last!.deliver({ type: 'writer', writer: false, resize: true, reason });
  });
};

describe('#384-1 [이어받기] 를 누르면 기다린다는 것이 화면에 보인다', () => {
  it('예약 응답(waiting)이 오면 "턴이 끝나면 엽니다"가 화면에 있다', async () => {
    const { openInteractiveSession } = await mountAttached();
    await denyWriter('observe-only');

    // 관찰 전용 자리에 버튼이 있다 — #369 가 이유를 적어 준 그 자리다.
    await act(async () => { screen.getByTestId('handoff-button').click(); });
    await flush();

    // 이어받기라는 사실이 요청에 실린다 — [터미널 열기](handoff:false)와 다른 부탁이다.
    expect(openInteractiveSession).toHaveBeenCalledWith('a1', 'c1', 'm1', true);

    // **기다린다는 사실이 화면에 있다.** 이 단언이 이 파일의 이유 전부다: 버튼이 눌린다는
    // 것만 재면, 아무 표시가 없어도(사람에게는 아무 일도 안 일어난 화면) 초록이 된다.
    const note = screen.getByTestId('handoff-note');
    expect(note.textContent).toContain('끝나면 엽니다');
    expect(note.textContent).toContain('예약');
    // 기다리는 중에는 버튼이 사라진다 — 두 번 눌러도 예약은 하나이고, 남아 있으면 사람은
    // 눌린 것인지 아닌지 화면에서 알 수 없다.
    expect(screen.queryByTestId('handoff-button')).toBeNull();
    // 화면을 잃지 않는다 — 기다리는 동안 그 멘션 턴을 계속 본다(소켓이 살아 있다).
    expect(FakeSocket.last!.closed).toBe(false);
  });

  it('기다리는 동안에도 여전히 관찰 전용이다 — 이어받기가 #369 의 판정을 앞지르지 않는다', async () => {
    const { readOnly, sinkOpts } = await mountAttached();
    await denyWriter('observe-only');

    await act(async () => { screen.getByTestId('handoff-button').click(); });
    await flush();

    // 이유는 그대로 적혀 있고, 입력은 그대로 닫혀 있다.
    expect(screen.getByTestId('writer-note').textContent).toContain('관찰 전용');
    expect(readOnly.at(-1)).toBe(true);
    await act(async () => { sinkOpts()!.onInput!('yes\r'); });
    expect(FakeSocket.last!.sent).toEqual([]);
  });

  it('이어받을 턴이 없는 이유(다른 창·구 러너)에는 버튼이 없다 — 눌러도 아무 일이 없는 버튼을 만들지 않는다', async () => {
    await mountAttached();
    await denyWriter('other-writer');
    expect(screen.queryByTestId('handoff-button')).toBeNull();

    await denyWriter('runner-outdated');
    expect(screen.queryByTestId('handoff-button')).toBeNull();

    // 관찰 전용일 때만 있다 — 이어받을 턴이 실제로 도는 경우가 그것뿐이다.
    await denyWriter('observe-only');
    expect(screen.getByTestId('handoff-button')).toBeTruthy();
  });
});

describe('#384-2 멘션 턴이 끝나면 그 자리에서 인터랙티브 세션으로 갈아탄다', () => {
  it('status:ended 가 오면 같은 요청을 한 번 더 보내 새 티켓으로 붙고, writer 가 열린다', async () => {
    let call = 0;
    const { openInteractiveSession } = await mountAttached({
      handoffAnswer: async () => {
        call += 1;
        // 첫 요청은 예약(멘션 턴이 돌고 있다), 두 번째는 러너가 띄운 인터랙티브 세션이다.
        return call === 1
          ? { ticket: 'murt_mention', session: session(), waiting: true }
          : {
            ticket: 'murt_handoff',
            session: session({ sessionId: 'sess-handoff', mode: 'interactive', acceptsInput: true }),
            waiting: false,
          };
      },
    });
    await denyWriter('observe-only');
    await act(async () => { screen.getByTestId('handoff-button').click(); });
    await flush();
    expect(screen.getByTestId('handoff-note').textContent).toContain('끝나면 엽니다');

    // 기다린 턴이 끝났다 — **이미 오는 프레임**이 그것을 알려 준다(폴링을 만들지 않았다).
    await act(async () => { FakeSocket.last!.deliver({ type: 'status', state: 'ended' }); });
    await flush();

    expect(openInteractiveSession).toHaveBeenCalledTimes(2);
    expect(openInteractiveSession).toHaveBeenLastCalledWith('a1', 'c1', 'm1', true);
    // 새 세션의 티켓으로 새 소켓이 열렸다 — 같은 화면 자리에서 갈아탔다.
    expect(FakeSocket.last!.url).toContain('murt_handoff');
    // 앞 소켓은 놓았다: 끝난 멘션 세션의 바이트가 계속 흘러들면 안 된다.
    expect(FakeSocket.opened[0]!.closed).toBe(true);

    // 그 세션은 stdinFile 이 없어 서버가 writer 를 준다(#369 의 판정 그대로) — 화면은
    // 그 통지를 받아 "입력 가능"으로 바뀌고, 대기 문구는 사라진다.
    await act(async () => {
      FakeSocket.last!.deliver({ type: 'writer', writer: true, resize: true, reason: null });
    });
    expect(screen.getByTestId('writer-note').textContent).toContain('입력 가능');
    expect(screen.queryByTestId('handoff-note')).toBeNull();
  });

  it('누르는 사이에 턴이 끝났으면(waiting:false) 곧장 갈아탄다 — 기다림 표시를 남기지 않는다', async () => {
    await mountAttached({
      handoffAnswer: async () => ({
        ticket: 'murt_handoff',
        session: session({ sessionId: 'sess-handoff', mode: 'interactive', acceptsInput: true }),
        waiting: false,
      }),
    });
    await denyWriter('observe-only');

    await act(async () => { screen.getByTestId('handoff-button').click(); });
    await flush();

    expect(FakeSocket.last!.url).toContain('murt_handoff');
    expect(screen.queryByTestId('handoff-note')).toBeNull();
  });
});

describe('#384-3 거절은 이유가 보인다 — 보고 있던 화면을 잃지 않는다', () => {
  it('codex 거절 문구가 그대로 화면에 뜨고, 그 멘션 턴 화면은 그대로 남는다', async () => {
    // 러너가 던진 문구가 서버를 지나 그대로 온다 — 화면이 원인을 지어내지 않는다(#369 규칙).
    const REASON = 'codex 에이전트는 이어받기가 열려 있지 않다 — 멘션 턴(codex exec)이 만든 세션을 대화형 codex resume 이 이어받는지가 실측되지 않았다';
    await mountAttached({ handoffAnswer: async () => { throw new Error(REASON); } });
    await denyWriter('observe-only');

    await act(async () => { screen.getByTestId('handoff-button').click(); });
    await flush();

    expect(screen.getByTestId('handoff-error').textContent).toContain('codex');
    expect(screen.getByTestId('handoff-error').textContent).toContain('실측되지 않았다');
    // 관찰은 계속된다 — 거절은 이 스레드를 못 보게 된 사건이 아니다.
    expect(screen.getByTestId('writer-note').textContent).toContain('관찰 전용');
    expect(FakeSocket.last!.closed).toBe(false);
    expect(screen.getByTestId('terminal-host')).toBeTruthy();
  });
});
