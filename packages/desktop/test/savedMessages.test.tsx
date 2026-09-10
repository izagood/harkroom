import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { SavedMessageRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { SavedMessages } from '../src/components/SavedMessages';
import { MessageItem } from '../src/components/MessageItem';
import { Rail } from '../src/components/Rail';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, msg, fakeApi, scheduledApiStub } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

/**
 * **언어를 한국어로 고정한다.** 이 파일이 재는 것은 언어가 아니라 **그 언어로 표현된
 * 규율**이다 — 문구가 사전을 지나게 된 뒤(i18n 이전)에도 그 규율은 그대로여야 하므로,
 * 한국어 문구를 재는 줄을 지우는 대신 언어를 못 박는다. `gallery.test.tsx`·
 * `skillsSettings.test.tsx`·`agentGrid.test.tsx`·`accountAvatar.test.tsx` 가 세운 선례다.
 */
beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => usePrefsStore.getState().setLocale('system'));

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

describe('담아 둔 메시지 — 툴바와 사이드바 (#219)', () => {
  it('6. 툴바의 담기를 누르면 요청이 나간다', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m9', 'c1', 5, 'later', 'u2')} />);

    fireEvent.click(screen.getByTestId('toolbar-save'));
    expect(c.saveMessage).toHaveBeenCalledWith('m9');
  });

  it('6b. 이미 담긴 메시지면 같은 칸이 해제가 된다', () => {
    const c = fakeController();
    useAppStore.getState().set({ savedIds: ['m9'] });
    render(<MessageItem message={msg('m9', 'c1', 5, 'later', 'u2')} />);

    // 칸은 하나다 — 상태는 이름과 `aria-pressed` 가 말한다(두 칸을 나란히 두면 어느 것이
    // 지금 상태인지 화면이 말하지 않는다).
    const btn = screen.getByTestId('toolbar-save');
    expect(btn.getAttribute('aria-label')).toBe('담은 것 빼기');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(c.unsaveMessage).toHaveBeenCalledWith('m9');
  });

  // 담긴 상태를 패널이 받아 온 한 탭의 행들로 판단하면, '완료' 탭을 한 번 열어 본 뒤로
  // open 인 메시지가 담기지 않은 것으로 읽힌다. `savedIds` 는 두 상태를 다 담는다.
  it('6c. 완료로 옮긴 메시지도 담긴 상태다', () => {
    fakeController();
    useAppStore.getState().set({ savedIds: ['m9'], savedCount: 0 });
    render(<MessageItem message={msg('m9', 'c1', 5, 'later', 'u2')} />);

    expect(screen.getByTestId('toolbar-save').getAttribute('aria-label')).toBe('담은 것 빼기');
  });

  /**
   * **담아 둔 표식**(요청 2026-09-09). 6b·6c 가 재는 것은 `⋯` 메뉴의 문구라, 메뉴를 열지
   * 않고도 담긴 것을 알 수 있는지는 아무 줄도 지키지 않았다 — 그것이 이 요청이었다.
   *
   * 글자가 아니라 `data-testid` 로 집는다(desktop 관례): 문구는 사전을 지나므로 글자로
   * 집으면 번역 한 줄에 회귀선이 조용히 아무것도 안 지키게 된다. 다만 **무엇이라고 적히는지**
   * 도 한 번은 재야 하므로 첫 줄에서만 문구를 확인한다(이 파일은 언어를 ko 로 못 박았다).
   */
  it('6d. 담긴 메시지에는 이름줄 위에 표식이 선다', () => {
    fakeController();
    useAppStore.getState().set({ savedIds: ['m9'] });
    render(<MessageItem message={msg('m9', 'c1', 5, 'later', 'u2')} />);

    const mark = screen.getByTestId('saved-mark');
    expect(mark.textContent).toContain('나중을 위해 저장됨');
    // 이름줄 **위**여야 한다 — 이름줄 안에 들어가면 작성자에게 붙은 사실로 읽힌다.
    const column = screen.getByTestId('message-body-column');
    expect(column.firstElementChild).toBe(mark);
  });

  /**
   * **표식은 형태를 지닌다**(요청 2026-09-10 — *"통일성은 있지만 너무 눈에 띄지 않는다"*).
   *
   * 앞 판은 배경 없는 곁정보단 회색 글자라 같은 줄의 시각·꼬리표와 무게가 같았다. 고친 것은
   * 색이 아니라 형태(선·면)이므로, 이 줄이 지키는 것도 그 둘이다 — 클래스 문자열을 통째로
   * 재면 여백 하나만 바뀌어도 빨개지니 **선·면·글자색 세 가지**만 본다.
   *
   * 강조색은 여전히 금지다(`accentBudget.test.tsx` 가 소스를 직접 읽어 그것을 지킨다).
   * 여기서 `text-fg-muted` 가 아님을 재는 이유는, 곁정보단 회색으로 되돌아가면 칩의 선·면이
   * 남아 있어도 처음 문제(*안 보인다*)가 그대로 돌아오기 때문이다.
   */
  it('6d-2. 표식은 선과 면을 지닌 칩이다 — 배경 없는 회색 글자가 아니다', () => {
    fakeController();
    useAppStore.getState().set({ savedIds: ['m9'] });
    render(<MessageItem message={msg('m9', 'c1', 5, 'later', 'u2')} />);

    const mark = screen.getByTestId('saved-mark');
    expect(mark.className).toMatch(/border/);
    expect(mark.className).toMatch(/bg-/);
    expect(mark.className).not.toContain('text-fg-muted');
  });

  it('6e. 담기지 않은 메시지에는 표식이 없다', () => {
    fakeController();
    render(<MessageItem message={msg('m9', 'c1', 5, 'later', 'u2')} />);

    expect(screen.queryByTestId('saved-mark')).toBeNull();
  });

  /**
   * 요청의 나머지 절반이다 — *"해제하고 나면 마크는 없어지도록"*. 표식이 `savedIds` 만
   * 보므로(별도 상태가 없으므로) 해제가 요약을 다시 받아 오는 것만으로 사라져야 한다.
   */
  it('6f. 해제하면 표식이 사라진다', () => {
    fakeController();
    useAppStore.getState().set({ savedIds: ['m9'] });
    const view = render(<MessageItem message={msg('m9', 'c1', 5, 'later', 'u2')} />);
    expect(screen.getByTestId('saved-mark')).toBeTruthy();

    useAppStore.getState().set({ savedIds: [] });
    view.rerender(<MessageItem message={msg('m9', 'c1', 5, 'later', 'u2')} />);
    expect(screen.queryByTestId('saved-mark')).toBeNull();
  });

  /**
   * **개수가 사이드바 배지에서 레일 칸의 이름으로 옮겼다**(레일 문서 1단계).
   *
   * 문서: *"북마크는 레일에만 둔다"* 그리고 *"배지는 나를 막는 것만 센다 — 안 읽음까지
   * 세면 배지가 늘 켜져 있어서 아무 말도 하지 않게 된다."* 담아 둔 것은 내가 스스로 미뤄
   * 둔 것이고 나를 막지 않으므로 강조색 배지를 받지 않는다.
   *
   * 그래도 **수치는 살아 있어야 한다** — 세는 규칙(`savedIds` 가 아니라 `savedCount`,
   * 즉 완료를 뺀 open 개수)이 이 이슈의 요점이었고, 그 규칙이 조용히 사라지면 완료로 옮긴
   * 것까지 세는 예전 결함이 아무 저항 없이 돌아온다. 그래서 칸의 접근 가능한 이름으로 잰다.
   */
  it('7. 레일 북마크 칸의 이름이 open 개수를 말한다 — 배지가 아니라', () => {
    fakeController();
    useAppStore.getState().set({ savedCount: 3, savedIds: ['m1', 'm2', 'm3', 'm4'] });
    render(
      <Rail
        panel="home" onPanelChange={vi.fn()} onOpenSaved={vi.fn()}
        onOpenSettings={vi.fn()} onOpenCommunityMark={vi.fn()} onLogout={vi.fn()}
      />,
    );

    // savedIds 는 4개(완료 포함)지만 개수는 open 3 이다.
    const cell = screen.getByTestId('rail-saved');
    expect(cell.getAttribute('aria-label')).toContain('담아 둔 메시지 3개');
    // 강조색 배지는 그리지 않는다 — 나를 막는 것이 아니다.
    expect(screen.queryByTestId('rail-saved-badge')).toBeNull();
  });

  it('0 이면 개수를 말하지 않는다', () => {
    fakeController();
    useAppStore.getState().set({ savedCount: 0 });
    render(
      <Rail
        panel="home" onPanelChange={vi.fn()} onOpenSaved={vi.fn()}
        onOpenSettings={vi.fn()} onOpenCommunityMark={vi.fn()} onLogout={vi.fn()}
      />,
    );
    expect(screen.getByTestId('rail-saved').getAttribute('aria-label')).not.toContain('담아 둔');
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

  it('툴바에서 담으면 사이드바 배지가 갱신되고 패널이 그 행을 그린다', async () => {
    const { api } = realController();
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    // 담기 전에는 개수를 말하지 않는다.
    expect(screen.getByTestId('rail-saved').getAttribute('aria-label')).not.toContain('담아 둔');

    fireEvent.click(screen.getByTestId('toolbar-save'));

    // 요청이 나가고, **그 결과가 사이드바까지 온다** — 배선이 끊기면 여기서 실패한다.
    await waitFor(() => expect(api.saveMessage).toHaveBeenCalledWith('m9'));
    await waitFor(() => expect(
      screen.getByTestId('rail-saved').getAttribute('aria-label'),
    ).toContain('담아 둔 메시지 1개'));

    // 레일의 북마크 칸을 누르면 패널이 열리고 그 행이 있다.
    fireEvent.click(screen.getByTestId('rail-saved'));
    const panel = await screen.findByRole('dialog', { name: '저장된 메시지' });
    await waitFor(() => expect(within(panel).getByTestId('saved-entry-m9')).toBeTruthy());
  });

  it('담은 뒤 같은 칸이 해제로 바뀐다 — 재마운트 없이도', async () => {
    realController();
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByTestId('toolbar-save'));
    await waitFor(() => expect(
      screen.getByTestId('rail-saved').getAttribute('aria-label'),
    ).toContain('담아 둔 메시지 1개'));

    expect(screen.getByTestId('toolbar-save').getAttribute('aria-label')).toBe('담은 것 빼기');
  });
});
