import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Workspace } from '../src/components/Workspace';
import { RailIcon } from '../src/components/RailIcon';
import { TOP_BAR_H } from '../src/lib/platform';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, chan, scheduledApiStub } from './helpers/fakeApi';

/**
 * 창 왼쪽의 **크롬**(레일·사이드바·타이틀바)이 화면에서 지적받은 다섯 가지.
 * 전부 2026-09-08 에 사용자가 스크린샷으로 지적한 것이고, 각 묶음이 그중 하나를 진다.
 *
 * 1. 신호등 맨 오른쪽 단추가 레일 경계선에 붙어 있었다 → 레일 폭
 * 2. 네 칸의 그림이 이모지였다 → 선 아이콘 한 벌
 * 3. 칸이 레일 좌우에 꽉 차 있었다 → 여백
 * 4. 창 맨 위 한 줄이 조각마다 다른 색이었다 → `bg-titlebar` 하나
 * 5. 세 기둥이 전부 같은 면이었다 → 기둥마다 자기 토큰
 *
 * **재는 방식이 자리마다 다르다.** 화면에 있는 것(아이콘·타이틀바 조각)은 렌더해서 재고,
 * 커뮤니티가 둘 이상일 때만 서는 전환기는 소스를 읽어 잰다 — 전환기를 세우려면 커뮤니티
 * 레지스트리를 둘로 만들어야 하고, 그것은 `communitySwitcher.test.tsx` 가 이미 잰다.
 */

const src = (file: string): string =>
  readFileSync(resolve(process.cwd(), `src/components/${file}`), 'utf-8');

const fakeController = () => {
  const c = {
    openChannel: vi.fn().mockResolvedValue(undefined),
    startDm: vi.fn(),
    logout: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(),
    toggleChannelStar: vi.fn(),
    goBack: vi.fn().mockResolvedValue(true),
    goForward: vi.fn().mockResolvedValue(true),
    loadUnreadSweep: vi.fn().mockResolvedValue([]),
    api: scheduledApiStub(),
  };
  setController(c as unknown as Controller);
  return c;
};

const renderWorkspace = () => {
  localStorage.setItem('murmur.sidebarCollapsed', 'false');
  return render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
};

const CELLS = ['rail-home', 'rail-dm', 'rail-agents', 'rail-saved'] as const;

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin') },
    channels: [chan('c1', 'general')],
    connected: true,
    activeChannelId: 'c1',
    threadRootId: null,
  });
  fakeController();
  usePrefsStore.getState().setLocale('ko');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  usePrefsStore.getState().setLocale('system');
});

describe('1 · 신호등이 레일 경계선에 닿지 않는다', () => {
  /**
   * 신호등 3개는 창 왼쪽에서 **58px** 까지 차지한다(스크린샷 실측: 지름 12px, 맨 오른쪽
   * 단추의 중심이 52px). 레일이 62px 이었을 때 그 간격이 3px 이었고, 사용자가 "딱 붙어
   * 있어서 UI가 부자연스러워"라고 지적한 것이 그 3px 이다.
   *
   * **숫자를 여기서 다시 재지 않고 폭이 넉넉한지만 잰다** — 실제 픽셀은 jsdom 에 없다.
   * 대신 "58px + 눈에 보이는 간격" 이라는 요구를 하한으로 적는다: 이 단언이 잡는 것은
   * 누군가 폭을 다시 62px 로 되돌리는 변경이다.
   */
  it('레일 폭이 신호등(58px)보다 최소 10px 넓다', () => {
    renderWorkspace();
    const width = /w-\[(\d+)px\]/.exec(screen.getByTestId('rail').className);
    expect(width, '레일 폭이 임의값 클래스로 적혀 있지 않다').toBeTruthy();
    expect(Number(width![1])).toBeGreaterThanOrEqual(68);
  });

  it('전환기도 같은 폭이다 — 커뮤니티가 둘이면 그쪽이 창의 첫 열이다', () => {
    const width = /w-\[(\d+)px\]/.exec(src('CommunityRail.tsx'));
    expect(width).toBeTruthy();
    expect(Number(width![1])).toBeGreaterThanOrEqual(68);
  });
});

describe('2 · 네 칸의 그림이 선 아이콘 한 벌이다', () => {
  it('칸마다 svg 가 있고 이모지는 어디에도 없다', () => {
    renderWorkspace();
    const rail = screen.getByTestId('rail');
    for (const id of CELLS) {
      expect(screen.getByTestId(id).querySelector('svg'), id).toBeTruthy();
    }
    // 옛 글리프 넷. 하나라도 남아 있으면 한 벌이 아니다.
    expect(rail.textContent ?? '').not.toMatch(/[\u{1F3E0}\u{1F4AC}\u{1F916}\u{1F516}]/u);
  });

  /**
   * **`currentColor` 로 그려야 한다.** 이모지의 실제 결함이 이것이었다: 자기 색을 들고
   * 와서 고른 칸(`text-fg`)과 안 고른 칸(`text-fg-muted`)의 구분을 그림이 못 받았다.
   * `fill` 을 채우면 선 아이콘 한 벌이 아니라 한 칸만 다른 세트에서 온 것처럼 보인다.
   */
  it('색은 칸이 정하고 채움이 없다', () => {
    renderWorkspace();
    for (const id of CELLS) {
      const svg = screen.getByTestId(id).querySelector('svg')!;
      expect(svg.getAttribute('stroke'), id).toBe('currentColor');
      expect(svg.getAttribute('fill'), id).toBe('none');
      // 그림에는 이름을 주지 않는다 — 칸 버튼이 `aria-label` 로 이미 말한다.
      expect(svg.getAttribute('aria-hidden'), id).toBe('true');
    }
  });

  /**
   * 넷이 **서로 다른 그림**인지 본다. 표에서 이름 하나를 잘못 적으면(복사·붙여넣기)
   * 위 단언들은 전부 초록인 채로 두 칸이 같은 그림을 그린다.
   */
  it('넷이 서로 다른 모양이다', () => {
    const shapes = (['home', 'dm', 'agents', 'saved'] as const).map((name) => {
      const { container } = render(<RailIcon name={name} />);
      const html = container.querySelector('svg')!.innerHTML;
      cleanup();
      return html;
    });
    expect(new Set(shapes).size, '두 칸이 같은 그림을 그린다').toBe(4);
  });

  /** 한 벌로 보이려면 같은 격자·같은 굵기에서 나와야 한다(`RailIcon.tsx` 의 규칙). */
  it('넷이 같은 격자와 같은 굵기를 쓴다', () => {
    for (const name of ['home', 'dm', 'agents', 'saved'] as const) {
      const { container } = render(<RailIcon name={name} />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('viewBox'), name).toBe('0 0 24 24');
      expect(svg.getAttribute('stroke-width'), name).toBe('1.6');
      cleanup();
    }
  });
});

describe('3 · 칸이 레일 좌우 경계에서 떨어져 선다', () => {
  it('칸을 담은 상자에 가로 여백이 있다', () => {
    renderWorkspace();
    // 칸의 부모가 여백을 진다 — 칸 자체에 주면 hover 면이 여백까지 번진다.
    const box = screen.getByTestId('rail-home').parentElement!;
    expect(box.className).toMatch(/(^|\s)px-\d/);
  });

  it('내 얼굴 줄도 같은 여백을 쓴다 — 위아래가 다른 여백이면 레일이 기울어 보인다', () => {
    renderWorkspace();
    const box = screen.getByTestId('me-row').parentElement!;
    expect(box.className).toMatch(/(^|\s)px-\d/);
  });
});

describe('4 · 창 맨 위 한 줄이 한 색이다', () => {
  /**
   * 세 조각이 가로로 붙어 한 줄처럼 보인다(#359 가 높이를 `TOP_BAR_H` 로 맞췄다). 색은
   * 맞춰지지 않아서 레일 쪽은 레일 면, 브랜드 바는 사이드바 면, 헤더는 `surface-raised`
   * 였다 — 같은 한 줄이 세 색으로 갈렸다.
   */
  it('레일 띠·브랜드 바·헤더가 모두 bg-titlebar 다', () => {
    renderWorkspace();
    for (const id of ['rail-titlebar', 'sidebar-brand', 'app-header']) {
      expect(screen.getByTestId(id).className, id).toContain('bg-titlebar');
    }
  });

  it('세 조각의 높이가 같다 — 색만 같고 높이가 어긋나면 한 줄로 보이지 않는다', () => {
    renderWorkspace();
    for (const id of ['rail-titlebar', 'sidebar-brand', 'app-header']) {
      expect(screen.getByTestId(id).className, id).toContain(TOP_BAR_H);
    }
  });

  it('전환기 띠도 같은 토큰을 쓴다', () => {
    expect(src('CommunityRail.tsx')).toContain('bg-titlebar');
  });
});

describe('5 · 세 기둥이 서로 다른 면을 쓴다', () => {
  /**
   * 값이 아니라 **서로 다른 토큰인지**를 잰다. 계단의 순서(전환기 < 레일 < 사이드바 <
   * 본문)는 `appearanceSettings.test.tsx` 가 `index.css` 를 읽어 두 모드에서 잰다 —
   * 여기서 다시 재면 같은 것을 두 곳에서 유지하게 된다.
   */
  it('레일과 사이드바가 같은 면 토큰을 쓰지 않는다', () => {
    renderWorkspace();
    const rail = screen.getByTestId('rail').className;
    expect(rail).toContain('bg-surface-rail');
    expect(rail).not.toContain('bg-surface-sunken');
    // 사이드바의 면은 `aside` 루트가 진다 — testid 가 없어 소스로 잰다(`appearanceSettings`
    // 가 같은 방식으로 이 자리를 잰다).
    expect(src('Sidebar.tsx')).toContain('bg-surface-panel');
  });

  it('전환기는 또 다른 토큰이다 — 레일 바로 왼쪽에 서므로 같으면 두 기둥이 하나로 보인다', () => {
    const community = src('CommunityRail.tsx');
    expect(community).toContain('bg-surface-switcher');
    expect(community).not.toContain('bg-surface-sunken');
  });
});
