import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AskMeta, InboxEntry, InboxThreadState, MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { Inbox } from '../src/components/Inbox';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan, msg } from './helpers/fakeApi';

/**
 * 이 파일은 인박스 **보드의 내용**(카드 · 열 · 그 자리 처리)을 잰다. 어느 카드가 어느 열인지의
 * 판정 자체는 `inboxBoard.test.ts` 가, 껍데기(모달이 아니라 자리)는 `inboxPane.test.tsx` 가 잰다.
 */
const ME = 'u1';
const BOT = 'u2';

const entry = (id: number, extra: Partial<InboxEntry> = {}): InboxEntry => ({
  id, messageId: `m${id}`, reason: 'mention', readAt: null, channelId: 'c1', authorId: BOT,
  body: `말 ${id}`, meta: {}, createdAt: new Date().toISOString(), threadRootId: null, ...extra,
});
const head = (id: string, extra: Partial<MessageRow> = {}): MessageRow => msg(id, 'c1', 1, `머리 ${id}`, ME, {
  replyCount: 1, openAskHumanCount: 0, openAskAccountIds: [], openAskLinks: [], unresolvedFailureCount: 0,
  failureCount: 0, lastKind: 'user', lastAuthorId: ME, ...extra,
});
const askMeta = (to: AskMeta['ask']['to'], prompt?: string) => ({
  kind: 'ask',
  ask: { prompt, options: [{ id: 'a', label: '이대로' }, { id: 'b', label: '다시' }], to },
} as unknown as Record<string, unknown>);

const fakeController = (load: () => Promise<{ entries: InboxEntry[]; threads: MessageRow[] | null; threadStates?: InboxThreadState[] }>) => {
  const c = {
    api: {
      inboxBoard: vi.fn(async () => ({ threadStates: [], ...(await load()) })),
      setInboxThreadState: vi.fn(async () => ({ state: null })),
    },
    openMessage: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    // 보드는 컨트롤러를 지나 조회한다(`loadInboxBoard`) — 목은 api 로 그대로 흘린다.
    loadInboxBoard: vi.fn(() => c.api.inboxBoard()),
    inboxBoardSnapshot: vi.fn(() => null),
    openChannel: vi.fn(async () => undefined),
    answerAsk: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

// 한국어로 고정한다 — 두 언어로 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => {
  localStorage.clear();
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc(ME, 'me'),
    accounts: { [ME]: acc(ME, 'me'), [BOT]: acc(BOT, 'forge', 'agent') },
    channels: [chan('c1', 'general'), chan('c2', 'random')],
  });
});

afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  vi.restoreAllMocks();
});

const open = (onClose = vi.fn()) => render(<Inbox open onClose={onClose} />);
const col = (name: string) => screen.getByTestId(`inbox-col-${name}`);

describe('Inbox 상태 보드 (C안)', () => {
  it('같은 일에서 온 다섯 줄이 카드 한 장으로 선다', async () => {
    fakeController(async () => ({
      entries: [1, 2, 3, 4, 5].map((i) => entry(i, { threadRootId: 'r1', reason: 'thread_reply' })),
      threads: [head('r1', { openAskAccountIds: [ME] })],
    }));
    open();
    const card = await screen.findByTestId('inbox-card-r1');
    expect(screen.getAllByTestId(/^inbox-card-r\d$/)).toHaveLength(1);
    expect(card.textContent).toContain('+4개 더');
    expect(within(col('mine')).getByTestId('inbox-card-r1')).toBeTruthy();
  });

  it('내 차례 띠가 맨 위에, 그 아래 세 열이 진행 → 기다림 → 끝 순서로 서고, 수는 내 차례만 센다', async () => {
    fakeController(async () => ({
      entries: ['r1', 'r2', 'r3', 'r4'].map((r, i) => entry(i + 1, { threadRootId: r })),
      threads: [
        head('r1', { openAskAccountIds: [ME] }),
        head('r2', { openAskAccountIds: [BOT] }),
        head('r3', { lastKind: 'progress', lastAuthorId: BOT }),
        head('r4', { lastAuthorId: BOT }),
      ],
    }));
    open();
    await screen.findByTestId('inbox-card-r1');
    const order = screen.getAllByTestId(/^inbox-col-/).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['inbox-col-mine', 'inbox-col-active', 'inbox-col-blocked', 'inbox-col-done']);
    expect(within(col('blocked')).getByTestId('inbox-card-r2')).toBeTruthy();
    expect(within(col('active')).getByTestId('inbox-card-r3')).toBeTruthy();
    expect(within(col('done')).getByTestId('inbox-card-r4')).toBeTruthy();
    expect(screen.getByTestId('inbox-mine-count').textContent).toBe('나를 기다리는 일 1');
    // 옛 칩은 없다.
    expect(screen.queryByTestId('inbox-filter-blocking')).toBeNull();
  });

  it('내 차례 띠는 오래 기다린 것부터 다섯 장을 펼치고 나머지는 "+N개 더" 로 접는다', async () => {
    const roots = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    fakeController(async () => ({
      // 번호가 클수록 오래된 말이다 — 띠는 r7 부터 선다.
      entries: roots.map((r, i) => entry(i + 1, { threadRootId: r, createdAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString() })),
      threads: roots.map((r) => head(r, { openAskAccountIds: [ME] })),
    }));
    open();
    await screen.findByTestId('inbox-card-r7');
    const band = col('mine');
    const more = within(band).getByTestId('inbox-band-more');
    const open5 = within(band).getAllByTestId(/^inbox-card-r\d$/).filter((el) => !more.contains(el)).map((el) => el.getAttribute('data-testid'));
    expect(open5).toEqual(['inbox-card-r7', 'inbox-card-r6', 'inbox-card-r5', 'inbox-card-r4', 'inbox-card-r3']);
    expect(more.textContent).toContain('+2개 더');
    expect(screen.getByTestId('inbox-mine-count').textContent).toBe('나를 기다리는 일 7');
  });

  it('내 차례가 없으면 띠는 한 줄로 줄어든다', async () => {
    fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1' })],
      threads: [head('r1', { lastKind: 'progress', lastAuthorId: BOT })],
    }));
    open();
    await screen.findByTestId('inbox-card-r1');
    expect(within(col('mine')).getByTestId('inbox-band-empty').textContent).toBe('나를 기다리는 일이 없다');
    expect(screen.queryByTestId('inbox-band-more')).toBeNull();
  });

  it('카드 문장은 본문 앞 두 줄이 아니라 물음 문장이고, <@id> 는 handle 로 보인다', async () => {
    const BOB = '2c8c1910-da9c-47bc-a483-ce41a1217d85';
    useAppStore.getState().set({ accounts: { [ME]: acc(ME, 'me'), [BOT]: acc(BOT, 'forge', 'agent'), [BOB]: acc(BOB, 'bob') } });
    // 채널 바로 밑의 말이라 머리가 곧 그 말이다 — 서버도 같은 본문을 싣는다.
    const body = `경과\n| a | b |\n|---|---|\n이건 <@${BOB}> 에게 넘겨도 될까?`;
    fakeController(async () => ({
      entries: [entry(1, { body })],
      threads: [head('m1', { replyCount: 0, body })],
    }));
    open();
    const summary = await screen.findByTestId('inbox-card-summary-m1');
    expect(summary.textContent).toBe('이건 @bob 에게 넘겨도 될까?');
  });

  it('나에게 온 물음은 카드에서 바로 고르고, 스레드는 열리지 않는다', async () => {
    const c = fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', meta: askMeta({ kind: 'account', accountId: ME }, '어느 쪽?') })],
      threads: [head('r1', { openAskAccountIds: [ME] })],
    }));
    open();
    fireEvent.click(await screen.findByTestId('inbox-card-answer-r1-a'));
    await waitFor(() => expect(c.answerAsk).toHaveBeenCalledWith('m1', 'a', 'c1'));
    expect(c.openThread).not.toHaveBeenCalled();
    // 내 차례에는 완료가 없다(눌러도 그 자리에 남는다) — 나중에는 있다(수에서 뺄 수 있게).
    expect(screen.queryByTestId('inbox-card-done-r1')).toBeNull();
    expect(screen.getByTestId('inbox-card-later-r1')).toBeTruthy();
  });

  it('남에게 간 물음은 카드에 선택지가 없다', async () => {
    fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', meta: askMeta({ kind: 'account', accountId: BOT }) })],
      threads: [head('r1', { openAskAccountIds: [BOT] })],
    }));
    open();
    await screen.findByTestId('inbox-card-r1');
    expect(screen.queryByTestId('inbox-card-answer-r1-a')).toBeNull();
  });

  it('완료는 서버의 내 상태를 정하고, 치운 카드는 끝남 맨 아래 접힘에서 되돌린다', async () => {
    let states: InboxThreadState[] = [];
    const c = fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', createdAt: new Date(Date.now() - 3_600_000).toISOString() })],
      threads: [head('r1', { lastAuthorId: BOT })],
      threadStates: states,
    }));
    open();
    fireEvent.click(await screen.findByTestId('inbox-card-done-r1'));
    await waitFor(() => expect(c.api.setInboxThreadState).toHaveBeenCalledWith('r1', { state: 'done' }));
    // 리액션은 건드리지 않는다 — 남에게 보이는 흔적이 남지 않는다.
    expect(c.toggleReaction).not.toHaveBeenCalled();
    states = [{ rootId: 'r1', state: 'done', until: null, updatedAt: new Date().toISOString() }];
    cleanup();
    open();
    const fold = await screen.findByTestId('inbox-fold-cleared');
    expect(fold.textContent).toContain('치운 것 1');
    fireEvent.click(within(fold).getByTestId('inbox-card-undo-r1'));
    await waitFor(() => expect(c.api.setInboxThreadState).toHaveBeenLastCalledWith('r1', { state: null }));
  });

  it('나중에는 내일 아침으로 미루고, 미룬 내 차례는 수에서 빠진다', async () => {
    let states: InboxThreadState[] = [];
    const c = fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', createdAt: new Date(Date.now() - 3_600_000).toISOString() })],
      threads: [head('r1', { openAskAccountIds: [ME] })],
      threadStates: states,
    }));
    open();
    expect((await screen.findByTestId('inbox-mine-count')).textContent).toBe('나를 기다리는 일 1');
    fireEvent.click(screen.getByTestId('inbox-card-later-r1'));
    await waitFor(() => expect(c.api.setInboxThreadState).toHaveBeenCalled());
    const [, body] = c.api.setInboxThreadState.mock.calls[0] as unknown as [string, { state: string; until: string }];
    expect(body.state).toBe('later');
    const until = new Date(body.until);
    expect(until.getHours()).toBe(9);
    expect(until.getTime()).toBeGreaterThan(Date.now());
    states = [{ rootId: 'r1', state: 'later', until: body.until, updatedAt: new Date().toISOString() }];
    cleanup();
    open();
    const fold = await screen.findByTestId('inbox-fold-later');
    expect(within(fold).getByTestId('inbox-card-r1')).toBeTruthy();
    // 언제 다시 서는지 말한다(designer) — 내일 아침 9시.
    expect(within(fold).getByTestId('inbox-card-later-until-r1').textContent).toMatch(/내일 \S+ ?9시에 다시/); // 오전/AM 표기는 ICU 데이터에 따라 갈린다
    expect(screen.getByTestId('inbox-mine-count').textContent).toBe('나를 기다리는 일 0');
  });

  it('스레드 카드를 누르면 그 스레드를 열고 보드는 남는다', async () => {
    const onClose = vi.fn();
    const c = fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', reason: 'thread_reply' })],
      threads: [head('r1')],
    }));
    open(onClose);
    fireEvent.click(await screen.findByTestId('inbox-card-r1'));
    expect(c.openThread).toHaveBeenCalledWith('r1', { channelId: 'c1' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('채널 바로 밑의 말 하나면 그 말로 가고 보드는 자리를 내준다', async () => {
    const onClose = vi.fn();
    const c = fakeController(async () => ({ entries: [entry(9)], threads: [head('m9', { replyCount: 0 })] }));
    open(onClose);
    fireEvent.click(await screen.findByTestId('inbox-card-m9'));
    expect(c.openMessage).toHaveBeenCalledWith('m9');
    expect(onClose).toHaveBeenCalled();
  });

  it('카드를 누르면 새 말 표시가 곧바로 걷힌다', async () => {
    fakeController(async () => ({ entries: [entry(1, { threadRootId: 'r1' })], threads: [head('r1')] }));
    open();
    const card = await screen.findByTestId('inbox-card-r1');
    expect(card.getAttribute('data-unread')).toBe('true');
    fireEvent.click(card);
    expect(screen.getByTestId('inbox-card-r1').getAttribute('data-unread')).toBe('false');
  });

  it('오래 기다린 카드는 "N일째" 를 말한다', async () => {
    fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', createdAt: new Date(Date.now() - 3 * 86_400_000 - 1000).toISOString() })],
      threads: [head('r1', { openAskAccountIds: [ME] })],
    }));
    open();
    expect((await screen.findByTestId('inbox-card-age-r1')).textContent).toContain('3일째');
  });

  it('조회 실패가 "없다" 가 아니라 오류로 보인다', async () => {
    fakeController(async () => { throw new Error('boom'); });
    open();
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
    expect(screen.queryByTestId('inbox-empty')).toBeNull();
  });

  it('부른 것이 없으면 "없다" 를 보여 준다', async () => {
    fakeController(async () => ({ entries: [], threads: [] }));
    open();
    expect((await screen.findByTestId('inbox-empty')).textContent).toBe('아직 올라온 일이 없다');
  });

  /**
   * 세 열은 **보드 자기 폭**으로 편다(designer #1219). 카드를 열면 옆에 스레드가 서서 보드가 좁아지는데,
   * 창 폭(`lg:`)으로 펴면 그때도 세 열을 고집해 한 열이 70px 남짓이 된다. jsdom 은 폭을 못 재므로 클래스로 잰다.
   */
  it('세 열은 창 폭이 아니라 보드 폭(@container)으로 펼친다', async () => {
    fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', reason: 'thread_reply' })],
      threads: [head('r1', { authorId: ME })],
    }));
    open();
    await screen.findByTestId('inbox-lanes');
    expect(screen.getByTestId('inbox-board').className.split(/\s+/)).toContain('@container');
    const lanes = screen.getByTestId('inbox-lanes').className;
    expect(lanes).toContain('@3xl:grid-cols-3');
    expect(lanes).not.toMatch(/(^|\s)lg:/);
  });

  it('옛 서버(머리 없음)에서도 보드가 선다', async () => {
    fakeController(async () => ({
      entries: [entry(1, { meta: askMeta({ kind: 'account', accountId: ME }) })],
      threads: null,
    }));
    open();
    await screen.findByTestId('inbox-card-m1');
    expect(within(col('mine')).getByTestId('inbox-card-m1')).toBeTruthy();
  });

  it('쓰다 만 초안은 보드 밖 한 줄이고, 누르면 그 자리로 간다', async () => {
    const onClose = vi.fn();
    useAppStore.getState().set({ drafts: { c2: '쓰다 만 말', c1: '   ' } });
    const c = fakeController(async () => ({ entries: [], threads: [] }));
    open(onClose);
    const line = await screen.findByTestId('inbox-drafts');
    expect(line.textContent).toBe('쓰다 만 초안 (1)');
    fireEvent.click(line);
    expect(c.openChannel).toHaveBeenCalledWith('c2');
    expect(onClose).toHaveBeenCalled();
  });

  // 아무도 열 수 없는 화면은 없는 화면과 같다 — 사이드바 항목이 뷰를 연다(#226 과 같은 방식).
  it('사이드바에서 인박스로 갈 수 있다', () => {
    fakeController(async () => ({ entries: [], threads: [] }));
    const onOpenInbox = vi.fn();
    render(
      <Sidebar panel="home"
        onOpenDirectory={vi.fn()} onOpenChannelDirectory={vi.fn()}
        onOpenInbox={onOpenInbox} onOpenAgentConfig={() => {}} onOpenProfile={() => {}}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('내 작업'));
    expect(onOpenInbox).toHaveBeenCalled();
  });
});
