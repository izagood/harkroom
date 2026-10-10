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
/**
 * 보드 보기로 연다. 기본 보기는 A안 받은 일(목록+상세)이고, 옛 상태 보드는 「진행 보드」 탭이다 —
 * 이 파일의 C안 시험은 그 보드를 잰다. 카드가 없으면 탭이 서지 않으므로 그때는 그냥 연다.
 */
const openBoard = async (onClose = vi.fn()) => {
  const r = open(onClose);
  const tab = await screen.findByTestId('inbox-view-board').catch(() => null);
  if (tab) fireEvent.click(tab);
  return r;
};

describe('Inbox 상태 보드 (C안)', () => {
  const failMeta = (reason: string) => ({
    kind: 'failure', failure: { retryable: true, what: '하네스가 사람의 확인을 기다린다', reason },
  } as unknown as Record<string, unknown>);

  it('내 차례 띠는 할 일의 종류로 묶는다 — 결정 → 막힘 → 소식 (R4)', async () => {
    fakeController(async () => ({
      entries: [
        entry(1, { threadRootId: 'stuck' }),
        entry(2, { threadRootId: 'fail', meta: failMeta('관문 화면에 섰다') }),
        entry(3, { threadRootId: 'ask', meta: askMeta({ kind: 'account', accountId: ME } as AskMeta['ask']['to'], '이대로 갈까?') }),
      ],
      threads: [
        head('stuck', { statusReaction: { status: 'stuck', emoji: '🚨', accountId: BOT, reason: null, updatedAt: new Date().toISOString() } as MessageRow['statusReaction'], unresolvedFailureCount: 0 }),
        head('fail', { unresolvedFailureCount: 1 }),
        head('ask', { openAskAccountIds: [ME] }),
      ],
    }));
    await openBoard();
    await screen.findByTestId('inbox-card-ask');
    const band = col('mine');
    const kinds = within(band).getAllByTestId(/^inbox-band-kind-(decision|blocker|news)$/).map((el) => el.getAttribute('data-testid'));
    expect(kinds).toEqual(['inbox-band-kind-decision', 'inbox-band-kind-blocker']);
    expect(within(screen.getByTestId('inbox-band-kind-decision')).getByTestId('inbox-card-ask')).toBeTruthy();
    expect(within(screen.getByTestId('inbox-band-kind-blocker')).getByTestId('inbox-card-fail')).toBeTruthy();
    // 실패 카드의 제목은 원인이다(R5) — 실패마다 같은 「무엇」이 아니라.
    expect(screen.getByTestId('inbox-card-summary-fail').textContent).toContain('관문 화면에 섰다');
  });

  it('같은 에이전트의 같은 실패는 한 줄 ×N 으로 묶이고, 치우면 묶인 일이 다 치워진다 (R5)', async () => {
    const c = fakeController(async () => ({
      entries: [
        entry(1, { threadRootId: 'f1', meta: failMeta('관문'), createdAt: new Date(Date.now() - 60_000).toISOString() }),
        entry(2, { threadRootId: 'f2', meta: failMeta('관문'), createdAt: new Date(Date.now() - 120_000).toISOString() }),
        entry(3, { threadRootId: 'f3', meta: failMeta('관문'), createdAt: new Date(Date.now() - 180_000).toISOString() }),
        entry(4, { threadRootId: 'f4', meta: failMeta('다른 원인') }),
      ],
      threads: ['f1', 'f2', 'f3', 'f4'].map((r) => head(r, { unresolvedFailureCount: 1 })),
    }));
    await openBoard();
    await screen.findByTestId('inbox-card-f1');
    expect(screen.queryByTestId('inbox-card-f2')).toBeNull();
    expect(screen.getByTestId('inbox-card-similar-f1').textContent).toBe('×3');
    expect(screen.getByTestId('inbox-card-f4')).toBeTruthy();
    expect(screen.queryByTestId('inbox-card-similar-f4')).toBeNull();
    // 숫자는 일(스레드) 수 그대로다.
    expect(screen.getByTestId('inbox-mine-count').textContent).toBe('나를 기다리는 일 4');
    // 묶음 머리도 일 수다(designer) — 줄은 둘이지만 막힘은 4.
    expect(screen.getByTestId('inbox-band-kind-count-blocker').textContent).toBe('4');
    fireEvent.click(screen.getByTestId('inbox-card-done-f1'));
    await waitFor(() => expect(c.api.setInboxThreadState).toHaveBeenCalledTimes(3));
    expect(c.api.setInboxThreadState.mock.calls.map((x) => (x as unknown as [string])[0])).toEqual(['f1', 'f2', 'f3']);
  });

  it('물음이 열린 카드는 같은 실패를 가져도 묶지 않는다 — 물음마다 따로 답한다 (security F1)', async () => {
    fakeController(async () => ({
      entries: ['q1', 'q2'].flatMap((r, i) => [
        entry(10 + i * 2, { threadRootId: r, meta: askMeta({ kind: 'account', accountId: ME }, `물음 ${r}?`) }),
        entry(11 + i * 2, { threadRootId: r, meta: failMeta('관문') }),
      ]),
      threads: ['q1', 'q2'].map((r) => head(r, { openAskAccountIds: [ME], unresolvedFailureCount: 1 })),
    }));
    await openBoard();
    await screen.findByTestId('inbox-card-q1');
    expect(screen.getByTestId('inbox-card-q2')).toBeTruthy();
    expect(screen.queryByTestId('inbox-card-similar-q1')).toBeNull();
    expect(screen.queryByTestId('inbox-card-similar-q2')).toBeNull();
    expect(screen.getByTestId('inbox-card-answer-q2-a')).toBeTruthy();
  });

  it('머리만 나를 지목한 결정 카드도 같은 실패로 묶지 않는다 (security n3)', async () => {
    fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'd1', meta: failMeta('관문') }), entry(2, { threadRootId: 'd2', meta: failMeta('관문') })],
      threads: ['d1', 'd2'].map((r) => head(r, { openAskAccountIds: [ME], unresolvedFailureCount: 1 })),
    }));
    await openBoard();
    await screen.findByTestId('inbox-card-d1');
    expect(screen.getByTestId('inbox-card-d2')).toBeTruthy();
    expect(screen.queryByTestId('inbox-card-similar-d1')).toBeNull();
  });

  it('같은 실패라도 채널이 다르면 묶지 않는다 (security n1)', async () => {
    fakeController(async () => ({
      entries: [
        entry(1, { threadRootId: 'f1', meta: failMeta('관문') }),
        entry(2, { threadRootId: 'f2', channelId: 'c2', meta: failMeta('관문') }),
      ],
      threads: [head('f1', { unresolvedFailureCount: 1 }), head('f2', { channelId: 'c2', unresolvedFailureCount: 1 })],
    }));
    await openBoard();
    await screen.findByTestId('inbox-card-f1');
    expect(screen.getByTestId('inbox-card-f2')).toBeTruthy();
    expect(screen.queryByTestId('inbox-card-similar-f1')).toBeNull();
  });

  it('답글 수는 첫 줄이 아니라 행동 줄에 서고, 선택지 줄과 행동 줄은 따로다 (designer d1)', async () => {
    fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', meta: askMeta({ kind: 'account', accountId: ME }, '어느 쪽?') })],
      threads: [head('r1', { openAskAccountIds: [ME], replyCount: 57 })],
    }));
    await openBoard();
    const card = await screen.findByTestId('inbox-card-r1');
    const replies = screen.getByTestId('inbox-card-replies-r1');
    expect(replies.textContent).toBe('답글 57');
    expect(card.contains(replies)).toBe(false);
    const actions = screen.getByTestId('inbox-card-done-r1').closest('div')!;
    expect(actions.contains(replies)).toBe(true);
    expect(actions.contains(screen.getByTestId('inbox-card-answer-r1-a'))).toBe(false);
  });

  it('보낸 사람 이름은 자르지 않고 채널부터 줄인다 (R6)', async () => {
    fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1' })],
      threads: [head('r1', { openAskAccountIds: [ME] })],
    }));
    await openBoard();
    await screen.findByTestId('inbox-card-r1');
    const who = screen.queryByTestId('inbox-card-who-r1');
    if (who) expect(who.className).not.toContain('truncate');
    expect(screen.getByTestId('inbox-card-channel-r1').className).toContain('truncate');
  });

  it('같은 일에서 온 다섯 줄이 카드 한 장으로 선다', async () => {
    fakeController(async () => ({
      entries: [1, 2, 3, 4, 5].map((i) => entry(i, { threadRootId: 'r1', reason: 'thread_reply' })),
      threads: [head('r1', { openAskAccountIds: [ME], replyCount: 57 })],
    }));
    await openBoard();
    const card = await screen.findByTestId('inbox-card-r1');
    expect(screen.getAllByTestId(/^inbox-card-r\d$/)).toHaveLength(1);
    // R6: 「+N개 더」(무엇의 수인지 모른다)가 아니라 스레드의 답글 수다.
    expect(screen.getByTestId('inbox-card-replies-r1').textContent).toBe('답글 57');
    expect(card.closest('li')!.textContent).not.toContain('개 더');
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
    await openBoard();
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

  it('내 차례 띠는 최근 것부터(R1) 다섯 장을 펼치고 나머지는 "+N개 더" 로 접는다', async () => {
    const roots = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    fakeController(async () => ({
      // 번호가 클수록 오래된 말이다 — 띠는 r1 부터 선다(R1).
      entries: roots.map((r, i) => entry(i + 1, { threadRootId: r, createdAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString() })),
      threads: roots.map((r) => head(r, { openAskAccountIds: [ME] })),
    }));
    await openBoard();
    await screen.findByTestId('inbox-card-r1');
    const band = col('mine');
    const more = within(band).getByTestId('inbox-band-more-decision');
    const open5 = within(band).getAllByTestId(/^inbox-card-r\d$/).filter((el) => !more.contains(el)).map((el) => el.getAttribute('data-testid'));
    expect(open5).toEqual(['inbox-card-r1', 'inbox-card-r2', 'inbox-card-r3', 'inbox-card-r4', 'inbox-card-r5']);
    expect(more.textContent).toContain('+2개 더');
    expect(screen.getByTestId('inbox-mine-count').textContent).toBe('나를 기다리는 일 7');
  });

  it('7일 넘게 기다린 내 차례는 띠 맨 아래로 접히고 수에서 빠진다 (R2)', async () => {
    fakeController(async () => ({
      entries: [
        entry(1, { threadRootId: 'fresh', createdAt: new Date(Date.now() - 3_600_000).toISOString() }),
        entry(2, { threadRootId: 'stale', createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }),
      ],
      threads: [head('fresh', { openAskAccountIds: [ME] }), head('stale', { openAskAccountIds: [ME] })],
    }));
    await openBoard();
    const fold = await screen.findByTestId('inbox-fold-mine-stale');
    expect(fold.textContent).toContain('일주일 넘게 기다린 것 1');
    expect(within(fold).getByTestId('inbox-card-stale')).toBeTruthy();
    expect(screen.getByTestId('inbox-mine-count').textContent).toBe('나를 기다리는 일 1');
  });

  it('내 차례가 없으면 띠는 한 줄로 줄어든다', async () => {
    fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1' })],
      threads: [head('r1', { lastKind: 'progress', lastAuthorId: BOT })],
    }));
    await openBoard();
    await screen.findByTestId('inbox-card-r1');
    expect(within(col('mine')).getByTestId('inbox-band-empty').textContent).toBe('나를 기다리는 일이 없다');
    expect(screen.queryByTestId('inbox-band-more-decision')).toBeNull();
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
    await openBoard();
    const summary = await screen.findByTestId('inbox-card-summary-m1');
    expect(summary.textContent).toBe('이건 @bob 에게 넘겨도 될까?');
  });

  it('나에게 온 물음은 카드에서 바로 고르고, 스레드는 열리지 않는다', async () => {
    const c = fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', meta: askMeta({ kind: 'account', accountId: ME }, '어느 쪽?') })],
      threads: [head('r1', { openAskAccountIds: [ME] })],
    }));
    await openBoard();
    fireEvent.click(await screen.findByTestId('inbox-card-answer-r1-a'));
    await waitFor(() => expect(c.answerAsk).toHaveBeenCalledWith('m1', 'a', 'c1'));
    expect(c.openThread).not.toHaveBeenCalled();
    // 내 차례에도 치우기와 나중에가 다 있다(R3) — 둘 다 수를 줄이는 길이다.
    expect(screen.getByTestId('inbox-card-done-r1').textContent).toBe('치우기');
    expect(screen.getByTestId('inbox-card-later-r1')).toBeTruthy();
  });

  it('남에게 간 물음은 카드에 선택지가 없다', async () => {
    fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', meta: askMeta({ kind: 'account', accountId: BOT }) })],
      threads: [head('r1', { openAskAccountIds: [BOT] })],
    }));
    await openBoard();
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
    await openBoard();
    fireEvent.click(await screen.findByTestId('inbox-card-done-r1'));
    await waitFor(() => expect(c.api.setInboxThreadState).toHaveBeenCalledWith('r1', { state: 'done' }));
    // 리액션은 건드리지 않는다 — 남에게 보이는 흔적이 남지 않는다.
    expect(c.toggleReaction).not.toHaveBeenCalled();
    states = [{ rootId: 'r1', state: 'done', until: null, updatedAt: new Date().toISOString() }];
    cleanup();
    await openBoard();
    const fold = await screen.findByTestId('inbox-fold-done-cleared');
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
    await openBoard();
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
    await openBoard();
    const fold = await screen.findByTestId('inbox-fold-mine-later');
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
    await openBoard(onClose);
    fireEvent.click(await screen.findByTestId('inbox-card-r1'));
    expect(c.openThread).toHaveBeenCalledWith('r1', { channelId: 'c1' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('채널 바로 밑의 말 하나면 그 말로 가고 보드는 자리를 내준다', async () => {
    const onClose = vi.fn();
    const c = fakeController(async () => ({ entries: [entry(9)], threads: [head('m9', { replyCount: 0 })] }));
    await openBoard(onClose);
    fireEvent.click(await screen.findByTestId('inbox-card-m9'));
    expect(c.openMessage).toHaveBeenCalledWith('m9');
    expect(onClose).toHaveBeenCalled();
  });

  it('카드를 누르면 새 말 표시가 곧바로 걷힌다', async () => {
    fakeController(async () => ({ entries: [entry(1, { threadRootId: 'r1' })], threads: [head('r1')] }));
    await openBoard();
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
    await openBoard();
    expect((await screen.findByTestId('inbox-card-age-r1')).textContent).toContain('3일째');
  });

  it('조회 실패가 "없다" 가 아니라 오류로 보인다', async () => {
    fakeController(async () => { throw new Error('boom'); });
    await openBoard();
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
    expect(screen.queryByTestId('inbox-empty')).toBeNull();
  });

  it('부른 것이 없으면 "없다" 를 보여 준다', async () => {
    fakeController(async () => ({ entries: [], threads: [] }));
    await openBoard();
    expect((await screen.findByTestId('inbox-empty')).textContent).toBe('아직 올라온 일이 없다');
  });

  it('나중에로 접은 줄은 띠와 열마다 testid 가 갈린다 — 한 화면에 같은 id 가 둘 서지 않는다', async () => {
    const later = new Date(Date.now() + 86_400_000).toISOString();
    fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', reason: 'thread_reply' }), entry(2, { threadRootId: 'r2', reason: 'thread_reply' })],
      threads: [head('r1', { openAskAccountIds: [ME] }), head('r2', { authorId: ME })],
      threadStates: ['r1', 'r2'].map((rootId) => ({ rootId, state: 'later' as const, until: later, updatedAt: new Date().toISOString() })),
    }));
    await openBoard();
    expect(within(await screen.findByTestId('inbox-fold-mine-later')).getByTestId('inbox-card-r1')).toBeTruthy();
    expect(within(screen.getByTestId('inbox-fold-active-later')).getByTestId('inbox-card-r2')).toBeTruthy();
    expect(screen.queryAllByTestId(/^inbox-fold-/).map((e) => e.dataset.testid)).toEqual(
      [...new Set(screen.queryAllByTestId(/^inbox-fold-/).map((e) => e.dataset.testid))]);
  });

  /**
   * 필터(W2b) — 서버가 준 머리 안에서만 거른다. 내가 연 것 ⊂ 참여한 것 ⊂ 모든 채널.
   * 머리글의 「나를 기다리는 일」은 거르기 전 수(배지와 같다).
   */
  it('필터: 내가 연 것 · 참여한 것 · 모든 채널', async () => {
    fakeController(async () => ({
      entries: [
        entry(1, { threadRootId: 'mine', reason: 'thread_reply' }),
        entry(2, { threadRootId: 'said', reason: 'thread_reply' }),
        entry(3, { threadRootId: 'called', reason: 'mention' }),
      ],
      threads: [
        head('mine', { authorId: ME }),
        head('said', { authorId: BOT, participantIds: [BOT, ME] }),
        head('called', { authorId: BOT, participantIds: [BOT], openAskAccountIds: [ME] }),
      ],
    }));
    await openBoard();
    await screen.findByTestId('inbox-card-called');
    const ids = () => screen.queryAllByTestId(/^inbox-card-(mine|said|called)$/).map((e) => e.dataset.testid).sort();
    expect(ids()).toEqual(['inbox-card-called', 'inbox-card-mine', 'inbox-card-said']);
    expect(screen.getByTestId('inbox-scope-all').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('inbox-scope-opened'));
    // 띠(내 차례)는 거르지 않는다 — 남의 스레드에서 나를 지목한 물음도 남는다(designer #1230).
    expect(ids()).toEqual(['inbox-card-called', 'inbox-card-mine']);
    expect(within(screen.getByTestId('inbox-col-mine')).getByTestId('inbox-card-called')).toBeTruthy();
    expect(screen.getByTestId('inbox-scope-opened').getAttribute('aria-pressed')).toBe('true');
    // 수 = 띠 = 배지.
    expect(screen.getByTestId('inbox-mine-count').textContent).toBe('나를 기다리는 일 1');

    fireEvent.click(screen.getByTestId('inbox-scope-participated'));
    expect(ids()).toEqual(['inbox-card-called', 'inbox-card-mine', 'inbox-card-said']);

    fireEvent.click(screen.getByTestId('inbox-scope-all'));
    expect(ids()).toHaveLength(3);
  });

  it('거른 범위가 비면 그렇게 말한다', async () => {
    fakeController(async () => ({
      entries: [entry(1, { threadRootId: 'r1', reason: 'mention' })],
      threads: [head('r1', { authorId: BOT, participantIds: [BOT] })],
    }));
    await openBoard();
    await screen.findByTestId('inbox-card-r1');
    expect(screen.queryByTestId('inbox-scope-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('inbox-scope-opened'));
    expect(screen.getByTestId('inbox-scope-empty').textContent).toBe('이 범위에는 일이 없다');
    expect(screen.queryByTestId('inbox-card-r1')).toBeNull();
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
    await openBoard();
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
    await openBoard();
    await screen.findByTestId('inbox-card-m1');
    expect(within(col('mine')).getByTestId('inbox-card-m1')).toBeTruthy();
  });

  it('쓰다 만 초안은 보드 밖 한 줄이고, 누르면 그 자리로 간다', async () => {
    const onClose = vi.fn();
    useAppStore.getState().set({ drafts: { c2: '쓰다 만 말', c1: '   ' } });
    const c = fakeController(async () => ({ entries: [], threads: [] }));
    await openBoard(onClose);
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
