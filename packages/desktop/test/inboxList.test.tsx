import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AskMeta, InboxEntry, InboxThreadState, MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { Inbox } from '../src/components/Inbox';
import { acc, chan, msg } from './helpers/fakeApi';

/**
 * Inbox **A안 받은 일**(목록 + 옆 상세, `InboxList`). 어느 카드가 어느 열·종류인지의 판정은
 * `inboxBoard.test.ts` 가, 옛 상태 보드(진행 보드 탭)는 `inbox.test.tsx` 가 잰다. 여기서는 **기본 보기**가
 * 할 일을 어떻게 세우고, 고른 것 하나를 어떻게 처리하는지 잰다.
 */
const ME = 'u1';
const BOT = 'u2';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const entry = (id: number, extra: Partial<InboxEntry> = {}): InboxEntry => ({
  id, messageId: `m${id}`, reason: 'mention', readAt: null, channelId: 'c1', authorId: BOT,
  body: `말 ${id}`, meta: {}, createdAt: new Date().toISOString(), threadRootId: null, ...extra,
});
const head = (id: string, extra: Partial<MessageRow> = {}): MessageRow => msg(id, 'c1', 1, `머리 ${id}`, ME, {
  replyCount: 1, openAskHumanCount: 0, openAskAccountIds: [], openAskLinks: [], unresolvedFailureCount: 0,
  failureCount: 0, lastKind: 'user', lastAuthorId: ME, ...extra,
});
const askMeta = (prompt: string) => ({
  kind: 'ask',
  ask: { prompt, options: [{ id: 'a', label: '이대로' }, { id: 'b', label: '다시' }], to: { kind: 'account', accountId: ME } as AskMeta['ask']['to'] },
} as unknown as Record<string, unknown>);
const failMeta = (reason: string) => ({
  kind: 'failure', failure: { retryable: true, what: '하네스가 사람의 확인을 기다린다', reason },
} as unknown as Record<string, unknown>);

const fakeController = (load: () => Promise<{ entries: InboxEntry[]; threads: MessageRow[] | null; threadStates?: InboxThreadState[] }>) => {
  const c = {
    api: {
      inboxBoard: vi.fn(async () => ({ threadStates: [], ...(await load()) })),
      setInboxThreadState: vi.fn(async () => ({ state: null })),
    },
    openMessage: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    loadInboxBoard: vi.fn(() => c.api.inboxBoard()),
    inboxBoardSnapshot: vi.fn(() => null),
    openChannel: vi.fn(async () => undefined),
    answerAsk: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

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
const states = (c: ReturnType<typeof fakeController>) =>
  c.api.setInboxThreadState.mock.calls.map((x) => x as unknown as [string, { state: string | null }]);
const selectedRoot = (): string | null =>
  screen.getAllByTestId(/^inbox-card-[a-z0-9]+$/).find((el) => el.getAttribute('aria-current') === 'true')
    ?.getAttribute('data-testid')?.replace('inbox-card-', '') ?? null;

/** 결정 둘(최근 것 d1) + 막힘 하나 + 내 차례 아닌 것 하나. */
const mixed = () => ({
  entries: [
    entry(1, { threadRootId: 'd1', meta: askMeta('머지할까?'), createdAt: at(HOUR) }),
    entry(2, { threadRootId: 'd2', meta: askMeta('권한을 줄까?'), createdAt: at(3 * HOUR) }),
    entry(3, { threadRootId: 'b1', meta: failMeta('MCP 인증이 필요하다'), createdAt: at(2 * HOUR) }),
    entry(4, { threadRootId: 'n1', reason: 'thread_reply', createdAt: at(HOUR / 2) }),
  ],
  threads: [
    head('d1', { openAskAccountIds: [ME], replyCount: 36 }),
    head('d2', { openAskAccountIds: [ME] }),
    head('b1', { unresolvedFailureCount: 1 }),
    head('n1', { lastKind: 'progress', lastAuthorId: BOT }),
  ],
});

describe('받은 일 — 기본 보기 (A안)', () => {
  it('할 일을 결정 → 막힘으로 묶고, 묶음 머리가 일 수를 말하고, 맨 위 줄이 골라져 있다', async () => {
    fakeController(async () => mixed());
    open();
    await screen.findByTestId('inbox-list-view');
    expect(screen.queryByTestId('inbox-board')).toBeNull();
    const sections = screen.getAllByTestId(/^inbox-section-(decision|blocker|news)$/).map((el) => el.getAttribute('data-testid'));
    expect(sections).toEqual(['inbox-section-decision', 'inbox-section-blocker']);
    expect(screen.getByTestId('inbox-section-count-decision').textContent).toBe('· 2');
    expect(screen.getByTestId('inbox-section-count-blocker').textContent).toBe('· 1');
    // 따로 요약 줄은 없다 — 수가 네 번 나오던 것을 줄였다(designer n5).
    expect(screen.queryByTestId('inbox-list-summary')).toBeNull();
    // 내 차례가 아닌 n1 은 할 일에 없다 — 소식 갈래에 있다.
    expect(screen.queryByTestId('inbox-card-n1')).toBeNull();
    expect(selectedRoot()).toBe('d1');
    const detail = screen.getByTestId('inbox-detail');
    expect(detail.getAttribute('data-root')).toBe('d1');
    expect(within(detail).getByTestId('inbox-card-answer-d1-a')).toBeTruthy();
    expect(within(detail).getByTestId('inbox-card-replies-d1').textContent).toBe('· 답글 36');
  });

  it('줄을 누르면 고르기만 하고 스레드는 열지 않는다 — 여는 것은 상세의 [스레드 열기]', async () => {
    const c = fakeController(async () => mixed());
    open();
    fireEvent.click(await screen.findByTestId('inbox-card-b1'));
    expect(c.openThread).not.toHaveBeenCalled();
    expect(screen.getByTestId('inbox-detail').getAttribute('data-root')).toBe('b1');
    fireEvent.click(screen.getByTestId('inbox-card-open-b1'));
    expect(c.openThread).toHaveBeenCalledWith('b1', { channelId: 'c1' });
    // 인박스는 남는다 — 스레드와 나란히 본다.
    expect(screen.getByTestId('inbox-list-view')).toBeTruthy();
  });

  it('띠는 고른 줄에만 — 안 읽은 줄은 띠가 없다 (designer s2)', async () => {
    fakeController(async () => mixed());
    open();
    const picked = await screen.findByTestId('inbox-card-d1');
    const unread = screen.getByTestId('inbox-card-d2');
    expect(unread.getAttribute('data-unread')).toBe('true');
    expect(picked.className).toContain('border-accent');
    expect(unread.className).not.toContain('border-accent');
  });

  it('할 일 탭에서는 줄마다 종류 글자를 달지 않는다 — 소식 탭에서는 단다 (designer n6)', async () => {
    fakeController(async () => mixed());
    open();
    const row = await screen.findByTestId('inbox-card-d1');
    expect(row.textContent).not.toContain('Decide');
    expect(row.textContent).not.toMatch(/결정$/);
    fireEvent.click(screen.getByTestId('inbox-tab-news'));
    expect(screen.getByTestId('inbox-card-n1').textContent).toMatch(/소식$/);
  });

  it('물음 카드에서는 [스레드 열기]가 테두리 버튼이고, 물음이 없으면 주황이다 (designer n7)', async () => {
    fakeController(async () => mixed());
    open();
    expect((await screen.findByTestId('inbox-card-open-d1')).className).not.toContain('bg-accent');
    fireEvent.click(screen.getByTestId('inbox-card-b1'));
    expect(screen.getByTestId('inbox-card-open-b1').className).toContain('bg-accent');
  });

  it('선택지 줄과 행동 줄은 따로다 (designer d1·n3)', async () => {
    fakeController(async () => mixed());
    open();
    const answer = await screen.findByTestId('inbox-card-answer-d1-a');
    const done = screen.getByTestId('inbox-card-done-d1');
    expect(answer.parentElement).not.toBe(done.parentElement);
    expect(answer.parentElement!.contains(done)).toBe(false);
  });
});

describe('키보드 — J/K · E · L · ↵', () => {
  it('J/K 로 옮기고, E 로 치우면 같은 자리의 다음 줄이 골라지고, 되돌리기 알림이 선다', async () => {
    let threadStates: InboxThreadState[] = [];
    const c = fakeController(async () => ({ ...mixed(), threadStates }));
    open();
    await screen.findByTestId('inbox-list-view');
    fireEvent.keyDown(screen.getByTestId('inbox-list-view'), { key: 'j' });
    expect(selectedRoot()).toBe('d2');
    fireEvent.keyDown(screen.getByTestId('inbox-list-view'), { key: 'k' });
    expect(selectedRoot()).toBe('d1');
    threadStates = [{ rootId: 'd1', state: 'done', until: null, updatedAt: new Date().toISOString() }];
    fireEvent.keyDown(screen.getByTestId('inbox-list-view'), { key: 'e' });
    await waitFor(() => expect(states(c)).toEqual([['d1', { state: 'done' }]]));
    await waitFor(() => expect(screen.queryByTestId('inbox-card-d1')).toBeNull());
    expect(selectedRoot()).toBe('d2');
    expect(screen.getByTestId('inbox-toast').textContent).toContain('1건 치웠다');
    fireEvent.click(screen.getByTestId('inbox-toast-undo'));
    await waitFor(() => expect(states(c).at(-1)).toEqual(['d1', { state: null }]));
  });

  it('고른 줄이 바뀌면 그 줄을 보이게 한다 (designer s1)', async () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      fakeController(async () => mixed());
      open();
      await screen.findByTestId('inbox-list-view');
      scroll.mockClear();
      fireEvent.keyDown(screen.getByTestId('inbox-list-view'), { key: 'j' });
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scroll.mock.contexts.at(-1)).toBe(screen.getByTestId('inbox-card-d2'));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('L 은 내일 아침으로 미룬다', async () => {
    const c = fakeController(async () => mixed());
    open();
    await screen.findByTestId('inbox-list-view');
    fireEvent.keyDown(screen.getByTestId('inbox-list-view'), { key: 'l' });
    await waitFor(() => expect(states(c)[0]?.[0]).toBe('d1'));
    expect(states(c)[0]![1].state).toBe('later');
    expect(screen.getByTestId('inbox-toast').textContent).toContain('내일 아침');
  });

  it('↵ 는 고른 줄의 스레드를 연다', async () => {
    const c = fakeController(async () => mixed());
    open();
    await screen.findByTestId('inbox-list-view');
    fireEvent.keyDown(screen.getByTestId('inbox-list-view'), { key: 'Enter' });
    expect(c.openThread).toHaveBeenCalledWith('d1', { channelId: 'c1' });
  });

  it('Inbox 밖에 포커스가 있으면 단축키를 받지 않는다 — 옆 스레드의 E·↓ 를 먹지 않는다 (security F1)', async () => {
    const c = fakeController(async () => mixed());
    open();
    await screen.findByTestId('inbox-list-view');
    // 옆 칸(스레드 패널 등)의 버튼 — Inbox 자리 밖이다.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(outside, { key: 'e' });
    fireEvent.keyDown(outside, { key: 'l' });
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    outside.dispatchEvent(down);
    outside.remove();
    expect(down.defaultPrevented).toBe(false);
    expect(c.api.setInboxThreadState).not.toHaveBeenCalled();
    expect(selectedRoot()).toBe('d1');
  });

  it('치우는 호출이 도는 동안 [되돌리기]는 잠겨 있다 (security n2)', async () => {
    const c = fakeController(async () => mixed());
    let finish: () => void = () => {};
    c.api.setInboxThreadState.mockImplementationOnce(() => new Promise((r) => { finish = () => r({ state: null }); }));
    open();
    fireEvent.click(await screen.findByTestId('inbox-card-done-d1'));
    const undo = screen.getByTestId('inbox-toast-undo') as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    finish();
    await waitFor(() => expect(undo.disabled).toBe(false));
  });

  it('글을 쓰는 중이면 단축키를 삼키지 않는다', async () => {
    const c = fakeController(async () => mixed());
    open();
    await screen.findByTestId('inbox-list-view');
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'e' });
    fireEvent.keyDown(input, { key: 'j' });
    input.remove();
    expect(c.api.setInboxThreadState).not.toHaveBeenCalled();
    expect(selectedRoot()).toBe('d1');
  });
});

describe('묶음 · 7일 · 갈래', () => {
  it('묶인 줄(×3)을 치우면 셋 다 치우고 알림이 수를 말한다', async () => {
    const c = fakeController(async () => ({
      entries: ['f1', 'f2', 'f3'].map((r, i) => entry(i + 1, { threadRootId: r, meta: failMeta('관문'), createdAt: at((i + 1) * 60_000) })),
      threads: ['f1', 'f2', 'f3'].map((r) => head(r, { unresolvedFailureCount: 1 })),
    }));
    open();
    expect((await screen.findByTestId('inbox-card-similar-f1')).textContent).toBe('×3');
    expect(screen.getByTestId('inbox-section-count-blocker').textContent).toBe('· 3');
    fireEvent.click(screen.getByTestId('inbox-card-done-f1'));
    await waitFor(() => expect(states(c).map((x) => x[0])).toEqual(['f1', 'f2', 'f3']));
    expect(screen.getByTestId('inbox-toast').textContent).toContain('3건 치웠다');
  });

  it('7일 넘은 것은 맨 아래 한 줄로 접히고 결정 수를 같이 말하며, 전부 치우기 한 번에 치운다 (R2 · designer n2)', async () => {
    const c = fakeController(async () => ({
      entries: [
        entry(1, { threadRootId: 'new', meta: askMeta('지금 것?'), createdAt: at(HOUR) }),
        entry(2, { threadRootId: 'old1', meta: askMeta('옛 결정?'), createdAt: at(10 * DAY) }),
        entry(3, { threadRootId: 'old2', meta: failMeta('옛 실패'), createdAt: at(12 * DAY) }),
      ],
      threads: [
        head('new', { openAskAccountIds: [ME] }),
        head('old1', { openAskAccountIds: [ME] }),
        head('old2', { unresolvedFailureCount: 1 }),
      ],
    }));
    open();
    const label = await screen.findByTestId('inbox-stale-label');
    expect(label.textContent).toBe('일주일 넘게 기다린 것 2 · 결정 1');
    // 접힌 동안은 줄이 없다 — 펼치면 선다.
    expect(screen.queryByTestId('inbox-card-old1')).toBeNull();
    fireEvent.click(screen.getByTestId('inbox-stale-toggle'));
    expect(screen.getByTestId('inbox-card-old1')).toBeTruthy();
    expect(screen.getByTestId('inbox-mine-count').textContent).toBe('나를 기다리는 일 1');
    fireEvent.click(screen.getByTestId('inbox-stale-clear-all'));
    await waitFor(() => expect(states(c).map((x) => x[0]).sort()).toEqual(['old1', 'old2']));
    expect(states(c).every((x) => x[1].state === 'done')).toBe(true);
  });

  it('소식 갈래는 내 차례가 아닌 일을 최근 것부터 보여 준다', async () => {
    fakeController(async () => mixed());
    open();
    fireEvent.click(await screen.findByTestId('inbox-tab-news'));
    expect(screen.getByTestId('inbox-card-n1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-card-d1')).toBeNull();
    expect(screen.getByTestId('inbox-tab-news').textContent).toContain('1');
  });

  it('미룬 것 갈래에서는 되돌리기 하나다', async () => {
    const c = fakeController(async () => ({
      ...mixed(),
      threadStates: [{ rootId: 'd2', state: 'later', until: new Date(Date.now() + DAY).toISOString(), updatedAt: new Date().toISOString() }],
    }));
    open();
    fireEvent.click(await screen.findByTestId('inbox-tab-later'));
    expect(screen.getByTestId('inbox-detail').getAttribute('data-root')).toBe('d2');
    expect(screen.queryByTestId('inbox-card-done-d2')).toBeNull();
    fireEvent.click(screen.getByTestId('inbox-card-undo-d2'));
    await waitFor(() => expect(states(c)).toEqual([['d2', { state: null }]]));
  });

  it('진행 보드 탭으로 옛 보드를 본다', async () => {
    fakeController(async () => mixed());
    open();
    fireEvent.click(await screen.findByTestId('inbox-view-board'));
    expect(screen.getByTestId('inbox-board')).toBeTruthy();
    expect(screen.queryByTestId('inbox-list-view')).toBeNull();
  });
});

describe('좁은 자리 — 목록 → 상세', () => {
  it('줄을 누르면 상세가 목록을 대신하고, ← 목록으로 돌아온다', async () => {
    fakeController(async () => mixed());
    open();
    const row = await screen.findByTestId('inbox-card-b1');
    const list = row.closest('ul')!.closest('section')!.parentElement!;
    expect(list.className.split(' ')).toContain('flex');
    fireEvent.click(row);
    expect(list.className.split(' ')).toContain('hidden');
    fireEvent.click(screen.getByTestId('inbox-detail-back'));
    expect(list.className.split(' ')).not.toContain('hidden');
  });
});
