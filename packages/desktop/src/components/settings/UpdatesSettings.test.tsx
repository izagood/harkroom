import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UpdatesSettings } from './UpdatesSettings';
import { setAppUpdater, type AppUpdater } from '../../lib/appUpdater';

/**
 * 업데이트 화면의 회귀선.
 *
 * ## 왜 "못 한다고 적지 않는다"만으로는 부족한가
 *
 * 이 화면은 기능이 없을 때 **정직하게** "murmur cannot update itself yet" 이라고 적고
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
    expect(screen.getByRole('button', { name: /download and install/i })).toBeTruthy();
  });

  it('설치 버튼이 실제로 내려받기·설치를 부른다', async () => {
    const downloadAndInstall = vi.fn(async () => {});
    setAppUpdater(stub({
      check: vi.fn(async () => ({ version: '9.9.9' })),
      downloadAndInstall,
    }));
    render(<UpdatesSettings />);
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => screen.getByRole('button', { name: /download and install/i }));
    fireEvent.click(screen.getByRole('button', { name: /download and install/i }));

    await waitFor(() => expect(downloadAndInstall).toHaveBeenCalled());
  });

  it('설치가 실패하면 실패라고 적는다', async () => {
    setAppUpdater(stub({
      check: vi.fn(async () => ({ version: '9.9.9' })),
      downloadAndInstall: vi.fn(async () => { throw new Error('signature mismatch'); }),
    }));
    render(<UpdatesSettings />);
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => screen.getByRole('button', { name: /download and install/i }));
    fireEvent.click(screen.getByRole('button', { name: /download and install/i }));

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
 * (`packages/daemon/src/runners.ts` 의 `detached: true`), daemon 자신도 `setsid` 로
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
