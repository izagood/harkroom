import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { usePrefsStore } from '../src/state/prefsStore';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { prefsStorage, DEFAULT_PREFS } from '../src/lib/prefs';
import { AppearanceSettings } from '../src/components/settings/AppearanceSettings';
import { useColorMode } from '../src/lib/useColorMode';

/**
 * Appearance — System / Light / Dark (#112).
 *
 * 여기서 지키는 것은 "설정이 있다"가 아니라 **화면이 실제로 그 값을 따른다**는 것이다.
 * 그래서 `prefsStorage.load()`·`usePrefsStore`·`useColorMode` 를 흉내내지 않고 그대로
 * 부른다 — 병합 규칙이나 구독을 테스트 안에 다시 적으면 프로덕션 코드를 지우고도 초록이다.
 */

/** `useColorMode` 를 실제로 켠 화면. 훅만 부르는 것으로는 `<html>` 이 바뀌지 않는다. */
function Themed({ children }: { children?: React.ReactNode }) {
  useColorMode();
  return <>{children}</>;
}

/**
 * `prefers-color-scheme` 목. jsdom 의 `matchMedia` 는 `matches: false` 고정이고 이벤트를
 * 쏘지 않으므로(test/setup.ts), 구독을 확인하려면 리스너를 붙잡아 두는 목이 필요하다.
 */
function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let dark = initialDark;
  const mql = {
    get matches() { return dark; },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => { listeners.add(fn); },
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => { listeners.delete(fn); },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => mql });
  return {
    /** OS 설정이 바뀐 것을 흉내낸다. 값과 이벤트를 함께 바꾼다 — 실제 브라우저와 같다. */
    setDark(next: boolean) {
      dark = next;
      act(() => { for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent); });
    },
    get listenerCount() { return listeners.size; },
  };
}

const theme = () => document.documentElement.getAttribute('data-theme');

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  // 스토어는 모듈 로드 시점에 저장본을 읽었다 — 각 테스트가 자기 시작점을 정한다.
  usePrefsStore.setState({ ...DEFAULT_PREFS });
  installMatchMedia(false);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('요구 1 — 기본값과 기본값 병합', () => {
  it('기본값이 system 이다', () => {
    expect(DEFAULT_PREFS.colorMode).toBe('system');
  });

  /**
   * **`prefsStorage.load()` 를 실제로 부른다.** 초판은 병합 로직을 테스트 안에 그대로 다시
   * 적고 그 사본에 단언해, `prefs.ts` 에서 병합을 빼도 초록이었다 — 아무것도 지키지 않는다.
   */
  it('colorMode 가 없는 옛 저장본을 불러도 system 이다', () => {
    localStorage.setItem('murmur.prefs', JSON.stringify({
      notifications: { enabled: false }, sidebarWidth: 300,
    }));
    expect(prefsStorage.load().colorMode).toBe('system');
  });

  it('저장된 값이 있으면 그 값을 쓴다 — 위 단언이 항상 system 을 돌려주는 구현을 통과시키지 않는다', () => {
    localStorage.setItem('murmur.prefs', JSON.stringify({ colorMode: 'light' }));
    expect(prefsStorage.load().colorMode).toBe('light');
  });
});

describe('요구 2 — light/dark 를 고르면 data-theme 이 그 값이 되고 저장된다', () => {
  it('dark 를 고르면 html data-theme 이 dark 가 되고 저장된다', () => {
    render(<Themed><AppearanceSettings /></Themed>);

    fireEvent.click(screen.getByRole('radio', { name: 'Dark appearance' }));

    expect(theme()).toBe('dark');
    expect(JSON.parse(localStorage.getItem('murmur.prefs')!).colorMode).toBe('dark');
  });

  it('light 를 고르면 light 가 된다 — 위 단언이 항상 dark 를 쓰는 구현을 통과시키지 않는다', () => {
    render(<Themed><AppearanceSettings /></Themed>);

    fireEvent.click(screen.getByRole('radio', { name: 'Light appearance' }));

    expect(theme()).toBe('light');
    expect(JSON.parse(localStorage.getItem('murmur.prefs')!).colorMode).toBe('light');
  });

  /** 고정한 뒤에는 OS 가 바뀌어도 따라가지 않는다 — 그것이 '고른다'의 뜻이다. */
  it('light 로 고정하면 OS 가 다크로 바뀌어도 light 로 남는다', () => {
    const media = installMatchMedia(false);
    render(<Themed><AppearanceSettings /></Themed>);
    fireEvent.click(screen.getByRole('radio', { name: 'Light appearance' }));

    media.setDark(true);

    expect(theme()).toBe('light');
  });
});

describe('요구 3 — system 은 matchMedia 를 구독한다', () => {
  it('system 이면 OS 의 현재 값으로 시작한다', () => {
    installMatchMedia(true);
    render(<Themed />);
    expect(theme()).toBe('dark');
  });

  /**
   * **한 번 읽는 것으로는 부족하다.** OS 를 바꾸는 순간 따라가야 하고, 그것은 값을 다시
   * 읽는 것이 아니라 `change` 를 구독해야만 된다. `matchMedia().matches` 를 effect 안에서
   * 한 번만 읽는 구현으로 되돌리면 이 단언이 빨개진다.
   */
  it('system 에서 prefers-color-scheme 이 바뀌면 즉시 따라간다', () => {
    const media = installMatchMedia(false);
    render(<Themed />);
    expect(theme()).toBe('light');

    media.setDark(true);
    expect(theme()).toBe('dark');

    media.setDark(false);
    expect(theme()).toBe('light');
  });

  it('언마운트하면 구독을 뗀다 — 리스너가 쌓이면 죽은 화면이 테마를 계속 만진다', () => {
    const media = installMatchMedia(false);
    const view = render(<Themed />);
    expect(media.listenerCount).toBe(1);

    view.unmount();
    expect(media.listenerCount).toBe(0);
  });
});

describe('요구 4 — 로그아웃(appStore.reset) 후에도 colorMode 가 남는다', () => {
  it('reset() 은 설정 스토어를 건드리지 않는다', () => {
    render(<Themed><AppearanceSettings /></Themed>);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark appearance' }));
    expect(theme()).toBe('dark');

    // **실제로 로그아웃 경로를 부른다.** 저장소만 읽는 단언은 `reset()` 이 설정을
    // 지우도록 바뀌어도 초록이다.
    act(() => { useAppStore.getState().reset(); });

    expect(usePrefsStore.getState().colorMode).toBe('dark');
    expect(prefsStorage.load().colorMode).toBe('dark');
    expect(theme()).toBe('dark');
  });
});

describe('요구 5 — segmented control 3단', () => {
  it('세 단이 있고 각각 접근 가능한 이름을 갖는다', () => {
    render(<Themed><AppearanceSettings /></Themed>);

    const names = screen.getAllByRole('radio').map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['System appearance', 'Light appearance', 'Dark appearance']);
  });

  it('현재 값만 눌린 상태로 보인다', () => {
    render(<Themed><AppearanceSettings /></Themed>);
    const checked = () => screen.getAllByRole('radio')
      .filter((b) => b.getAttribute('aria-checked') === 'true')
      .map((b) => b.getAttribute('aria-label'));

    // 기본은 system 이다.
    expect(checked()).toEqual(['System appearance']);

    fireEvent.click(screen.getByRole('radio', { name: 'Dark appearance' }));
    expect(checked()).toEqual(['Dark appearance']);

    fireEvent.click(screen.getByRole('radio', { name: 'Light appearance' }));
    expect(checked()).toEqual(['Light appearance']);
  });

  it('묶음에 접근 가능한 이름이 있다 — 라디오 셋이 무엇을 고르는 것인지 말해야 한다', () => {
    render(<Themed><AppearanceSettings /></Themed>);
    expect(screen.getByRole('radiogroup', { name: /color mode/i })).toBeTruthy();
  });
});

/**
 * 요구 7 — 사이드바가 본문보다 **가라앉은 관계**가 두 모드에서 유지된다.
 *
 * jsdom 에는 레이아웃도 CSS 파싱도 없어 계산된 색을 읽을 수 없다. 그래서 **토큰 정의를
 * 읽는다** — `index.css` 의 두 블록에서 세 면의 밝기 순서를 비교한다. 초판은 다크에서
 * sunken 을 surface 보다 **밝게** 둬서 "가라앉은 면"이라는 역할 이름이 거짓이었고,
 * 어떤 단언도 그것을 잡지 않았다.
 */
describe('요구 7 — sunken < surface < raised 관계가 두 모드에서 같다', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf-8');

  /** `:root` / `:root[data-theme="dark"]` 블록에서 `--app-*` 값을 뽑는다. */
  function block(selector: string): Record<string, string> {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} 블록이 없다`).toBeGreaterThanOrEqual(0);
    const body = css.slice(start, css.indexOf('\n}', start));
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/--app-([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!;
    return out;
  }

  /** 상대 밝기(대략). 순서를 비교할 뿐이므로 정확한 WCAG 식은 필요하지 않다. */
  function luminance(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  }

  for (const [name, selector] of [['라이트', ':root'], ['다크', ':root[data-theme="dark"]']] as const) {
    it(`${name}: 사이드바(sunken)가 본문(surface)보다 가라앉아 있다`, () => {
      const t = block(selector);
      expect(luminance(t['surface-sunken']!)).toBeLessThan(luminance(t['surface']!));
    });

    it(`${name}: 카드·입력창(raised)은 본문보다 떠 있다`, () => {
      const t = block(selector);
      expect(luminance(t['surface-raised']!)).toBeGreaterThan(luminance(t['surface']!));
    });

    it(`${name}: 본문 글자가 본문 면과 충분히 대비된다`, () => {
      const t = block(selector);
      expect(Math.abs(luminance(t['fg']!) - luminance(t['surface']!))).toBeGreaterThan(100);
    });
  }

  /**
   * 두 모드가 **서로 다른 값**을 쓴다 — 값이 같으면 위 관계 단언은 통과하면서도 테마
   * 전환이 아무 일도 하지 않는다.
   */
  it('라이트와 다크의 면 값이 실제로 다르다', () => {
    const light = block(':root');
    const dark = block(':root[data-theme="dark"]');
    for (const key of ['surface', 'surface-raised', 'surface-sunken', 'fg']) {
      expect(dark[key], key).not.toBe(light[key]);
    }
    // 라이트가 다크보다 밝다 — 이름과 값이 뒤집히지 않았는지 본다.
    expect(luminance(light['surface']!)).toBeGreaterThan(luminance(dark['surface']!));
  });

  /** 사이드바가 실제로 그 토큰을 쓰는가 — 토큰만 옳고 화면이 안 쓰면 뜻이 없다. */
  it('사이드바가 surface-sunken 을, 본문이 surface 계열을 쓴다', () => {
    const sidebar = readFileSync(resolve(process.cwd(), 'src/components/Sidebar.tsx'), 'utf-8');
    expect(sidebar).toMatch(/bg-surface-sunken/);
    const channelPane = readFileSync(resolve(process.cwd(), 'src/components/ChannelPane.tsx'), 'utf-8');
    expect(channelPane).toMatch(/bg-surface(-raised)?\b/);
  });
});
