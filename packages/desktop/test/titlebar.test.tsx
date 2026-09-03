import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Workspace } from '../src/components/Workspace';
import { MAC_TRAFFIC_LIGHT_PL } from '../src/lib/platform';
import { acc, chan, scheduledApiStub } from './helpers/fakeApi';
// 설정 파일은 **이 파일 기준**으로 끌어온다(`?raw`, Vite 가 변환 시점에 해석한다). `process.cwd()`
// 로 조립하면 러너가 어디서 도는지에 결과가 달리고, 파일이 없으면 ENOENT 가 아니라 "경로가 틀렸다"
// 로 보인다 — 실제로 이 파일의 초판이 다른 기기의 절대 경로를 박아 두고 빨갛게 남아 있었다.
import baseConfRaw from '../src-tauri/tauri.conf.json?raw';
import macConfRaw from '../src-tauri/tauri.macos.conf.json?raw';

/**
 * macOS 에서 OS 타이틀바를 없애고 앱 바를 창 손잡이로 쓴다(#270).
 *
 * 이 파일이 지키는 것은 두 가지다. 하나, **신호등 여백은 창의 좌상단에 실제로 있는 바가
 * 진다** — 사이드바가 펴져 있으면 사이드바 브랜드 바, 접혀 있으면 `Workspace` 헤더다(접히면
 * 사이드바가 폭 0 이 된다). 둘, **드래그 손잡이는 바의 루트에만 있고 버튼·입력에는 없다** —
 * Tauri 는 속성이 붙은 요소 자체가 눌렸을 때만 창을 움직이므로, 버튼에 붙으면 그 버튼이 통째로
 * 안 눌리는 것이 아니라 "때때로 창이 끌린다" 는 형태로 샌다.
 */

const windowConf = (raw: string): Record<string, unknown> => {
  const conf = JSON.parse(raw) as { app: { windows: Record<string, unknown>[] } };
  return conf.app.windows[0]!;
};

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
    // #222: 컴포저가 예약 목록을 읽는다 — 목에 이 표면이 없으면 화면이 뜨지 않는다.
    api: scheduledApiStub(),
  };
  setController(c as unknown as Controller);
  return c;
};

/** macOS 인 척한다. `isMacOS()` 는 `navigator` 만 보므로 여기서만 갈아 끼운다. */
const pretendMac = () => vi.stubGlobal('navigator', {
  platform: 'MacIntel',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
});
const pretendWindows = () => vi.stubGlobal('navigator', {
  platform: 'Win32',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
});

/** 사이드바 접힘 여부는 `Workspace` 가 마운트할 때 저장소에서 한 번 읽는다. */
const renderWorkspace = (opts: { sidebarCollapsed: boolean }) => {
  localStorage.setItem('murmur.sidebarCollapsed', String(opts.sidebarCollapsed));
  return render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin') },
    channels: [chan('c1', 'general'), chan('c2', 'dev')],
    connected: true,
    activeChannelId: 'c2',
    // 뒤로·앞으로가 **둘 다 눌리는** 자리에 둔다. disabled 인 버튼은 클릭 검증이 무의미하다.
    history: [
      { channelId: 'c1', threadRootId: null },
      { channelId: 'c2', threadRootId: null },
      { channelId: 'c1', threadRootId: null },
    ],
    historyIndex: 1,
    threadRootId: null,
  });
  fakeController();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#270 창 설정', () => {
  it('tauri.macos.conf.json 이 타이틀바만 없애고 title 은 남긴다', () => {
    const w = windowConf(macConfRaw);
    expect(w.titleBarStyle).toBe('Overlay');
    expect(w.hiddenTitle).toBe(true);
    // 창 전환기·화면 공유·접근성이 읽는 값이라 지우지 않는다. `hiddenTitle` 로 가릴 뿐이다.
    expect(w.title).toBe('murmur');
  });

  /**
   * Tauri 2 의 플랫폼별 병합은 JSON Merge Patch(RFC 7396)라 **배열은 통째로 교체된다**.
   * `app.windows` 가 배열이므로 macOS 파일에 빠진 필드는 기본 파일 값이 아니라 Tauri 기본값으로
   * 떨어진다 — 그래서 크기까지 다시 적혀 있어야 한다. 이 한 줄이 없으면 macOS 빌드만 조용히
   * 다른 크기로 뜬다.
   */
  it('macOS 파일이 기본 파일의 창 크기를 다시 적는다 — 배열은 병합이 아니라 교체다', () => {
    const base = windowConf(baseConfRaw);
    const mac = windowConf(macConfRaw);
    expect(mac.width).toBe(base.width);
    expect(mac.height).toBe(base.height);
  });

  it('기본 tauri.conf.json 에는 decorations: false 가 없고 title 이 남아 있다', () => {
    const w = windowConf(baseConfRaw);
    // Windows·Linux 는 장식을 끄면 창 컨트롤이 통째로 사라진다 — 기본 파일은 손대지 않는다.
    expect(w.decorations).toBeUndefined();
    expect(w.title).toBe('murmur');
  });
});

describe('#270 드래그 손잡이', () => {
  const dragTargets = (root: HTMLElement): Element[] =>
    Array.from(root.querySelectorAll('button, input'));

  it('두 바의 루트에는 손잡이가 있다', () => {
    pretendMac();
    renderWorkspace({ sidebarCollapsed: false });

    expect(screen.getByTestId('app-header').hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(screen.getByTestId('sidebar-brand').hasAttribute('data-tauri-drag-region')).toBe(true);
  });

  it('두 바 안의 모든 버튼·입력에는 손잡이가 없다', () => {
    pretendMac();
    renderWorkspace({ sidebarCollapsed: false });

    for (const id of ['app-header', 'sidebar-brand']) {
      const targets = dragTargets(screen.getByTestId(id));
      // 하나도 없으면 이 단정은 아무것도 지키지 않는다 — 먼저 셀 것이 있음을 확인한다.
      expect(targets.length).toBeGreaterThan(0);
      for (const el of targets) {
        expect(el.hasAttribute('data-tauri-drag-region')).toBe(false);
      }
    }
  });

  it('로고에는 손잡이가 있다 — svg 는 그 자체가 이벤트 대상이 된다', () => {
    pretendMac();
    renderWorkspace({ sidebarCollapsed: false });

    const logo = screen.getByTestId('murmur-logo');
    expect(logo.closest('[data-tauri-drag-region]')).toBeTruthy();
  });
});

describe('#270 신호등 여백', () => {
  it('macOS·사이드바 펼침 — 브랜드 바가 여백을 지고 헤더는 지지 않는다', () => {
    pretendMac();
    renderWorkspace({ sidebarCollapsed: false });

    expect(screen.getByTestId('sidebar-brand').className).toContain(MAC_TRAFFIC_LIGHT_PL);
    // 둘 다 비우면 접었다 펼 때마다 78px 이 두 번 든다.
    expect(screen.getByTestId('app-header').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);
  });

  it('macOS·사이드바 접힘 — 좌상단이 된 헤더가 여백을 진다', () => {
    pretendMac();
    renderWorkspace({ sidebarCollapsed: true });

    expect(screen.getByTestId('app-header').className).toContain(MAC_TRAFFIC_LIGHT_PL);
    // 접히면 사이드바는 내용을 아예 그리지 않는다.
    expect(screen.queryByTestId('sidebar-brand')).toBeNull();
  });

  it('macOS 가 아니면 어느 상태에서도 여백이 없다', () => {
    pretendWindows();
    renderWorkspace({ sidebarCollapsed: false });
    expect(screen.getByTestId('sidebar-brand').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);
    expect(screen.getByTestId('app-header').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);

    cleanup();

    pretendWindows();
    renderWorkspace({ sidebarCollapsed: true });
    expect(screen.getByTestId('app-header').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);
  });
});

describe('#270 헤더 버튼은 여전히 눌린다', () => {
  it('뒤로·앞으로가 핸들러를 부른다', () => {
    pretendMac();
    const c = fakeController();
    renderWorkspace({ sidebarCollapsed: false });

    fireEvent.click(screen.getByRole('button', { name: '뒤로' }));
    expect(c.goBack).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '앞으로' }));
    expect(c.goForward).toHaveBeenCalledTimes(1);
  });

  it('미읽음 훑기가 열린다', async () => {
    pretendMac();
    renderWorkspace({ sidebarCollapsed: false });

    fireEvent.click(screen.getByRole('button', { name: '미읽음 훑기' }));
    expect(screen.getByRole('dialog', { name: '미읽음 훑기' })).toBeTruthy();
    // 훑기는 열리자마자 목록을 비동기로 받는다 — 흘려보내지 않으면 언마운트 뒤 상태 갱신이 샌다.
    await act(async () => { await Promise.resolve(); });
  });

  it('접힌 사이드바를 헤더의 펼치기 버튼으로 되돌린다', () => {
    pretendMac();
    renderWorkspace({ sidebarCollapsed: true });
    expect(screen.queryByTestId('sidebar-brand')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '사이드바 펼치기' }));

    expect(screen.getByTestId('sidebar-brand')).toBeTruthy();
    // 좌상단이 다시 사이드바로 넘어갔으므로 여백도 함께 넘어간다.
    expect(screen.getByTestId('sidebar-brand').className).toContain(MAC_TRAFFIC_LIGHT_PL);
    expect(screen.getByTestId('app-header').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);
  });
});
