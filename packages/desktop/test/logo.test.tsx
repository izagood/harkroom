import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  /**
   * 강조 막대의 색은 **토큰이어야 한다**(실측 2026-09-08). `#E8613C` 를 못 박아 두면
   * 나머지 6 개는 `currentColor` 로 뒤집히는데 가운데만 라이트 값으로 남아, 다크에서
   * "로고 색이 안 바뀐다" 로 보인다. 색 이름을 세는 대신 *"막대에 리터럴 색이 없다"* 를
   * 지킨다 — 다음 사람이 다른 hex 를 박아도 같은 결함이 다시 잡힌다.
   */
  it('가운데 막대의 색이 하드코딩이 아니라 강조 토큰이다', () => {
    sidebar();
    const strokes = Array.from(
      screen.getByTestId('murmur-logo').querySelectorAll('path')
    ).map((path) => path.getAttribute('stroke') ?? '');

    expect(strokes.some((stroke) => stroke.includes('--color-accent-brand'))).toBe(true);
    // `currentColor` 와 `var(...)` 만 있어야 한다. 폴백 안의 hex 는 `var(` 로 시작하므로
    // 여기 걸리지 않는다 — 걸리는 것은 `stroke="#E8613C"` 처럼 못 박은 값이다.
    expect(strokes.filter((stroke) => stroke.startsWith('#'))).toEqual([]);
  });

  /**
   * favicon 사본은 문서 밖 리소스라 앱의 CSS 변수를 못 본다. 그래서 같은 두 값을
   * `prefers-color-scheme` 로 적어 두는데, 컴포넌트만 고치고 이 파일을 잊는 것이
   * 이 결함이 처음 생긴 경로다.
   */
  it('favicon 사본도 다크에서 강조색을 바꾼다', () => {
    const svg = readFileSync(join(__dirname, '../public/logo.svg'), 'utf-8');
    const darkBlock = svg.match(/@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?)\}\s*\}/)?.[1];
    expect(darkBlock, '다크 블록이 있어야 한다').toBeDefined();
    expect((darkBlock ?? '').toUpperCase()).toContain('#FF7B54');
  });

  /**
   * 상단 바 로고 크기(실측 2026-09-08, 사용자가 화면에서 지적). 이 바는 `h-9` = 36px 인데
   * 16px 은 44% 밖에 차지하지 않아 브랜드가 부스러기로 보였다. 옆 글자를 뺀 자리라
   * 로고가 유일한 브랜딩이다 — 절반은 넘고, 바를 꽉 채우지는 않는다.
   */
  it('상단 바 로고가 바 높이의 절반보다 크다', () => {
    sidebar();
    const size = Number(screen.getByTestId('murmur-logo').getAttribute('width'));
    expect(size).toBeGreaterThan(18);
    expect(size).toBeLessThanOrEqual(32);
  });
});
