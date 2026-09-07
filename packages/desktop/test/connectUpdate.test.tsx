// 로그인 **전** 화면에서 앱을 업데이트할 수 있는지의 회귀선.
//
// ## 왜 이 배너가 있어야 하는가 (실측 2026-09-07)
//
// 설치본 0.1.7 은 평문 http 서버에 붙지 못했다(macOS ATS). 고친 버전은 이미 릴리즈에
// 있었지만 **업데이트 UI 가 로그인 뒤 Settings 에만** 있었다. 그래서:
//
//   서버에 못 붙는다 → 업데이트해야 한다 → 업데이트는 로그인 뒤에 있다 → 못 붙는다
//
// 빠져나갈 길이 없는 고리였다. 업데이터는 GitHub releases 만 보고 murmur 서버와 무관하므로
// (`appUpdater.ts` 에 `baseUrl`·`token` 참조가 없다) 로그인 뒤에만 있어야 할 이유도 없었다.
//
// ## 이 파일이 잡는 두 가지
//
// 1. 배너가 로그인 화면에 **있다**.
// 2. 배너가 **거짓말하지 않는다** — "확인 실패"를 "최신"으로 합치지 않는다. 이것이 더
//    미끄러운 쪽이다: 최신일 때 아무것도 안 보이는 화면에서 실패도 숨기면, 두 상태가
//    화면상 구분되지 않아 `UpdatesSettings` 가 세운 규칙이 배치만으로 깨진다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectUpdateBanner } from '../src/components/ConnectUpdateBanner';
import { ConnectScreen } from '../src/screens/ConnectScreen';
import { setAppUpdater, type AppUpdater } from '../src/lib/appUpdater';

/** 업데이트 표면이 있는 빌드(= 실제 데스크탑 앱)를 흉내낸다. */
function withSurface(): void {
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
}

afterEach(() => {
  cleanup();
  setAppUpdater(null);
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

describe('ConnectUpdateBanner — 있을 때만 나타난다', () => {
  it('최신이면 아무것도 렌더하지 않는다', async () => {
    withSurface();
    const updater = stub({ check: vi.fn(async () => null) });
    setAppUpdater(updater);

    const { container } = render(<ConnectUpdateBanner />);

    await waitFor(() => expect(updater.check).toHaveBeenCalled());
    // 최신은 **자리 자체가 없다** — 로그인 화면이 평소와 똑같이 보여야 한다.
    expect(container.textContent).toBe('');
  });

  it('업데이트가 있으면 버전과 Update 버튼을 보여준다', async () => {
    withSurface();
    setAppUpdater(stub({ check: vi.fn(async () => ({ version: '0.1.10' })) }));

    render(<ConnectUpdateBanner />);

    // 버전은 플러그인이 준 문자열을 그대로 적는다 — 우리가 다시 만들지 않는다.
    expect(await screen.findByText(/0\.1\.10/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
  });

  it('Update 를 누르면 설치를 부른다', async () => {
    withSurface();
    const updater = stub({ check: vi.fn(async () => ({ version: '0.1.10' })) });
    setAppUpdater(updater);

    render(<ConnectUpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => expect(updater.downloadAndInstall).toHaveBeenCalled());
  });

  /**
   * **이 파일의 핵심.** 확인이 실패하면 화면이 그렇게 적어야 한다.
   *
   * 사유는 지어내지 않는다 — 네트워크인지 서명인지 릴리즈 JSON 인지 우리는 모르고,
   * 플러그인도 그 구분을 주지 않는다. 그래서 원문을 그대로 붙인다.
   */
  it('확인이 실패하면 실패를 적고 원문을 붙인다', async () => {
    withSurface();
    setAppUpdater(stub({
      check: vi.fn(async () => { throw new Error('Could not fetch a valid release JSON'); }),
    }));

    render(<ConnectUpdateBanner />);

    expect(await screen.findByText(/Could not check for updates/i)).toBeTruthy();
    expect(screen.getByText(/Could not fetch a valid release JSON/)).toBeTruthy();
  });

  /**
   * **대조군.** 위 테스트만 있으면 "실패도 조용히 넘기는" 구현으로는 통과하지 못하지만,
   * 반대 방향의 거짓말은 못 잡는다 — 실패를 "최신입니다"로 적는 것. 그것이 이 화면이
   * 저지를 수 있는 가장 나쁜 거짓말이라 따로 못박는다.
   */
  it('확인 실패를 최신이라고 적지 않는다 (대조군)', async () => {
    withSurface();
    setAppUpdater(stub({
      check: vi.fn(async () => { throw new Error('network is unreachable'); }),
    }));

    render(<ConnectUpdateBanner />);

    await screen.findByText(/Could not check for updates/i);
    expect(document.body.textContent).not.toMatch(/up to date/i);
    expect(document.body.textContent).not.toMatch(/latest/i);
  });

  /**
   * **대조군.** 업데이트 표면이 없는 빌드(브라우저 dev·테스트)에서는 배너가 없어야 한다.
   * `check()` 를 부르면 `unavailableUpdater` 가 던지고, 그것을 실패로 적으면 브라우저
   * 개발 중 로그인 화면에 늘 경고가 붙는다 — 고칠 것이 없는 경고는 사람이 곧 무시한다.
   */
  it('업데이트 표면이 없는 빌드에서는 렌더도 확인도 없다 (대조군)', async () => {
    // withSurface() 를 부르지 않는다 — `__TAURI_INTERNALS__` 가 없는 상태다.
    const updater = stub();
    setAppUpdater(updater);

    const { container } = render(<ConnectUpdateBanner />);

    expect(container.textContent).toBe('');
    expect(updater.check).not.toHaveBeenCalled();
  });
});

describe('ConnectScreen 에 실제로 붙어 있다', () => {
  it('로그인 화면이 배너를 그린다', async () => {
    withSurface();
    setAppUpdater(stub({ check: vi.fn(async () => ({ version: '0.1.10' })) }));

    render(<ConnectScreen onConnected={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Update' })).toBeTruthy();
  });

  /**
   * `add` 모드는 **이미 들어와 있는 사람**이 겹창에서 다른 커뮤니티에 붙는 자리다.
   * 그 사람에게는 Settings 가 열려 있으므로 이 배너가 푸는 고리가 없다 — 겹창 안에
   * 업데이트 안내를 겹쳐 놓을 이유가 없다.
   */
  it('add 모드(겹창)에서는 배너를 그리지 않는다', async () => {
    withSurface();
    const updater = stub({ check: vi.fn(async () => ({ version: '0.1.10' })) });
    setAppUpdater(updater);

    render(<ConnectScreen mode="add" onAdded={vi.fn()} onCancel={vi.fn()} />);

    // 폼은 그려졌다(대조군 — 화면 자체가 빈 것이 아니다).
    expect(screen.getByLabelText('Server URL')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
  });
});
