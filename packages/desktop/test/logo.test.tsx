import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { ConnectScreen } from '../src/screens/ConnectScreen';
import { acc, chan } from './helpers/fakeApi';

/**
 * 접근 가능한 이름으로 `murmur` 를 노출하는 자리의 수. 로고와 그 옆 텍스트가 둘 다
 * 이름을 내면 스크린리더가 같은 것을 두 번 읽는다(#191) — 그 회귀를 여기서 잡는다.
 */
const murmurNameCount = () =>
  // 같은 요소가 role 로도 텍스트로도 잡히므로(예: `<h1>murmur</h1>`) 요소 단위로 센다.
  //
  // **`<title>` 은 세지 않는다**(실측 2026-09-07). 로고 `<svg>` 가 접근성 이름을 낼 때
  // 그 안의 `<title>` 이 `queryAllByText` 에 따로 잡혀, **같은 로고 하나가 둘로 세어졌다**.
  // 브랜드 글자를 지우고 로고만 남긴 뒤 이 결함이 드러났다 — 세는 방식이 "로고 + 그 옆
  // 글자" 시절에만 맞았던 것이다. 지키려는 사실은 그대로다: 앱 이름을 내는 자리가 하나다.
  new Set([
    ...screen.queryAllByRole('img', { name: 'murmur' }),
    ...screen.queryAllByRole('heading', { name: 'murmur' }),
    ...screen.queryAllByText('murmur').filter((el) => el.tagName.toLowerCase() !== 'title'),
  ]).size;

beforeEach(() => {
  useAppStore.getState().reset();
  setController({ openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn() } as unknown as Controller);
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin') },
    channels: [chan('c1', 'general')],
    dms: [],
    connected: true,
    activeChannelId: 'c1',
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sidebar = () =>
  render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

describe('murmur 로고 (#191)', () => {
  /**
   * **글자는 뺐고 로고가 그 이름을 진다**(2026-09-07, 사용자가 지적).
   *
   * 초판은 *"로고를 넣으면서 기존 텍스트 브랜딩을 지우면 안 된다"* 였다. 그 근거는
   * 레일이 생기기 전 이야기다 — 지금은 레일이 커뮤니티 마크를 들고 서 있어, 앱 이름을
   * 브랜드 줄에서 또 적으면 같은 화면이 두 번 말한다.
   *
   * **이름 자체는 사라지지 않는다**(아래 회귀선이 하나임을 잰다) — 로고가 진다.
   */
  it('사이드바에 로고가 그려지고 그것이 이름을 진다', () => {
    sidebar();
    expect(screen.getByTestId('murmur-logo')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'murmur' })).toBeTruthy();
  });

  it('사이드바에서 접근 가능한 이름 murmur 는 하나뿐이다', () => {
    sidebar();
    expect(murmurNameCount()).toBe(1);
  });

  it('접속 화면에도 로고가 있다', () => {
    render(<ConnectScreen onConnected={vi.fn()} />);
    expect(screen.getByTestId('murmur-logo')).toBeTruthy();
  });

  it('접속 화면에서도 접근 가능한 이름 murmur 는 하나뿐이다', () => {
    render(<ConnectScreen onConnected={vi.fn()} />);
    expect(murmurNameCount()).toBe(1);
  });
});
