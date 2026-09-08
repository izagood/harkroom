import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Workspace } from '../src/components/Workspace';
import App from '../src/App';
import { MAC_TRAFFIC_LIGHT_PL, MAC_TITLEBAR_H, TOP_BAR_H } from '../src/lib/platform';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, chan, scheduledApiStub } from './helpers/fakeApi';
// 설정 파일은 **이 파일 기준**으로 끌어온다(`?raw`, Vite 가 변환 시점에 해석한다). `process.cwd()`
// 로 조립하면 러너가 어디서 도는지에 결과가 달리고, 파일이 없으면 ENOENT 가 아니라 "경로가 틀렸다"
// 로 보인다 — 실제로 이 파일의 초판이 다른 기기의 절대 경로를 박아 두고 빨갛게 남아 있었다.
import capabilitiesRaw from '../src-tauri/capabilities/default.json?raw';
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
  // **언어를 한국어로 고정한다.** 이 파일의 축들은 사이드바의 한국어 문구로 쓰여 있고,
  // 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(#619 가 대기 사슬에서
  // 세운 방식과 같다). 영어가 원본이 되면서 기본값이 영어가 됐으므로, 한국어를 재려면
  // 한국어라고 말해야 한다 — 그리고 그렇게 적어 두면 이 축들이 무엇을 재는지가 오히려
  // 또렷해진다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
  usePrefsStore.getState().setLocale('ko');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  usePrefsStore.getState().setLocale('system');
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

/**
 * #270 신호등 여백 — **레일이 생기면서 답이 하나로 굳었다**(레일 문서 1단계).
 *
 * 원래 이 규칙은 "창의 좌상단에 실제로 있는 바가 여백을 진다"였고, 사이드바를 접느냐에
 * 따라 그 자리가 브랜드 바와 헤더 사이를 오갔다. 이제 레일이 **항상** 왼쪽 첫 열이라
 * 좌상단은 늘 레일이다 — 접든 펴든 다른 두 곳은 여백을 지지 않는다.
 *
 * 레일은 **세로**로 비운다, 가로가 아니다. `CommunityRail` 이 그 이유를 적어 뒀다:
 * 레일은 신호등 3개(78px)보다 좁아서 `pl-[78px]` 로는 피할 수 없다. 그래서 이 파일의
 * 단언도 `MAC_TRAFFIC_LIGHT_PL` 이 **두 바에 없다**는 쪽으로 바뀐다.
 *
 * **비우는 방법이 `pt-8` 에서 띠 하나로 바뀌었다**(2026-09-08, 사용자 요청 1·4). 레일 맨 위에
 * `TOP_BAR_H`(36px) 짜리 조각(`rail-titlebar`)이 서서 그 자리를 비우고, 동시에 브랜드 바·헤더와
 * 같은 색을 지며 오른쪽 테두리를 지지 않는다 — 그래야 세로선이 신호등을 지나가지 않는다.
 * 그래서 이 절의 단언은 `pt-8` 대신 그 띠를 본다. **플랫폼 분기도 사라졌다**: 띠는 신호등을
 * 피하기 위한 것만이 아니라 옆 두 바와 한 줄을 이루는 조각이라 Windows 에서도 서야 한다
 * (없으면 레일의 내용만 28px 위로 올라가 한 줄이 어긋난다).
 */
describe('#270 신호등 여백', () => {
  it('macOS·사이드바 펼침 — 좌상단은 레일이라 브랜드 바도 헤더도 여백을 지지 않는다', () => {
    pretendMac();
    renderWorkspace({ sidebarCollapsed: false });

    expect(screen.getByTestId('sidebar-brand').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);
    expect(screen.getByTestId('app-header').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);
    // 여백을 잃은 것이 아니라 옮긴 것이다 — 레일 맨 위의 띠가 그 자리를 비운다.
    expect(screen.getByTestId('rail-titlebar').className).toContain(TOP_BAR_H);
  });

  it('macOS·사이드바 접힘 — 레일이 남으므로 헤더가 좌상단이 되지 않는다', () => {
    pretendMac();
    renderWorkspace({ sidebarCollapsed: true });

    expect(screen.getByTestId('app-header').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);
    // 접히면 사이드바는 내용을 아예 그리지 않는다. 레일은 그대로 남는다 —
    // 문서가 요구한 "좁은 창에서는 레일만 남기고 패널을 접는" 단계가 이것이다.
    expect(screen.queryByTestId('sidebar-brand')).toBeNull();
    expect(screen.getByTestId('rail')).toBeTruthy();
    expect(screen.getByTestId('rail-titlebar').className).toContain(TOP_BAR_H);
  });

  it('macOS 가 아니어도 띠는 남는다 — 신호등 때문만이 아니라 한 줄을 이루는 조각이다', () => {
    pretendWindows();
    renderWorkspace({ sidebarCollapsed: false });
    expect(screen.getByTestId('sidebar-brand').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);
    expect(screen.getByTestId('app-header').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);
    expect(screen.getByTestId('rail-titlebar').className).toContain(TOP_BAR_H);
    // 옛 방식(레일 자체의 세로 여백)은 사라졌다 — 두 방법이 함께 있으면 여백이 두 번 든다.
    expect(screen.getByTestId('rail').className).not.toContain('pt-8');

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
    // 좌상단은 접든 펴든 레일이다 — 여백이 두 바 사이를 오가지 않는다(위 describe 주석).
    expect(screen.getByTestId('sidebar-brand').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);
    expect(screen.getByTestId('app-header').className).not.toContain(MAC_TRAFFIC_LIGHT_PL);
  });
});

/**
 * #342: 손잡이가 `Workspace` 안에만 있었다. 창 설정(`titleBarStyle: "Overlay"`)은 앱 전역이라
 * OS 타이틀바는 모든 화면에서 사라졌는데 대체 손잡이는 한 화면에만 생겼고, 그래서 로그인
 * 전에는 창을 옮길 수단이 없었다.
 *
 * **이 블록은 `Workspace` 가 아니라 `App` 을 마운트한다.** 위쪽 블록들이 쓰는
 * `renderWorkspace()` 는 `App` 의 `phase` 분기를 통과하지 않아서, 전부 초록인 채로 이 구멍을
 * 그대로 두었다 — 같은 헬퍼를 재사용하면 회귀선이 아무것도 지키지 못한다.
 */
describe('#342 로그인 전 화면의 창 손잡이', () => {
  const findStrip = () => document.querySelector('[data-testid="window-drag-strip"]');

  it('로그인 화면에 손잡이가 있다', async () => {
    pretendMac();
    render(<App />);

    // 접속 화면이 실제로 떴는지 먼저 확인한다 — 안 뜬 화면에서 손잡이가 없는 것은
    // 이 이슈와 다른 이야기다.
    expect(await screen.findByText('Server URL')).toBeTruthy();
    const strip = findStrip();
    expect(strip).toBeTruthy();
    expect(strip!.hasAttribute('data-tauri-drag-region')).toBe(true);
  });

  it('로그인 폼의 입력·버튼에는 손잡이가 없다 — 붙으면 포커스가 드래그에 먹힌다', async () => {
    pretendMac();
    render(<App />);
    expect(await screen.findByText('Server URL')).toBeTruthy();

    const targets = Array.from(document.querySelectorAll('form button, form input'));
    expect(targets.length).toBeGreaterThan(0);
    for (const el of targets) {
      expect(el.hasAttribute('data-tauri-drag-region')).toBe(false);
      // 조상에 붙어도 같은 사고가 난다 — Tauri 는 속성이 붙은 요소 자체만 보지만,
      // 폼을 통째로 감싸는 손잡이는 폼 바깥 클릭과 구분되지 않는다.
      expect(el.closest('[data-tauri-drag-region]')).toBeNull();
    }
  });

  it('로그인 화면의 입력이 여전히 값을 받는다', async () => {
    pretendMac();
    render(<App />);
    expect(await screen.findByText('Server URL')).toBeTruthy();

    const loginId = screen.getByLabelText('Login ID') as HTMLInputElement;
    fireEvent.change(loginId, { target: { value: 'admin' } });
    expect(loginId.value).toBe('admin');
  });

  it('macOS 가 아니면 띠를 그리지 않는다 — OS 장식이 그대로 있다', async () => {
    pretendWindows();
    render(<App />);
    expect(await screen.findByText('Server URL')).toBeTruthy();
    expect(findStrip()).toBeNull();
  });
});

/**
 * 손잡이를 붙여도 **권한이 없으면 창은 끌리지 않는다**(#353).
 *
 * `data-tauri-drag-region` 이 눌리면 웹뷰는 `startDragging()` 을 부르는데, 그 명령은
 * `core:default` 에 **들어 있지 않다** — `core:window:default` 가 주는 28 개는 전부 읽기
 * 전용(`allow-title`·`allow-is-visible` 류)이다. 그래서 #270 이 OS 타이틀바를 없앤 뒤로
 * 브랜드 바든 헤더든 로그인 화면 띠든 **어느 것도 창을 옮기지 못했다.**
 *
 * 위쪽 블록들이 지키는 것은 "속성이 올바른 자리에 있다" 까지다. 속성이 다 제자리에 있어도
 * 이 한 줄이 없으면 기능은 앱에서 죽어 있고, 그 상태로 테스트는 전부 초록이었다 —
 * ACL 은 런타임에만 걸리므로 렌더링 단언으로는 영원히 보이지 않는다. 그래서 결정을 갖고
 * 있는 파일을 직접 읽는다(`runnerShellScope.test.ts` 와 같은 이유).
 */
describe('#353 드래그 권한', () => {
  it('capabilities 가 core:window:allow-start-dragging 을 준다', () => {
    const caps = JSON.parse(capabilitiesRaw) as { permissions: (string | { identifier: string })[] };
    const names = caps.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
    expect(names).toContain('core:window:allow-start-dragging');
  });

  it('그 권한이 창 손잡이가 붙는 창(main)에 걸려 있다', () => {
    const caps = JSON.parse(capabilitiesRaw) as { windows: string[] };
    // 창 라벨을 따로 적지 않으므로 Tauri 기본값 `main` 이다. 이 목록에서 빠지면 권한을
    // 줘도 그 창에는 닿지 않는다.
    expect(caps.windows).toContain('main');
  });
});

/**
 * 최상단 바 두 개의 **아래 경계가 맞는다**(#359).
 *
 * 브랜드 바와 헤더는 가로로 나란히 붙어 한 줄처럼 보인다. 각자 세로 여백으로 높이를 만들면
 * 실측 48px 대 32px 처럼 어긋나고, 그 어긋남은 창 오른쪽 끝까지 이어져 눈에 띈다. 그래서
 * **같은 높이 상수**를 쓰고 세로 여백으로 높이를 만들지 않는다.
 */
describe('#359 최상단 바 정렬', () => {
  it('두 바가 타이틀바에 가까운 얇은 높이를 쓴다 — 옛 48px 이 아니다', () => {
    // 이 바는 OS 타이틀바를 대신하는 자리다. 브랜드 바의 옛 48px(`h-12`)에 맞추면 위쪽을
    // 낭비하면서 타이틀바처럼 보이지도 않는다. 신호등이 들어갈 높이는 유지한다.
    expect(TOP_BAR_H).toBe('h-9');
    expect(TOP_BAR_H).not.toBe('h-12');
  });

  it('브랜드 바와 헤더가 같은 높이 상수를 쓴다', () => {
    pretendMac();
    renderWorkspace({ sidebarCollapsed: false });

    for (const id of ['sidebar-brand', 'app-header']) {
      expect(screen.getByTestId(id).className).toContain(TOP_BAR_H);
    }
  });

  it('두 바 어디에도 세로 여백으로 높이를 만드는 py- 가 없다', () => {
    pretendMac();
    renderWorkspace({ sidebarCollapsed: false });

    // `py-*` 가 다시 붙으면 높이가 상수와 내용 양쪽에서 정해져 경계가 또 갈린다.
    for (const id of ['sidebar-brand', 'app-header']) {
      expect(screen.getByTestId(id).className).not.toMatch(/\bpy-/);
    }
  });
});

/**
 * 로그인 화면 손잡이 띠는 **원래 타이틀바가 있던 높이까지만** 끈다(#359).
 *
 * 초판은 38px 이었는데 신호등 실측(지름 14px, 중심 y≈12px)이 말하는 띠는 28px 이다. 10px 이
 * 더 크면 그만큼 폼 위 빈 공간이 드래그에 먹혀, 사용자에게는 "끌리는 자리가 타이틀바보다
 * 아래로 내려온다" 로 보인다.
 */
describe('#359 띠 높이', () => {
  it('띠가 타이틀바 높이(28px)를 쓴다', async () => {
    pretendMac();
    render(<App />);
    expect(await screen.findByText('Server URL')).toBeTruthy();

    const strip = document.querySelector('[data-testid="window-drag-strip"]')!;
    expect(strip.className).toContain(MAC_TITLEBAR_H);
    expect(MAC_TITLEBAR_H).toBe('h-[28px]');
  });
});

/**
 * **손잡이 위의 글자는 고를 대상이 아니다**(실측 2026-09-07, 사용자가 화면에서 발견).
 *
 * `sidebar-brand` 는 창을 끄는 손잡이(`data-tauri-drag-region`)인데 안의 `murmur` 는
 * 그냥 텍스트 노드라, 끌면 **창이 움직이는 대신 글자가 선택**됐다. 복사할 값이 아니라
 * 앱 이름이므로 고를 이유가 없다.
 */
describe('창 손잡이 위의 글자', () => {
  it('브랜드 줄의 글자는 드래그로 선택되지 않는다', () => {
    renderWorkspace({ sidebarCollapsed: false });
    expect(screen.getByTestId('sidebar-brand').className).toContain('select-none');
  });
});

/**
 * **사이드바를 여닫는 두 버튼이 같은 모양이다**(실측 2026-09-07).
 *
 * 전에는 접기가 `←`, 펼치기가 `☰` 로 서로 달랐다. 같은 하나를 여닫는 버튼이 다르게
 * 생기면 사람이 둘을 다른 기능으로 읽고, 특히 `←` 는 앱 안에서 이미 **뒤로 가기**가
 * 쓰는 글리프라(같은 헤더에 나란히 있다) 한 줄에서 두 뜻으로 쓰였다.
 */
describe('사이드바 토글 아이콘', () => {
  it('접기 버튼이 화살표가 아니라 패널 아이콘을 쓴다', () => {
    const { container } = renderWorkspace({ sidebarCollapsed: false });
    const collapse = container.querySelector('[aria-label="사이드바 접기"]')!;
    expect(collapse.textContent).not.toContain('←');
    expect(collapse.querySelector('svg')).toBeTruthy();
  });

  /** 그림에 이름을 또 주면 스크린리더가 같은 것을 두 번 읽는다 — 버튼이 이미 말한다. */
  it('아이콘은 접근성 이름을 갖지 않는다', () => {
    const { container } = renderWorkspace({ sidebarCollapsed: false });
    const svg = container.querySelector('[aria-label="사이드바 접기"] svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});

/**
 * **브랜드 줄은 로고 + 글자다**(실측 2026-09-08, 사용자가 화면에서 지적 — "murmur
 * 텍스트가 안 나와").
 *
 * 앞 판(2026-09-07)은 *"레일에 커뮤니티 마크가 서 있으니 앱 이름을 여기서 또 적으면 같은
 * 화면이 두 번 말하는 셈"* 이라며 글자를 뺐다. 틀린 지점은 **레일의 마크가 커뮤니티
 * 이름이지 앱 이름이 아니라는 것**이다 — 글자를 빼자 창 왼쪽 위에 파형만 남았고, 그것이
 * 무엇의 로고인지는 이미 아는 사람만 안다.
 *
 * **이름을 지는 쪽은 글자다.** 로고는 `decorative`(`aria-hidden`)로 물러난다. 둘 다
 * 이름을 내면 스크린리더가 앱 이름을 두 번 읽는다 — 그 수는 `test/logo.test.tsx` 가 센다.
 */
describe('브랜드 줄은 로고와 글자를 함께 둔다', () => {
  it('앱 이름을 글자로 적는다', () => {
    renderWorkspace({ sidebarCollapsed: false });
    const brand = screen.getByTestId('sidebar-brand');
    expect(brand.textContent).toContain('murmur');
  });

  /**
   * **손잡이 위의 글자도 창을 끌어야 한다.** 이 줄은 `data-tauri-drag-region` 이고,
   * 그 위에 얹힌 요소가 속성을 물려받지 않으면 글자를 잡아 끌 때만 창이 안 움직인다 —
   * 사람은 "가끔 안 끌린다"로 만난다. 로고와 글자를 감싼 `span` 이 그 속성을 들어야 한다.
   */
  it('로고와 글자를 감싼 자리도 창 손잡이다', () => {
    renderWorkspace({ sidebarCollapsed: false });
    const brand = screen.getByTestId('sidebar-brand');
    const wrap = brand.querySelector('[data-testid="murmur-logo"]')!.parentElement!;
    expect(wrap.hasAttribute('data-tauri-drag-region')).toBe(true);
  });

  /** 연결 점은 남는다 — `#443` 이 "실측에서 유일하게 맞았던 표시"라 적은 자리다. */
  it('연결 점은 그대로 있다', () => {
    renderWorkspace({ sidebarCollapsed: false });
    expect(screen.getByTestId('connection-dot')).toBeTruthy();
  });
});
