import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ChannelAutoMentionRow } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, Controller } from '../src/state/controller';
import { Composer } from '../src/components/Composer';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

/**
 * 채널이 특정 에이전트를 자동으로 멘션한다(#173) — 작성창 쪽 회귀선.
 *
 * 3. 작성창이 전송 직전 본문에 `@handle ` 을 붙인다 — onSend 로 나가는 본문(서버에 도착하는
 *    본문 그 자체)으로 확인한다.
 * 4. 본문에 이미 그 handle 이 있으면 두 번 붙이지 않는다.
 * 5. 칩 × 를 누르면 **그 메시지에는** 접두가 없고, 다음 메시지에는 다시 붙는다.
 * 그리고 칩이 고정 멘션과 구분돼 보인다('자동' 배지·title), 채널이 여럿을 부르면 전부 붙는다,
 * 비활성화된 에이전트는 붙이지 않는다.
 *
 * 서버 쪽(라우트·MCP 본문 무변경·inbox·감사)은 `packages/server/test/channelAutoMention.test.ts`.
 */
const row = (agentAccountId: string, handle: string): ChannelAutoMentionRow =>
  ({ channelId: 'c1', agentAccountId, handle, createdBy: 'ad', createdAt: new Date().toISOString() });

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};
const sendText = (value: string) => {
  const box = typeInto(value);
  fireEvent.keyDown(box, { key: 'Escape' });
  fireEvent.keyDown(box, { key: 'Enter' });
};
const autoChips = () =>
  screen.queryAllByTestId('auto-mention').map((el) => el.getAttribute('data-handle'));
const stickyChips = () =>
  screen.queryAllByTestId('sticky-mention').map((el) => el.getAttribute('data-handle'));

beforeEach(() => {
  // 보냄 취소 창은 이 파일의 관심사가 아니다(#223) — 끄고 즉시 전송 경로를 본다.
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      a1: acc('a1', 'fizz', 'agent'),
      a2: acc('a2', 'honey', 'agent'),
      u2: acc('u2', 'rusalka'),
    },
    channelAutoMentions: { c1: [row('a1', 'fizz')] },
  });
});
afterEach(() => cleanup());

describe('자동 멘션 작성창 (#173)', () => {
  // 회귀 3
  it('전송 직전 본문 앞에 @handle 을 붙인다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" autoMentionChannelId="c1" />);

    sendText('이거 확인해 줘');

    expect(onSend).toHaveBeenCalledWith('@fizz 이거 확인해 줘', []);
  });

  it('채널이 부르지 않으면(설정 없음) 아무것도 붙이지 않는다', () => {
    useAppStore.getState().set({ channelAutoMentions: {} });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" autoMentionChannelId="c1" />);

    sendText('그냥 글');

    expect(onSend).toHaveBeenCalledWith('그냥 글', []);
    expect(autoChips()).toEqual([]);
  });

  // 회귀 4
  it('본문이 이미 그 handle 을 부르면 두 번 붙이지 않는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" autoMentionChannelId="c1" />);

    sendText('@fizz 직접 불렀다');

    expect(onSend).toHaveBeenCalledWith('@fizz 직접 불렀다', []);
    // 직접 부른 것이 고정 칩으로 또 서지 않는다 — 자동 칩이 그 자리다.
    expect(stickyChips()).toEqual([]);
    expect(autoChips()).toEqual(['fizz']);
  });

  // 회귀 5
  it('칩 × 는 그 메시지에서만 뺀다 — 다음 메시지에는 다시 붙는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" autoMentionChannelId="c1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip @fizz this time' }));
    expect(autoChips()).toEqual([]);
    sendText('이 줄은 에이전트 없이');
    expect(onSend).toHaveBeenLastCalledWith('이 줄은 에이전트 없이', []);

    // 설정은 그대로다 — 칩이 돌아오고 다음 줄에 다시 붙는다.
    expect(autoChips()).toEqual(['fizz']);
    sendText('다음 줄');
    expect(onSend).toHaveBeenLastCalledWith('@fizz 다음 줄', []);
  });

  it('칩은 고정 멘션과 구분된다 — 자동 배지와 title', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" autoMentionChannelId="c1" />);

    const chip = screen.getByTestId('auto-mention');
    expect(chip.getAttribute('title')).toBe('이 채널이 자동으로 멘션한다');
    expect(chip.textContent).toContain('자동');
    expect(chip.textContent).toContain('@fizz');
    // 고정 칩이 아니다 — 고정 칩의 × 는 설정을 바꾸는 뜻으로 읽힌다.
    expect(stickyChips()).toEqual([]);
  });

  it('채널이 여럿을 부르면 전부 붙고, 고정 멘션은 그 뒤에 온다', () => {
    useAppStore.getState().set({ channelAutoMentions: { c1: [row('a1', 'fizz'), row('a2', 'honey')] } });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" autoMentionChannelId="c1" />);

    sendText('@rusalka 같이 보자');
    sendText('다음');

    expect(stickyChips()).toEqual(['rusalka']);
    expect(onSend).toHaveBeenLastCalledWith('@fizz @honey @rusalka 다음', []);
  });

  it('설정된 뒤 비활성화된 에이전트는 붙이지 않는다', () => {
    useAppStore.getState().set({
      accounts: { ...useAppStore.getState().accounts, a1: acc('a1', 'fizz', 'agent', false, { disabled: true }) },
    });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" autoMentionChannelId="c1" />);

    sendText('깨어나지 못하는 상대');

    expect(autoChips()).toEqual([]);
    expect(onSend).toHaveBeenCalledWith('깨어나지 못하는 상대', []);
  });
});

/**
 * 배선을 **`Workspace` 를 통째로 띄워** 확인한다(#173).
 *
 * 위의 단위 테스트는 `Composer` 에 `autoMentionChannelId` 를 손으로 넘긴다 — 그 prop 을
 * `ChannelPane`·`ThreadPanel` 이 넘기지 않으면 앱에서는 칩도 접두도 없는데 위 7건은 전부
 * 초록이다. #279 가 정확히 그 틈에서 죽은 버튼을 통과시켰다(`mentionClick.test.tsx` 의
 * 같은 이름 절이 그 사고를 적는다). 그래서 실제 화면에서 칩과 접두를 본다.
 */
describe('자동 멘션 배선 — Workspace 를 통째로 (#173)', () => {
  const mount = (extra: Record<string, unknown> = {}) => {
    const send = vi.fn();
    const reply = vi.fn();
    setController({
      api: fakeApi(),
      openChannel: vi.fn().mockResolvedValue(undefined),
      openThread: vi.fn(), closeThread: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
      notifyTyping: vi.fn(), refreshAccounts: vi.fn().mockResolvedValue(undefined),
      send, reply, loadOlder: vi.fn(),
      goBack: vi.fn().mockResolvedValue(false),
      goForward: vi.fn().mockResolvedValue(false),
    } as unknown as Controller);
    useAppStore.getState().set({
      channels: [chan('c1', 'general')],
      connected: true,
      activeChannelId: 'c1',
      messages: { c1: [msg('m1', 'c1', 1, '첫 줄', 'u1')] },
      ...extra,
    });
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
    return { send, reply };
  };

  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { setController(null as unknown as Controller); });

  it('채널 작성창에 칩이 서고 보낸 본문에 접두가 붙는다', async () => {
    const { send } = mount();

    await waitFor(() => expect(screen.getByTestId('auto-mention')).toBeTruthy());
    const box = screen.getByPlaceholderText('Message #general') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '이거 확인해 줘', selectionStart: 7 } });
    fireEvent.keyDown(box, { key: 'Escape' });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(send).toHaveBeenCalledWith('@fizz 이거 확인해 줘', [], 'c1');
  });

  it('스레드 답장에도 칩이 서고 접두가 붙는다 — 다만 예약 버튼은 없다', async () => {
    const { reply } = mount({ threadRootId: 'm1' });

    // 스레드 패널의 작성창이다 — 채널 작성창의 칩과 구분해 그 안에서 찾는다.
    const box = await screen.findByPlaceholderText('Reply…') as HTMLTextAreaElement;
    const panel = box.closest('section')!;
    await waitFor(() => expect(panel.querySelector('[data-testid="auto-mention"]')).toBeTruthy());
    /**
     * 예약 표면(#222)은 스레드에 없어야 한다. `POST /channels/:id/scheduled` 는 스레드
     * 뿌리를 실어 보내지 않으므로, 여기서 예약하면 답글이 **채널 본문으로** 나가 스레드가
     * 조용히 사라진다. 자동 멘션 때문에 채널을 알려 준다고 이 버튼이 되살아나면 안 된다.
     */
    expect(panel.querySelector('button[aria-label="나중에 보내기"]')).toBeNull();

    fireEvent.change(box, { target: { value: '답글', selectionStart: 2 } });
    fireEvent.keyDown(box, { key: 'Escape' });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(reply).toHaveBeenCalledWith('@fizz 답글', [], 'c1', 'm1', false);
  });
});

/**
 * 컨트롤러 쪽 회귀선(#173). 위의 화면 테스트는 **가짜 컨트롤러**를 쓴다 — 그 가짜가
 * 스스로 스토어를 갱신하므로, 실제 `Controller` 가 서버를 다시 읽지 않아도(또는 채널을 열 때
 * 목록을 아예 받지 않아도) 전부 초록이다. 여기서 진짜 `Controller` 로 그 세 가지를 못박는다.
 */
describe('자동 멘션 컨트롤러 (#173)', () => {
  beforeEach(() => { useAppStore.getState().reset(); });

  const row2 = (agentAccountId: string, handle: string): ChannelAutoMentionRow =>
    ({ channelId: 'c1', agentAccountId, handle, createdBy: 'ad', createdAt: new Date().toISOString() });

  it('채널을 열면 자동 멘션 목록을 받아 스토어에 넣는다', async () => {
    const api = fakeApi({ channelAutoMentions: vi.fn(async () => [row2('a1', 'fizz')]) });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    await c.openChannel('c1');

    // 크리티컬 패스 밖(`swallow`)이라 다음 틱에 들어온다.
    await waitFor(() =>
      expect(useAppStore.getState().channelAutoMentions.c1?.map((r) => r.handle)).toEqual(['fizz']));
  });

  it('목록 조회가 실패해도 채널은 열린다 — 그리고 빈 배열로 삼키지 않는다', async () => {
    const api = fakeApi({
      channelAutoMentions: vi.fn(async () => { throw new Error('boom'); }),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    await c.openChannel('c1');

    expect(useAppStore.getState().activeChannelId).toBe('c1');
    // 빈 배열이 들어가면 "아무도 안 부른다" 는 거짓 사실이 되고 작성창은 칩을 안 그린다.
    expect(useAppStore.getState().channelAutoMentions.c1).toBeUndefined();
  });

  it('걸고 푼 뒤 목록을 서버에서 다시 읽는다 — 로컬 델타로 때우지 않는다', async () => {
    const rows: ChannelAutoMentionRow[] = [];
    const api = fakeApi({
      channelAutoMentions: vi.fn(async () => [...rows]),
      setChannelAutoMention: vi.fn(async (channelId: string, agentAccountId: string) => {
        const r = row2(agentAccountId, 'fizz');
        rows.push(r);
        return r;
      }),
      unsetChannelAutoMention: vi.fn(async (_channelId: string, agentAccountId: string) => {
        rows.splice(0, rows.length, ...rows.filter((r) => r.agentAccountId !== agentAccountId));
      }),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    await c.setChannelAutoMention('c1', 'a1');
    expect(useAppStore.getState().channelAutoMentions.c1?.map((r) => r.handle)).toEqual(['fizz']);

    await c.unsetChannelAutoMention('c1', 'a1');
    expect(useAppStore.getState().channelAutoMentions.c1).toEqual([]);
  });
});
