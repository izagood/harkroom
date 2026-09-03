import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, fakeApi } from './helpers/fakeApi';

/**
 * #258 의 두 진입점을 **Workspace 를 통째로 띄워서** 검증한다.
 *
 * `channelPane.test.tsx` 와 `searchPalette.test.tsx` 는 각자 한쪽만 본다 — 헤더 버튼이
 * 콜백을 부르는지, 팔레트가 `initialScoped` 를 받으면 좁히는지. 그 둘 사이의 배선
 * (Workspace 가 `scoped` 를 실제로 팔레트까지 전달하는지, 그리고 팔레트가 마운트된 채
 * `open` 만 뒤집히는 실제 구조에서도 그 값을 반영하는지)은 어느 쪽도 보지 않는다.
 * 실제로 그 틈에서 결함이 하나 나왔으므로(마운트 시점에만 읽히던 초기 스코프) 여기서
 * 사람이 누르는 경로 그대로 확인한다.
 */

const fakeController = () => {
  const api = fakeApi();
  const c = {
    api,
    openChannel: vi.fn().mockResolvedValue(undefined),
    openThread: vi.fn(),
    closeThread: vi.fn(),
    startDm: vi.fn(),
    logout: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(),
    toggleChannelStar: vi.fn(),
    notifyTyping: vi.fn(),
    refreshAccounts: vi.fn(),
    send: vi.fn(),
    loadOlder: vi.fn(),
    goBack: vi.fn().mockResolvedValue(false),
    goForward: vi.fn().mockResolvedValue(false),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general'), chan('c2', 'dev')],
    dms: [{ id: 'd1', memberIds: ['u1', 'u2'] }],
    connected: true,
    activeChannelId: 'c1',
  });
});

afterEach(() => {
  cleanup();
});

const openSearchFromHeader = () => {
  fireEvent.click(screen.getByRole('button', { name: '이 채널에서 찾기' }));
};

const pressCmdK = () => {
  // 리스너는 document 에 붙어 있다 — window 로 보내면 document 까지 내려오지 않는다.
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
};

const type = (value: string) => {
  fireEvent.change(screen.getByLabelText('검색어 입력'), { target: { value } });
};

describe('검색 진입점 배선 (#258)', () => {
  it('헤더 버튼으로 열면 스코프가 켜진 채 열리고 첫 검색이 채널로 좁혀진다', async () => {
    const c = fakeController();
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    openSearchFromHeader();

    const toggle = screen.getByLabelText('이 채널에서만 (general)') as HTMLInputElement;
    expect(toggle.checked, '헤더로 열면 스코프가 켜져 있어야 한다').toBe(true);

    type('hello');
    await waitFor(
      () => expect(c.api.search).toHaveBeenCalledWith('hello', 'c1'),
      { timeout: 1000 },
    );
  });

  it('⌘K 로 열면 전역이고 첫 검색이 좁혀지지 않는다', async () => {
    const c = fakeController();
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    pressCmdK();

    const toggle = screen.getByLabelText('이 채널에서만 (general)') as HTMLInputElement;
    expect(toggle.checked, '⌘K 는 전역이어야 한다').toBe(false);

    type('hello');
    await waitFor(
      () => expect(c.api.search).toHaveBeenCalledWith('hello', null),
      { timeout: 1000 },
    );
  });

  // 두 진입점을 번갈아 써도 매번 그 진입점이 정한 스코프로 열려야 한다. 팔레트는
  // 계속 마운트된 채 open 만 뒤집히므로, 초기 스코프를 마운트 때 한 번만 읽으면
  // 두 번째 열기부터 앞의 선택이 그대로 남는다.
  it('진입점을 번갈아 써도 매번 그 진입점의 스코프로 열린다', () => {
    fakeController();
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    pressCmdK();
    expect(
      (screen.getByLabelText('이 채널에서만 (general)') as HTMLInputElement).checked,
    ).toBe(false);
    fireEvent.keyDown(document, { key: 'Escape' });

    openSearchFromHeader();
    expect(
      (screen.getByLabelText('이 채널에서만 (general)') as HTMLInputElement).checked,
      '⌘K 로 한 번 열었다고 헤더 버튼이 전역으로 열려선 안 된다',
    ).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });

    pressCmdK();
    expect(
      (screen.getByLabelText('이 채널에서만 (general)') as HTMLInputElement).checked,
      '헤더 버튼으로 한 번 열었다고 ⌘K 가 좁힌 채 열려선 안 된다',
    ).toBe(false);
  });

  it('placeholder 가 어느 범위를 뒤지는지 말한다', () => {
    fakeController();
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    openSearchFromHeader();
    expect(screen.getByPlaceholderText('이 채널에서 찾기 (general)')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });

    pressCmdK();
    expect(screen.getByPlaceholderText('전체에서 찾기')).toBeTruthy();
  });

  // DM 도 채널과 같은 진입점을 갖는다. DM 은 채널이 아니지만 "지금 보는 대화 안에서
  // 찾기" 라는 요구는 똑같고, 검색 API 는 둘을 같은 channelId 로 받는다.
  it('DM 에서도 같은 버튼이 있고 그 DM 으로 좁혀진다', async () => {
    const c = fakeController();
    useAppStore.getState().set({ activeChannelId: 'd1' });
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    openSearchFromHeader();
    expect((screen.getByLabelText('이 채널에서만 (@bot)') as HTMLInputElement).checked).toBe(true);

    type('hello');
    await waitFor(
      () => expect(c.api.search).toHaveBeenCalledWith('hello', 'd1'),
      { timeout: 1000 },
    );
  });

  it('채널이 열려 있지 않으면 헤더 버튼 자체가 없다', () => {
    fakeController();
    useAppStore.getState().set({ activeChannelId: null });
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '이 채널에서 찾기' })).toBeNull();
  });
});
