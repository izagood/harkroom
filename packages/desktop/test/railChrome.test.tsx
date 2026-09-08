import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useActiveStore as useAppStore, resetCommunityRegistry } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Rail } from '../src/components/Rail';
import { Workspace } from '../src/components/Workspace';
import { TOP_BAR_BG, TOP_BAR_H } from '../src/lib/platform';
import { acc, chan, scheduledApiStub } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

/**
 * 창 왼쪽 껍데기 — 사용자가 화면을 보고 준 다섯 가지(2026-09-08).
 *
 * 1. 신호등 제일 오른쪽 버튼이 **세로 구분선에 붙어** 있다.
 * 2. 레일 네 칸의 그림이 이모지다 — 아이콘으로.
 * 3. 레일 좌우에 여백이 없다.
 * 4. 타이틀바 색이 조각마다 다르다.
 * 5. 기둥들이 색으로 구분되지 않는다.
 *
 * **이 파일이 재는 것은 화면의 값이 아니라 그 값들 사이의 관계다.** 픽셀 하나하나는 사람이
 * 화면을 보고 고르는 것이고 이 파일이 대신 고를 수 없다. 대신 잠글 수 있는 것은 *"세로선이
 * 신호등 자리를 지나가지 않는다"*, *"한 줄로 보이는 세 조각이 한 색을 쓴다"*, *"세 기둥의
 * 면이 서로 다르고 왼쪽으로 갈수록 가라앉는다"* 처럼 **다시 어긋날 수 있는 관계**다.
 */

const fakeController = () => {
  const c = {
    openChannel: vi.fn().mockResolvedValue(undefined),
    startDm: vi.fn(), logout: vi.fn(), createChannel: vi.fn(), updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(),
    goBack: vi.fn().mockResolvedValue(true), goForward: vi.fn().mockResolvedValue(true),
    loadUnreadSweep: vi.fn().mockResolvedValue([]),
    setStatus: vi.fn().mockResolvedValue(undefined),
    api: scheduledApiStub(),
  };
  setController(c as unknown as Controller);
  return c;
};

const mountRail = () =>
  render(
    <Rail
      panel="home"
      onPanelChange={vi.fn()}
      onOpenSaved={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenCommunityMark={vi.fn()}
      onLogout={vi.fn()}
    />,
  );

/** 신호등이 있는 쪽에서 본다 — 요청 1 이 macOS 화면의 이야기다. */
const pretendMac = () => vi.stubGlobal('navigator', {
  platform: 'MacIntel',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
});

beforeEach(() => {
  localStorage.clear();
  resetCommunityRegistry();
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'jaebin'),
    accounts: { u1: acc('u1', 'jaebin') },
    channels: [chan('c1', 'general'), chan('c2', 'dev')],
    connected: true,
    activeChannelId: 'c1',
  });
  fakeController();
  usePrefsStore.getState().setLocale('ko');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  usePrefsStore.getState().setLocale('system');
});

const railSrc = () => readFileSync(resolve(process.cwd(), 'src/components/Rail.tsx'), 'utf-8');
const css = () => readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf-8');

/**
 * `:root` / `:root[data-theme="dark"]` 블록의 `--app-*` 값을 읽는다.
 *
 * jsdom 에는 CSS 파싱이 없어 계산된 색을 읽을 수 없으므로 **정의를 읽는다** —
 * `appearanceSettings.test.tsx` 가 세운 방식 그대로다. 블록의 시작을 `${selector} {` 로
 * 찾는 것이 요점이다: 문자열 `:root` 만 찾으면 다크 블록의 선택자 안에도 그 글자가 있어
 * 라이트 블록을 찾다가 엉뚱한 곳을 읽는다.
 */
const tokens = (selector: string): Record<string, string> => {
  const src = css();
  const start = src.indexOf(`${selector} {`);
  expect(start, `${selector} 블록이 없다`).toBeGreaterThanOrEqual(0);
  const body = src.slice(start, src.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--app-([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!.toLowerCase();
  return out;
};

/** 밝기 — 순서만 비교하므로 근사식으로 충분하다(`appearanceSettings.test.tsx` 와 같은 식). */
const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
};

describe('요청 1 — 세로 구분선이 신호등을 지나가지 않는다', () => {
  /**
   * 실측(이 판 직전): 레일 전체에 `border-r` 이 걸려 그 선이 창 맨 위까지 올라왔고,
   * macOS 신호등은 78px 을 쓰는데 레일은 62px 이라 **초록 버튼이 그 선 위에 걸쳤다.**
   *
   * 고치는 방법이 둘 있었다 — 레일을 신호등만큼(86px+) 넓히거나, **선을 띠 아래에서
   * 시작**하거나. 앞쪽은 본문을 24px 먹으므로 뒤쪽을 골랐다. 그래서 잠그는 것은
   * *"맨 위 띠에는 오른쪽 테두리가 없다"* 다.
   */
  it('레일 맨 위 띠에는 오른쪽 테두리가 없고, 테두리는 그 아래 몸통이 진다', () => {
    pretendMac();
    mountRail();

    const strip = screen.getByTestId('rail-titlebar');
    expect(strip.className).toContain(TOP_BAR_H);
    expect(strip.className).not.toContain('border-r');

    // 선을 잃은 것이 아니다 — 띠 **아래**에서 시작한다.
    const rail = screen.getByTestId('rail');
    expect(rail.className).not.toContain('border-r');
    expect(rail.querySelectorAll('[class*="border-r"]').length).toBeGreaterThan(0);
  });

  it('띠는 창을 끄는 손잡이다 — 신호등 옆 빈 자리로 창을 옮길 수 있어야 한다', () => {
    pretendMac();
    mountRail();
    expect(screen.getByTestId('rail-titlebar').hasAttribute('data-tauri-drag-region')).toBe(true);
  });
});

describe('요청 2 — 네 칸의 그림이 선 아이콘이다', () => {
  it('네 칸 모두 svg 를 그리고 이모지는 어디에도 없다', () => {
    mountRail();

    for (const id of ['rail-home', 'rail-dm', 'rail-agents', 'rail-saved']) {
      const cell = screen.getByTestId(id);
      expect(cell.querySelector('svg'), id).toBeTruthy();
      // 글자로 남은 그림이 있으면 OS 마다 다른 그림이 뜬다.
      expect(cell.textContent, id).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    }
    expect(railSrc()).not.toMatch(/glyph:/);
  });

  /**
   * **색을 물려받는 것이 이모지를 버린 이유다.** 이모지는 자기 색을 들고 오므로 고른 칸과
   * 안 고른 칸에서 글자만 밝아지고 그림은 그대로였다 — 지금 어느 칸인지가 절반만 말해졌다.
   */
  it('아이콘이 `currentColor` 로 그려진다 — 칸의 상태를 그림도 따른다', () => {
    mountRail();
    for (const id of ['rail-home', 'rail-dm', 'rail-agents', 'rail-saved']) {
      const svg = screen.getByTestId(id).querySelector('svg')!;
      expect(svg.getAttribute('stroke'), id).toBe('currentColor');
      // 이름은 칸이 진다 — 그림이 또 내면 스크린리더가 칸을 두 번 읽는다.
      expect(svg.getAttribute('aria-hidden'), id).toBe('true');
    }
  });

  it('그림 옆의 글자는 그대로다 — 아이콘만 두지 않는다(레일 문서)', () => {
    mountRail();
    expect(within(screen.getByTestId('rail-agents')).getByText('Agents')).toBeTruthy();
  });
});

describe('요청 3 — 레일 좌우에 여백이 있다', () => {
  /**
   * 여백을 **칸에서 짜내지 않고 레일을 넓혔다.** 칸 폭 54px 은 라벨을 재어 고른 값이라
   * (가장 긴 `Agents` 가 11px 에서 32.89px) 그 안에서 빼면 라벨이 다시 위험해진다.
   * 70 − 54 = 16 이라 좌우가 8px 씩이다.
   */
  it('레일 70px · 칸 54px — 좌우 8px 이 남는다', () => {
    const src = railSrc();
    expect(src).toContain("const RAIL_W = 'w-[70px]'");
    expect(src).toContain('w-[54px]');
  });

  it('칸이 가운데 선다 — 여백이 한쪽으로 몰리지 않는다', () => {
    mountRail();
    const body = screen.getByTestId('rail-home').closest('[class*="items-center"]');
    expect(body).toBeTruthy();
  });
});

describe('요청 4 — 타이틀바 한 줄이 한 색이다', () => {
  /**
   * 한 줄로 보이는 세 조각(레일의 띠 · 사이드바 브랜드 바 · `Workspace` 헤더)은 높이를 한
   * 상수(`TOP_BAR_H`)가 정하고 있었는데 **색은 각자 적고 있었다** — 실측으로 sunken ·
   * sunken · raised 세 가지였다. 색도 한 상수가 정한다.
   */
  it('세 조각이 모두 `TOP_BAR_BG` 를 쓴다', () => {
    pretendMac();
    localStorage.setItem('murmur.sidebarCollapsed', 'false');
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    for (const id of ['rail-titlebar', 'sidebar-brand', 'app-header']) {
      expect(screen.getByTestId(id).className, id).toContain(TOP_BAR_BG);
    }
  });

  it('색을 손으로 적은 조각이 남아 있지 않다 — 다음에 한쪽만 고쳐지는 것을 막는다', () => {
    for (const file of ['src/components/Sidebar.tsx', 'src/components/Workspace.tsx']) {
      const src = readFileSync(resolve(process.cwd(), file), 'utf-8');
      const bar = src.split('${TOP_BAR_H}')[1]!.split('`}')[0]!;
      expect(bar, file).toContain('${TOP_BAR_BG}');
      expect(bar, file).not.toMatch(/bg-surface-(raised|sunken)/);
    }
  });
});

describe('요청 5 — 기둥마다 면이 다르다', () => {
  it('레일이 자기 면 토큰을 쓴다', () => {
    mountRail();
    expect(screen.getByTestId('rail').className).toContain('bg-surface-rail');
  });

  for (const [name, selector] of [['라이트', ':root'], ['다크', ':root[data-theme="dark"]']] as const) {
    /**
     * **왼쪽으로 갈수록 가라앉는다** — `rail < sunken < surface`. 이름과 값이 뒤집히면
     * 역할 이름이 거짓이 되고, 두 모드가 서로 다른 규칙을 갖게 된다(`index.css` 의 다크
     * 블록 주석이 같은 사고의 기록이다).
     */
    it(`${name}: 레일이 사이드바보다, 사이드바가 본문보다 가라앉아 있다`, () => {
      const t = tokens(selector);
      expect(t['surface-rail']).toBeTruthy();
      expect(luminance(t['surface-rail']!)).toBeLessThan(luminance(t['surface-sunken']!));
      expect(luminance(t['surface-sunken']!)).toBeLessThan(luminance(t['surface']!));
    });

    it(`${name}: 세 면이 서로 다른 값이다 — 구분되는 느낌이 값에서 나온다`, () => {
      const t = tokens(selector);
      const three = [t['surface-rail']!, t['surface-sunken']!, t['surface']!];
      expect(new Set(three).size).toBe(3);
    });
  }

  it('두 모드가 서로 다른 레일 색을 쓴다', () => {
    expect(tokens(':root')['surface-rail']).not.toBe(tokens(':root[data-theme="dark"]')['surface-rail']);
  });

  it('Tailwind 가 그 토큰을 유틸리티로 낸다 — 토큰만 있고 클래스가 없으면 화면이 안 바뀐다', () => {
    expect(css()).toContain('--color-surface-rail: var(--app-surface-rail)');
  });
});
