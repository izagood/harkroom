import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
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
  new Set([
    ...screen.queryAllByRole('img', { name: 'murmur' }),
    ...screen.queryAllByRole('heading', { name: 'murmur' }),
    ...screen.queryAllByText('murmur'),
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
  render(<Sidebar onOpenDirectory={() => {}} onOpenInbox={() => {}} onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />);

describe('murmur 로고 (#191)', () => {
  it('사이드바에 로고가 그려지고 텍스트 murmur 도 함께 있다', () => {
    sidebar();
    expect(screen.getByTestId('murmur-logo')).toBeTruthy();
    // 로고를 넣으면서 기존 텍스트 브랜딩을 지우면 안 된다.
    expect(screen.getByText('murmur')).toBeTruthy();
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
