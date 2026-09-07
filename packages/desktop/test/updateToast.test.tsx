// 앱을 쓰는 **중에** 새 버전이 나온 것을 알 수 있는지의 회귀선.
//
// 로그인 화면의 배너(#526)는 붙기 전의 막다른 길을 풀었다. 이쪽은 다른 문제다: 이 앱은
// 하루 종일 켜 두는 창이라, 시작할 때 한 번 확인하고 끝내면 그 사이에 나온 버전을 **다음
// 재시작까지 모른다.** 그래서 주기적으로 확인하고 우측 하단으로 말한다.
//
// ## 이 파일이 지키는 두 가지
//
// 1. 있을 때 **말한다** — 그리고 사람이 닫으면 이 세션 동안 다시 조르지 않는다.
// 2. 닫은 것이 "그 버전"에 대한 답이라는 것 — 더 새 버전이 나오면 다시 말해야 한다.
//    닫기를 영구 침묵으로 읽으면 그 다음 업데이트가 조용히 사라진다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UpdateToast } from '../src/components/UpdateToast';
import { UPDATE_CHECK_INTERVAL_MS } from '../src/lib/useUpdateCheck';
import { setAppUpdater, type AppUpdater } from '../src/lib/appUpdater';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, fakeApi, msg } from './helpers/fakeApi';

/** 업데이트 표면이 있는 빌드(= 실제 데스크탑 앱)를 흉내낸다. */
function withSurface(): void {
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
}

afterEach(() => {
  cleanup();
  setAppUpdater(null);
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 테스트가 갈아끼우는 업데이트 표면 — `UpdatesSettings.test.tsx` 와 같은 패턴. */
function stub(over: Partial<AppUpdater> = {}): AppUpdater {
  return {
    check: vi.fn(async () => null),
    downloadAndInstall: vi.fn(async () => {}),
    ...over,
  };
}

describe('UpdateToast — 쓰는 중에 새 버전을 말한다', () => {
  it('업데이트가 있으면 버전과 Update 를 보여준다', async () => {
    withSurface();
    setAppUpdater(stub({ check: vi.fn(async () => ({ version: '0.1.12' })) }));

    render(<UpdateToast />);

    expect(await screen.findByText(/0\.1\.12/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
  });

  it('Update 를 누르면 설치를 부른다', async () => {
    withSurface();
    const updater = stub({ check: vi.fn(async () => ({ version: '0.1.12' })) });
    setAppUpdater(updater);

    render(<UpdateToast />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => expect(updater.downloadAndInstall).toHaveBeenCalled());
  });

  it('닫으면 사라진다', async () => {
    withSurface();
    setAppUpdater(stub({ check: vi.fn(async () => ({ version: '0.1.12' })) }));

    render(<UpdateToast />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss update notice' }));

    expect(screen.queryByText(/0\.1\.12/)).toBeNull();
  });

  /**
   * **닫기는 그 버전에 대한 답이다.** 주기 확인이 같은 버전을 다시 찾아도 조르지 않는다 —
   * 그러지 않으면 닫기가 6시간짜리 미루기가 되고, 사람은 하루에 몇 번씩 같은 팝업을 닫는다.
   */
  it('닫은 뒤 같은 버전으로 재확인해도 다시 뜨지 않는다', async () => {
    withSurface();
    vi.useFakeTimers();
    setAppUpdater(stub({ check: vi.fn(async () => ({ version: '0.1.12' })) }));

    render(<UpdateToast />);
    // **`act` 로 감싸야 한다.** 가짜 타이머는 React 스케줄러의 타이머까지 멈추므로,
    // `check()` 가 resolve 돼도 그 setState 가 화면에 반영되지 않는다 — `waitFor` 는
    // 그 상태로 그냥 20초를 기다리다 죽는다(실측). `act` 가 밀린 일을 비운다.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }));

    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS + 1000); });

    expect(screen.queryByText(/0\.1\.12/)).toBeNull();
  });

  /**
   * **그러나 영구 침묵은 아니다.** 더 새 버전이 나오면 다시 말한다 — 닫기를 "이 앱의
   * 업데이트 알림 전체를 끈다"로 읽으면 그 다음 업데이트가 조용히 사라진다.
   */
  it('닫은 뒤 더 새 버전이 나오면 다시 뜬다', async () => {
    withSurface();
    vi.useFakeTimers();
    let version = '0.1.12';
    setAppUpdater(stub({ check: vi.fn(async () => ({ version })) }));

    render(<UpdateToast />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }));

    version = '0.1.13';
    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS + 1000); });

    expect(screen.getByText(/0\.1\.13/)).toBeTruthy();
  });

  /** 대조군 — 최신이면 화면에 아무것도 얹지 않는다. */
  it('최신이면 아무것도 렌더하지 않는다 (대조군)', async () => {
    withSurface();
    const updater = stub({ check: vi.fn(async () => null) });
    setAppUpdater(updater);

    const { container } = render(<UpdateToast />);

    await waitFor(() => expect(updater.check).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  /**
   * 대조군 — **확인 실패는 팝업을 만들지 않는다.**
   *
   * 로그인 화면의 배너와 갈리는 지점이고 의도한 것이다. 그쪽은 "최신"도 안 보이는 화면이라
   * 실패를 숨기면 두 상태가 구분되지 않았다. 여기서는 사람이 이미 앱 안에 있고 Settings 의
   * 업데이트 화면이 확인 실패를 정직하게 말한다. 작업 중에 **고칠 것도 없는** 실패 팝업을
   * 띄우면 그것이 곧 무시되는 알림이 되고, 그 다음부터 진짜 알림도 함께 무시된다.
   */
  it('확인이 실패해도 팝업을 띄우지 않는다 (대조군)', async () => {
    withSurface();
    const updater = stub({
      check: vi.fn(async () => { throw new Error('network is unreachable'); }),
    });
    setAppUpdater(updater);

    const { container } = render(<UpdateToast />);

    await waitFor(() => expect(updater.check).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  /** 대조군 — 표면 없는 빌드(브라우저 dev·테스트)에서는 확인조차 하지 않는다. */
  it('업데이트 표면이 없는 빌드에서는 확인하지 않는다 (대조군)', async () => {
    const updater = stub();
    setAppUpdater(updater);

    const { container } = render(<UpdateToast />);

    expect(container.textContent).toBe('');
    expect(updater.check).not.toHaveBeenCalled();
  });
});

describe('Workspace 에 실제로 붙어 있다', () => {
  afterEach(() => { setController(null as unknown as Controller); });

  /**
   * **배선을 화면으로 잰다.** props 를 손으로 넘겨 컴포넌트만 띄우면 "어디에도 안 붙었다"를
   * 볼 수 없다 — 이 저장소가 `#279`(멘션 클릭)에서 겪은 그대로다.
   */
  it('작업 화면이 팝업을 그린다', async () => {
    withSurface();
    setAppUpdater(stub({ check: vi.fn(async () => ({ version: '0.1.12' })) }));
    // `Workspace` 는 컨트롤러 없이 그려지지 않는다 — 다른 Workspace 테스트와 같은 형태로 세운다.
    setController({
      api: fakeApi(),
      openChannel: vi.fn().mockResolvedValue(undefined),
      openThread: vi.fn(), closeThread: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
      notifyTyping: vi.fn(), refreshAccounts: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(), reply: vi.fn(), loadOlder: vi.fn(),
      goBack: vi.fn().mockResolvedValue(false),
      goForward: vi.fn().mockResolvedValue(false),
    } as unknown as Controller);
    useAppStore.getState().reset();
    useAppStore.getState().set({
      me: acc('u1', 'me', 'human', true),
      accounts: { u1: acc('u1', 'me', 'human', true) },
      channels: [chan('c1', 'general')],
      connected: true,
      activeChannelId: 'c1',
      messages: { c1: [msg('m1', 'c1', 1, 'hello', 'u1')] },
    });

    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Update' })).toBeTruthy();
  });
});
