import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { SavedMessageRow } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { SavedMessages } from '../src/components/SavedMessages';
import { MessageItem } from '../src/components/MessageItem';
import { Sidebar } from '../src/components/Sidebar';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, msg, fakeApi, scheduledApiStub } from './helpers/fakeApi';

/**
 * 나중에 볼 메시지의 데스크탑 쪽(#219).
 *
 * 마지막 두 건은 **Workspace 를 통째로 띄워서** 본다. 단위 테스트가 놓치는 것이 배선이다 —
 * #258 에서 팔레트의 단위 테스트가 초록인데 실제 화면에서는 초기 스코프가 반영되지 않았다
 * (마운트 시점에만 읽던 값). 여기서도 `⋯` 메뉴 → 요청 → 사이드바 배지 갱신은 세 부품이
 * 각자 맞아도 이어져 있지 않으면 사람에게는 아무 일도 일어나지 않는다.
 */

const entry = (
  messageId: string,
  state: 'open' | 'done',
  extra: Partial<SavedMessageRow> = {},
): SavedMessageRow => ({
  messageId,
  channelId: 'c1',
  state,
  createdAt: '2026-09-01T10:00:00.000Z',
  doneAt: state === 'done' ? '2026-09-02T10:00:00.000Z' : null,
  deleted: false,
  message: msg(messageId, 'c1', 3, `body of ${messageId}`, 'u2'),
  ...extra,
});

const fakeController = (over: Record<string, unknown> = {}) => {
  const c = {
    loadSavedMessages: vi.fn(async (_state: 'open' | 'done'): Promise<SavedMessageRow[]> => []),
    loadSavedSummary: vi.fn(async () => ({ openCount: 0, messageIds: [] as string[] })),
    updateSavedMessageState: vi.fn(async () => undefined),
    saveMessage: vi.fn(async () => undefined),
    unsaveMessage: vi.fn(async () => undefined),
    openMessage: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    pinMessage: vi.fn(async () => undefined),
    unpinMessage: vi.fn(async () => undefined),
    markChannelUnread: vi.fn(async () => undefined),
    // #222: 컴포저가 예약 목록을 읽는다 — 목에 이 표면이 없으면 화면이 뜨지 않는다.
    api: scheduledApiStub(),
    ...over,
  };
  setController(c as unknown as ControllerType);
  return c;
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    channels: [chan('c1', 'general')],
    activeChannelId: 'c1',
  });
});
afterEach(() => cleanup());

const openMenu = () => { fireEvent.click(screen.getByLabelText('More actions')); };

describe('담아 둔 메시지 — 패널 (#219)', () => {
  it('열면 "할 것" 탭의 목록을 서버에서 받아 그린다', async () => {
    const c = fakeController({
      loadSavedMessages: vi.fn(async (state: 'open' | 'done') =>
        state === 'open' ? [entry('m1', 'open')] : []),
    });
    render(<SavedMessages open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('saved-entry-m1')).toBeTruthy());
    expect(c.loadSavedMessages).toHaveBeenCalledWith('open');
    expect(screen.getByTestId('saved-entry-m1').textContent).toContain('body of m1');
  });

  it('8. 체크를 누르면 done 으로 바꾸고 행이 탭을 옮긴다', async () => {
    // 서버 흉내: 상태를 바꾸면 다음 조회의 결과가 실제로 달라진다. 그 재조회가 없으면
    // 화면은 눌린 행을 그대로 두고, 사람은 아무 일도 일어나지 않았다고 읽는다.
    let state: 'open' | 'done' = 'open';
    const c = fakeController({
      loadSavedMessages: vi.fn(async (tab: 'open' | 'done') =>
        (tab === state ? [entry('m1', state)] : [])),
      updateSavedMessageState: vi.fn(async (_id: string, next: 'open' | 'done') => { state = next; }),
    });
    render(<SavedMessages open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('saved-entry-m1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('saved-toggle-m1'));
    expect(c.updateSavedMessageState).toHaveBeenCalledWith('m1', 'done');

    // '할 것' 탭에서 빠진다 — 재조회가 없으면 여기서 실패한다.
    await waitFor(() => expect(screen.queryByTestId('saved-entry-m1')).toBeNull());
    // '완료' 탭으로 옮기면 그 자리에 있다.
    fireEvent.click(screen.getByText('완료'));
    await waitFor(() => expect(screen.getByTestId('saved-entry-m1')).toBeTruthy());
  });

  it('4. 삭제된 메시지는 "삭제된 메시지" 로 남고 누를 수 없다', async () => {
    const c = fakeController({
      loadSavedMessages: vi.fn(async () => [entry('m1', 'open', { deleted: true, message: null })]),
    });
    render(<SavedMessages open onClose={vi.fn()} />);

    const row = await screen.findByTestId('saved-entry-m1');
    expect(row.textContent).toContain('삭제된 메시지');
    // 갈 곳이 없으므로 버튼이 아니다 — 눌러도 아무 일이 없는 버튼은 거짓 신호다.
    expect(row.tagName).not.toBe('BUTTON');
    fireEvent.click(row);
    expect(c.openMessage).not.toHaveBeenCalled();
    // 그래도 완료로 표시할 수는 있어야 한다 — 담아 둔 사실은 내 기록이다.
    expect(screen.getByTestId('saved-toggle-m1')).toBeTruthy();
  });

  it('조회 실패를 "없다" 로 그리지 않는다', async () => {
    fakeController({
      loadSavedMessages: vi.fn(async () => { throw new Error('boom'); }),
    });
    render(<SavedMessages open onClose={vi.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('불러오지 못했다');
    expect(screen.queryByTestId('saved-empty')).toBeNull();
  });
});

describe('담아 둔 메시지 — 메뉴와 사이드바 (#219)', () => {
  it('6. ⋯ 메뉴에서 담기를 누르면 요청이 나간다', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m9', 'c1', 5, 'later', 'u2')} />);

    openMenu();
    fireEvent.click(screen.getByText('Save for later'));
    expect(c.saveMessage).toHaveBeenCalledWith('m9');
  });

  it('6b. 이미 담긴 메시지면 문구가 해제로 바뀐다', () => {
    const c = fakeController();
    useAppStore.getState().set({ savedIds: ['m9'] });
    render(<MessageItem message={msg('m9', 'c1', 5, 'later', 'u2')} />);

    openMenu();
    expect(screen.queryByText('Save for later')).toBeNull();
    fireEvent.click(screen.getByText('Unsave'));
    expect(c.unsaveMessage).toHaveBeenCalledWith('m9');
  });

  // 담긴 상태를 패널이 받아 온 한 탭의 행들로 판단하면, '완료' 탭을 한 번 열어 본 뒤로
  // open 인 메시지가 담기지 않은 것으로 읽힌다. `savedIds` 는 두 상태를 다 담는다.
  it('6c. 완료로 옮긴 메시지도 담긴 상태다', () => {
    fakeController();
    useAppStore.getState().set({ savedIds: ['m9'], savedCount: 0 });
    render(<MessageItem message={msg('m9', 'c1', 5, 'later', 'u2')} />);

    openMenu();
    expect(screen.getByText('Unsave')).toBeTruthy();
  });

  it('7. 사이드바 "Saved" 배지가 open 개수다', () => {
    fakeController();
    useAppStore.getState().set({ savedCount: 3, savedIds: ['m1', 'm2', 'm3', 'm4'] });
    render(
      <Sidebar
        onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenSaved={() => {}}
        onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()}
      />,
    );

    // savedIds 는 4개(완료 포함)지만 배지는 open 개수 3 이다.
    expect(screen.getByLabelText('담아 둔 메시지 3개').textContent).toBe('3');
  });

  it('배지는 0 이면 그리지 않는다', () => {
    fakeController();
    useAppStore.getState().set({ savedCount: 0 });
    render(
      <Sidebar
        onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenSaved={() => {}}
        onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/담아 둔 메시지/)).toBeNull();
  });
});

/**
 * 배선. 여기서 쓰는 것은 **진짜 `Controller`** 다 — 가짜 컨트롤러를 쓰면 "메뉴가 컨트롤러를
 * 불렀다" 까지만 확인되고, 그 호출이 사이드바 배지까지 오는지는 아무도 보지 않는다.
 */
describe('담아 둔 메시지 — Workspace 배선 (#219)', () => {
  const realController = () => {
    const saved = new Set<string>();
    const api = fakeApi({
      saveMessage: vi.fn(async (messageId: string) => {
        saved.add(messageId);
        return entry(messageId, 'open');
      }),
      savedSummary: vi.fn(async () => ({ openCount: saved.size, messageIds: [...saved] })),
      savedMessages: vi.fn(async (state: 'open' | 'done') =>
        (state === 'open' ? [...saved].map((id) => entry(id, 'open')) : [])),
    });
    const c = new Controller(api);
    setController(c);
    return { c, api };
  };

  beforeEach(() => {
    useAppStore.getState().set({
      messages: { c1: [msg('m9', 'c1', 5, 'read me later', 'u2')] },
      connected: true,
    });
  });

  it('⋯ 메뉴에서 담으면 사이드바 배지가 갱신되고 패널이 그 행을 그린다', async () => {
    const { api } = realController();
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    // 담기 전에는 배지가 없다.
    expect(screen.queryByLabelText(/담아 둔 메시지/)).toBeNull();

    openMenu();
    fireEvent.click(screen.getByText('Save for later'));

    // 요청이 나가고, **그 결과가 사이드바까지 온다** — 배선이 끊기면 여기서 실패한다.
    await waitFor(() => expect(api.saveMessage).toHaveBeenCalledWith('m9'));
    await waitFor(() => expect(screen.getByLabelText('담아 둔 메시지 1개').textContent).toBe('1'));

    // 사이드바 항목을 누르면 패널이 열리고 그 행이 있다.
    fireEvent.click(screen.getByText('Saved'));
    const panel = await screen.findByRole('dialog', { name: '저장된 메시지' });
    await waitFor(() => expect(within(panel).getByTestId('saved-entry-m9')).toBeTruthy());
  });

  it('담은 뒤 같은 메뉴를 다시 열면 해제로 바뀐다 — 재마운트 없이도', async () => {
    realController();
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    openMenu();
    fireEvent.click(screen.getByText('Save for later'));
    await waitFor(() => expect(screen.getByLabelText('담아 둔 메시지 1개')).toBeTruthy());

    openMenu();
    expect(screen.queryByText('Save for later')).toBeNull();
    expect(screen.getByText('Unsave')).toBeTruthy();
  });
});
