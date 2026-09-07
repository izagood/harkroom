import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan, fakeApi, fakeWsFactory } from './helpers/fakeApi';

const fakeController = () => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(), setStatus: vi.fn(),
  };
  setController(c as unknown as Controller);
  return c;
};

const peer = { ...acc('u2', 'nari'), status: 'dnd' as const, statusText: '긴 턴 도는 중' };

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: peer },
    channels: [chan('c1', 'general')],
    dms: [{ id: 'd1', memberIds: ['u1', 'u2'], lastMessageAt: null }],
    // 상대는 **연결돼 있다**. 그래야 "연결 점과 상태 표시가 둘 다 있다"가 의미를 갖는다.
    online: ['u2'],
    connected: true,
    activeChannelId: 'c1',
  });
});

afterEach(() => { cleanup(); });

describe('사람이 정한 상태 (#186)', () => {
  it('DM 행에 연결 표시와 상태 표시가 둘 다 보인다', () => {
    // 결정 1의 회귀선: 상태는 연결 표시를 **대체하지 않는다**. 하나로 합치면 "연결이 끊긴
    // 사람"과 "방해 금지인 사람"이 한 표시로 뭉친다.
    //
    // **표시를 담는 자리가 바뀌었다**(`docs/desktop-rail.html` 2단계): 따로 있던 점이
    // 아바타 한 칸(`dm-face-*`)으로 들어갔다 — 그 점이 에이전트에게만 하나 더 붙어서
    // "줄만 봐도 누가 에이전트인지 알 수 있다"를 만들고 있었다(`Sidebar.tsx` 의 `dmRow`).
    // **이 이슈가 지키는 사실은 그대로다**: 연결 여부와 사람이 고른 상태가 화면에 **둘 다**
    // 있어야 한다. 여기서 그 둘을 각각 찾는다.
    fakeController();
    render(<Sidebar panel="dm" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    const face = screen.getByTestId('dm-face-d1');
    expect(face).toBeTruthy();
    // `#443`: 값이 셋이라 "붙어 있다/없다"의 참거짓이 아니다 — 사람에게 `ok` 는 붙어
    // 있다는 뜻이고, 끊긴 동안은 `unknown` 이다(아래 `silentDisconnect` 가 그쪽을 지킨다).
    expect(face.getAttribute('data-face')).toBe('ok');

    const mark = screen.getByTestId('status-u2');
    expect(mark).toBeTruthy();
    expect(mark.getAttribute('data-status')).toBe('dnd');
    // 문구는 접근성 이름으로 도달한다 — 좁은 행에 글자를 더 밀어 넣지 않으면서도 읽힌다.
    expect(mark.textContent).toContain('긴 턴 도는 중');
  });

  it('status.changed 를 받으면 화면이 갱신된다', async () => {
    // 소켓 이벤트부터 화면까지 **실제 경로**로 흘린다 — 스토어 액션만 직접 부르면
    // 컨트롤러가 그 이벤트를 처리하는지는 아무도 확인하지 않는다.
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    setController(c);
    await c.start();
    useAppStore.getState().set({
      me: acc('u1', 'admin'),
      accounts: { u1: acc('u1', 'admin'), u2: peer },
      channels: [chan('c1', 'general')],
      dms: [{ id: 'd1', memberIds: ['u1', 'u2'], lastMessageAt: null }],
      online: ['u2'],
    });
    render(<Sidebar panel="dm" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);
    expect(screen.getByTestId('status-u2').getAttribute('data-status')).toBe('dnd');

    act(() => {
      callbacks.current!.onEvent({
        type: 'status.changed', accountId: 'u2', status: 'away', statusText: '회의 중',
      });
    });

    const mark = screen.getByTestId('status-u2');
    expect(mark.getAttribute('data-status')).toBe('away');
    expect(mark.textContent).toContain('회의 중');
    // 상태가 바뀌어도 연결 표시는 그대로다 — 두 사실이 서로를 흔들지 않는다.
    // 표시가 아바타 칸으로 옮겨간 이유는 위 시험의 주석에 있다.
    expect(screen.getByTestId('dm-face-d1').getAttribute('data-face')).toBe('ok');
  });
});
