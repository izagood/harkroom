import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UpdatesSettings } from './UpdatesSettings';
import { setAppUpdater, type AppUpdater } from '../../lib/appUpdater';
import { usePrefsStore } from '../../state/prefsStore';

/**
 * 업데이트 화면의 회귀선.
 *
 * ## 왜 "못 한다고 적지 않는다"만으로는 부족한가
 *
 * 이 화면은 기능이 없을 때 **정직하게** "harkroom cannot update itself yet" 이라고 적고
 * 있었다. 기능을 넣으면서 그 문구를 안 고치면 그때부터 화면이 거짓말을 한다 — 이
 * 저장소가 `#443`·`#476` 에서 반복해 겪은 실패다.
 *
 * 그런데 그것만 재면 **"그 절을 통째로 지웠다"로도 통과한다.** 그래서 아래 마지막
 * describe 가 **대조군**이다: 지금도 유효한 안내(재시작이 러너를 건드리지 않는다)가
 * 여전히 있는지 함께 잰다. 둘이 짝이어야 "고쳤다"와 "지웠다"가 갈린다.
 */

afterEach(() => {
  cleanup();
  setAppUpdater(null);
});

/** 테스트가 갈아끼우는 업데이트 표면. */
function stub(over: Partial<AppUpdater> = {}): AppUpdater {
  return {
    check: vi.fn(async () => null),
    downloadAndInstall: vi.fn(async () => {}),
    ...over,
  };
}

describe('UpdatesSettings — 기능이 생겼으므로 못 한다고 말하지 않는다', () => {
  it('"cannot update itself" 문구가 없다', () => {
    setAppUpdater(stub());
    render(<UpdatesSettings />);
    expect(document.body.textContent).not.toMatch(/cannot update itself/i);
    // "Not available" 도 같은 거짓말이다 — 이제 available 하다.
    expect(document.body.textContent).not.toMatch(/Not available/i);
  });

  it('업데이트를 확인하는 버튼이 있다', () => {
    setAppUpdater(stub());
    render(<UpdatesSettings />);
    expect(screen.getByRole('button', { name: /check now/i })).toBeTruthy();
  });
});

describe('UpdatesSettings — 사유를 지어내지 않는다', () => {
  /**
   * **가장 나쁜 거짓말**: 확인이 실패했는데 "최신입니다"라고 적는 것. 사람은 업데이트가
   * 필요 없다고 믿고 옛 버전에 머문다.
   */
  it('확인이 실패하면 실패라고 적는다 — 최신이라고 하지 않는다', async () => {
    setAppUpdater(stub({
      check: vi.fn(async () => { throw new Error('network unreachable'); }),
    }));
    render(<UpdatesSettings />);
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/could not complete/i);
    });
    // 플러그인이 준 원문을 그대로 보여 준다 — 우리가 원인을 해석하지 않는다.
    expect(screen.getByRole('status').textContent).toContain('network unreachable');
    // 원문은 아랫줄에 따로 선다 — 처음부터 실패한 경우도 다시 묻기 실패와 같은 모양이다.
    expect(screen.getByTestId('updates-failure').textContent).toBe('network unreachable');
    expect(screen.getByRole('status').textContent).not.toMatch(/up to date/i);
  });

  it('최신이면 최신이라고 적는다', async () => {
    setAppUpdater(stub({ check: vi.fn(async () => null) }));
    render(<UpdatesSettings />);
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/up to date/i);
    });
  });
});

describe('UpdatesSettings — 확인 → 설치 흐름', () => {
  it('새 버전을 찾으면 버전과 설치 버튼을 보여 준다', async () => {
    setAppUpdater(stub({ check: vi.fn(async () => ({ version: '9.9.9' })) }));
    render(<UpdatesSettings />);
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('9.9.9');
    });
    expect(screen.getByRole('button', { name: /restart to install/i })).toBeTruthy();
  });

  it('설치 버튼이 실제로 내려받기·설치를 부른다', async () => {
    const downloadAndInstall = vi.fn(async () => {});
    setAppUpdater(stub({
      check: vi.fn(async () => ({ version: '9.9.9' })),
      downloadAndInstall,
    }));
    render(<UpdatesSettings />);
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => screen.getByRole('button', { name: /restart to install/i }));
    fireEvent.click(screen.getByRole('button', { name: /restart to install/i }));

    await waitFor(() => expect(downloadAndInstall).toHaveBeenCalled());
  });

  it('설치가 실패하면 실패라고 적는다', async () => {
    setAppUpdater(stub({
      check: vi.fn(async () => ({ version: '9.9.9' })),
      downloadAndInstall: vi.fn(async () => { throw new Error('signature mismatch'); }),
    }));
    render(<UpdatesSettings />);
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => screen.getByRole('button', { name: /restart to install/i }));
    fireEvent.click(screen.getByRole('button', { name: /restart to install/i }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('signature mismatch');
    });
  });
});

/**
 * ## 대조군 — "그 절을 통째로 지웠다"를 걸러 낸다
 *
 * 위 describe 들은 "못 한다는 문구가 없다"를 잰다. 그것만 있으면 안내 문단을 **삭제**해도
 * 통과한다. 지금도 유효한 안내가 남아 있는지 여기서 함께 잰다.
 *
 * 이 문장이 여전히 참이라는 근거는 코드에 있다: 러너는 앱이 아니라 daemon 이 소유하고
 * (`packages/operator/src/runners.ts` 의 `detached: true`), daemon 자신도 `setsid` 로
 * 앱과 다른 프로세스 그룹에 있다(`src-tauri/src/main.rs` 의 `detached_command`).
 * 앱에는 종료 시 러너를 죽이는 경로가 없고, 다시 뜰 때 살아 있는 daemon 에 다시 붙는다
 * (`daemon_client.rs` 의 `ensure_daemon`).
 */
describe('UpdatesSettings — 유효한 안내는 남아 있다(대조군)', () => {
  it('재시작이 에이전트를 건드리지 않는다는 안내가 있다', () => {
    setAppUpdater(stub());
    render(<UpdatesSettings />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/agents/i);
    expect(text).toMatch(/daemon/i);
    expect(text).toMatch(/restart/i);
  });

  /**
   * `#184` 이후 초안은 `localStorage` 에 저장되고 기동 때 다시 읽힌다
   * (`lib/prefs.ts` 의 `draftsStorage`, `state/controller.ts` 의 `hydrateDrafts`).
   * 지워지는 시점은 재시작이 아니라 **로그아웃**이다. 그러므로 "초안이 보존되지
   * 않는다"고 적으면 안 된다 — 사람이 그것을 믿고 업데이트를 미룬다.
   */
  it('초안이 보존된다고 적는다 — 날아간다고 적지 않는다', () => {
    setAppUpdater(stub());
    render(<UpdatesSettings />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/drafts are kept/i);
    expect(text).not.toMatch(/drafts and open threads are not preserved/i);
  });

  it('버전 표시는 유지된다', () => {
    setAppUpdater(stub());
    render(<UpdatesSettings />);
    expect(screen.getByText(__APP_VERSION__)).toBeTruthy();
  });
});

/**
 * **사이드바와 같은 답**(UX ③ H4). 사이드바 칸이 이미 "9.9.9 가 있다" 고 들었으면, 이
 * 화면은 [지금 확인] 을 누르기 전에도 그것을 보여 준다 — "아직 확인 안 함" 이라고 하지 않는다.
 * 전에는 둘이 따로 물어 같은 순간 서로 다른 말을 했다.
 */
describe('UpdatesSettings — 사이드바와 같은 답을 읽는다', () => {
  it('다른 자리가 이미 받은 답을 누르지 않아도 보여 준다', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    try {
      setAppUpdater(stub({ check: vi.fn(async () => ({ version: '9.9.9' })) }));
      const { UpdateToast } = await import('../UpdateToast');
      render(<UpdateToast placement="footer" />);
      await screen.findByTestId('update-footer');

      render(<UpdatesSettings />);
      expect(screen.getByTestId('updates-new-version').textContent).toContain('9.9.9');
      expect(screen.getByTestId('updates-new-version').textContent).not.toMatch(/not checked/i);
      expect(screen.getAllByRole('button', { name: /restart to install/i }).length).toBeGreaterThan(0);
    } finally {
      delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});

/**
 * **받아 둔 뒤에도 다시 묻는다**(#task 스레드 b77286c1). 0.3.184 를 찾아 [Restart to install] 이
 * 선 뒤에는 [Check now] 가 사라져서, 그 사이 0.3.185 가 나와도 화면에서 다시 물을 길이 없었다.
 */
describe('UpdatesSettings — 새 버전을 안 뒤에도 다시 확인한다', () => {
  it('설치 버튼과 함께 [Check now] 가 있고, 다시 물으면 더 새 판으로 바뀐다', async () => {
    const check = vi.fn()
      .mockResolvedValueOnce({ version: '9.9.9' })
      .mockResolvedValueOnce({ version: '9.9.10' });
    setAppUpdater(stub({ check }));
    render(<UpdatesSettings />);
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => screen.getByRole('button', { name: /restart to install/i }));

    // 받아 둔 상태에서도 다시 물을 수 있다.
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => expect(screen.getByTestId('updates-new-version').textContent).toContain('9.9.10'));
    expect(check).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /restart to install/i })).toBeTruthy();
  });

  it('[Restart to install] 은 지금 표시된 판을 설치한다', async () => {
    const downloadAndInstall = vi.fn(async () => {});
    const check = vi.fn()
      .mockResolvedValueOnce({ version: '9.9.9' })
      .mockResolvedValueOnce({ version: '9.9.10' });
    setAppUpdater(stub({ check, downloadAndInstall }));
    render(<UpdatesSettings />);
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => screen.getByRole('button', { name: /restart to install/i }));
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => expect(screen.getByTestId('updates-new-version').textContent).toContain('9.9.10'));

    fireEvent.click(screen.getByRole('button', { name: /restart to install/i }));
    await waitFor(() => expect(screen.getByTestId('updates-new-version').textContent).toMatch(/9\.9\.10 · downloading/));
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it('"checked" 시각은 마지막으로 답을 받은 시각이다', async () => {
    const first = new Date(2026, 9, 6, 7, 14).getTime();
    const later = new Date(2026, 9, 6, 13, 20).getTime();
    const now = vi.spyOn(Date, 'now').mockReturnValue(first);
    try {
      setAppUpdater(stub({ check: vi.fn(async () => ({ version: '9.9.9' })) }));
      render(<UpdatesSettings />);
      fireEvent.click(screen.getByRole('button', { name: /check now/i }));
      await waitFor(() => expect(screen.getByTestId('updates-new-version').textContent).toContain(new Date(first).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })));

      now.mockReturnValue(later);
      fireEvent.click(screen.getByRole('button', { name: /check now/i }));
      const label = new Date(later).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
      await waitFor(() => expect(screen.getByTestId('updates-new-version').textContent).toContain(`checked ${label}`));
    } finally {
      now.mockRestore();
    }
  });

  /**
   * 다시 물었다가 실패해도 앞에서 찾은 새 판과 설치 버튼을 지우지 않는다 — 전에는 주기 확인이
   * 한 번 실패하는 것만으로 설치 버튼이 사라졌다. 실패는 곁에 원문 그대로 적는다(사유를 지어내지 않는다).
   */
  it('다시 묻기가 실패하면 받아 둔 판은 남고 실패를 곁에 적는다', async () => {
    const check = vi.fn()
      .mockResolvedValueOnce({ version: '9.9.9' })
      .mockRejectedValueOnce(new Error('network unreachable'));
    setAppUpdater(stub({ check }));
    render(<UpdatesSettings />);
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => screen.getByRole('button', { name: /restart to install/i }));

    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => expect(screen.getByTestId('updates-new-version').textContent).toContain('network unreachable'));
    expect(screen.getByTestId('updates-new-version').textContent).toContain('9.9.9');
    // 원문은 말줄임되는 첫 줄이 아니라 아랫줄에 따로 선다(designer, #1173).
    expect(screen.getByTestId('updates-failure').textContent).toMatch(/^Re-check failed .*network unreachable$/);
    expect(screen.getByRole('button', { name: /restart to install/i })).toBeTruthy();
  });
});

/**
 * **주기 확인이 잠든 사이 밀리지 않는다.** `setInterval` 은 노트북이 잠들거나 창이 가려지면
 * 미뤄진다. 창이 다시 포커스를 얻을 때 마지막 물음이 한 주기보다 오래됐으면 그 자리에서 묻는다.
 */
describe('useUpdateCheck — 창이 돌아오면 밀린 주기를 따라잡는다', () => {
  it('한 주기 안이면 묻지 않고, 지났으면 묻는다 — 받아 둔 상태에서도', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const check = vi.fn(async () => ({ version: '9.9.9' }));
      setAppUpdater(stub({ check }));
      const { UpdateToast } = await import('../UpdateToast');
      const { UPDATE_CHECK_INTERVAL_MS } = await import('../../lib/useUpdateCheck');
      render(<UpdateToast placement="footer" />);
      await screen.findByTestId('update-footer');
      expect(check).toHaveBeenCalledTimes(1);

      now.mockReturnValue(t0 + 60_000);
      window.dispatchEvent(new Event('focus'));
      expect(check).toHaveBeenCalledTimes(1);

      now.mockReturnValue(t0 + UPDATE_CHECK_INTERVAL_MS + 1);
      window.dispatchEvent(new Event('focus'));
      await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    } finally {
      now.mockRestore();
      delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});

/**
 * 화면 글이 **한 언어로** 선다 — 제목·부제는 한국어인데 칸 이름·버튼·곁 문단은 영어로 박혀 있던
 * 섞임(jaebin 보고, 2026-10-10)의 회귀선. 시각도 OS 가 아니라 **앱 언어**를 따른다.
 */
describe('UpdatesSettings — 앱 언어를 따른다', () => {
  afterEach(() => usePrefsStore.getState().setLocale('system'));

  it('한국어로 고르면 칸 이름·버튼·곁 문단·시각이 모두 한국어다', async () => {
    usePrefsStore.getState().setLocale('ko');
    const at = new Date(2026, 9, 6, 21, 7).getTime();
    const now = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      setAppUpdater(stub({ check: vi.fn(async () => null) }));
      render(<UpdatesSettings />);
      expect(screen.getByText('지금 버전')).toBeTruthy();
      expect(screen.getByText('새 버전')).toBeTruthy();
      expect(document.body.textContent).toContain('업데이트를 설치하면 harkroom 이 다시 시작한다');
      fireEvent.click(screen.getByRole('button', { name: '지금 확인' }));
      const label = new Date(at).toLocaleTimeString('ko', { hour: '2-digit', minute: '2-digit' });
      await waitFor(() => expect(screen.getByTestId('updates-new-version').textContent).toBe(`없음 — 최신 버전 · ${label} 확인`));
      expect(document.body.textContent).not.toMatch(/Current version|Check now|up to date|Installing an update/);
    } finally {
      now.mockRestore();
    }
  });

  it('설치 뒤 다시 뜨지 않은 실패도 고른 언어로 적는다 — 박힌 영어 원문이 섞이지 않는다', async () => {
    usePrefsStore.getState().setLocale('ko');
    setAppUpdater(stub({ check: vi.fn(async () => ({ version: '9.9.9' })), downloadAndInstall: vi.fn(async () => {}) }));
    render(<UpdatesSettings />);
    fireEvent.click(screen.getByRole('button', { name: '지금 확인' }));
    fireEvent.click(await screen.findByRole('button', { name: '다시 시작해 설치' }));
    await waitFor(() => expect(screen.getByTestId('updates-failure').textContent).toBe('설치한 뒤 앱이 다시 시작되지 않았다'));
    expect(screen.getByRole('status').textContent).toContain('끝내지 못했다');
    expect(document.body.textContent).not.toMatch(/did not restart/i);
  });

  it('영어로 고르면 OS 언어와 상관없이 시각이 영어다 — 「오후」 가 섞이지 않는다', async () => {
    usePrefsStore.getState().setLocale('en');
    const at = new Date(2026, 9, 6, 21, 7).getTime();
    const now = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      setAppUpdater(stub({ check: vi.fn(async () => null) }));
      render(<UpdatesSettings />);
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
      await waitFor(() => expect(screen.getByTestId('updates-new-version').textContent).toMatch(/up to date · checked/));
      expect(screen.getByTestId('updates-new-version').textContent).not.toMatch(/[오전후]/);
    } finally {
      now.mockRestore();
    }
  });
});
