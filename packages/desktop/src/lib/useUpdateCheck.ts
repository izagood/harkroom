import { useEffect, useRef, useState } from 'react';
import { getAppUpdater } from './appUpdater';

/**
 * 업데이트 확인·설치의 **한 곳**. 두 자리가 이것을 쓴다:
 *
 * - `ConnectUpdateBanner` — 로그인 전 화면. 진입 시 한 번만 확인한다(#526).
 * - `UpdateToast` — 앱을 쓰는 중. 주기적으로 확인한다.
 *
 * 왜 훅으로 뽑았나: 두 자리가 각자 확인하고 각자 상태를 두면 **"실패를 어떻게 말하는가"가
 * 두 곳에서 갈린다.** 이 저장소가 업데이트 화면에 세운 규칙(사유를 지어내지 않는다,
 * 확인 실패를 최신과 합치지 않는다)은 화면마다 다시 지켜야 하는 것이 아니라 한 번 정해
 * 두는 것이다. 화면은 그 상태를 **어떻게 보여 줄지만** 정한다 — 실제로 두 화면의 판단이
 * 갈리는 지점이 하나 있고(확인 실패를 띄우는가), 그 갈림이 화면 쪽에 있어야 읽힌다.
 */

/**
 * 주기 확인 간격. 하루 종일 켜 두는 창이라 시작 시 한 번으로는 그 사이에 나온 버전을
 * 다음 재시작까지 모른다. 6시간은 "너무 자주 묻지 않으면서 하루 안에는 안다"의 자리다 —
 * 업데이트는 급한 일이 아니고, GitHub 에 대고 더 자주 물을 이유도 없다.
 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 확인·설치가 만들어 내는 상태. **문자열이 아니라 태그**다 — 문자열이면 "확인 실패"와
 * "최신"이 같은 자리에 섞여 들어가는 것을 타입이 못 막는다(`UpdatesSettings` 와 같은 이유).
 */
export type UpdateStatus =
  /** 아직 아무것도 주장하지 않는다 — 확인 중이거나, 표면이 없어 확인하지 않는다. */
  | { kind: 'idle' }
  | { kind: 'uptodate' }
  | { kind: 'available'; version: string }
  | { kind: 'installing'; version: string }
  /** `message` 는 플러그인이 준 원문이다 — 우리가 해석하지 않는다. */
  | { kind: 'failed'; message: string };

/**
 * 업데이트 표면이 있는 빌드인가. `NotificationSettings.tsx` 의 판정과 같은 형태다.
 *
 * 없는 자리(브라우저 dev·테스트)에서 `check()` 를 부르면 `unavailableUpdater` 가 던지고,
 * 그것을 실패로 다루면 개발 중 화면에 늘 경고가 붙는다 — **고칠 것이 없는 경고는 사람이
 * 곧 무시하고, 그러면 진짜 실패도 함께 무시된다.** 그래서 부르지 않는다.
 */
const hasUpdateSurface = (): boolean => '__TAURI_INTERNALS__' in window;

/** 예외에서 사람에게 보여 줄 한 줄을 뽑는다. 형태를 모르는 값이 올 수 있다. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface UseUpdateCheck {
  status: UpdateStatus;
  /** 사람이 본 그 버전을 설치한다. 성공하면 앱이 다시 뜨므로 돌아오지 않는다. */
  install(version: string): Promise<void>;
}

/**
 * @param intervalMs 주기 확인 간격. **주지 않으면 진입 시 한 번만** 확인한다 —
 *   로그인 전 화면은 오래 머무는 자리가 아니라 주기 확인이 의미 없다.
 */
export function useUpdateCheck({ intervalMs }: { intervalMs?: number } = {}): UseUpdateCheck {
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });
  /**
   * 설치 중에는 주기 확인의 결과로 상태를 덮지 않는다. 덮으면 내려받는 중에 화면이
   * `available` 로 되돌아가 **사람이 Update 를 두 번 누를 수 있게** 된다.
   */
  const installing = useRef(false);

  useEffect(() => {
    if (!hasUpdateSurface()) return;
    // 화면이 사라진 뒤 setState 하지 않는다 — 로그인 성공은 연결 화면을 곧 걷어낸다.
    let alive = true;
    const run = async (): Promise<void> => {
      try {
        const found = await getAppUpdater().check();
        if (!alive || installing.current) return;
        setStatus(found ? { kind: 'available', version: found.version } : { kind: 'uptodate' });
      } catch (err) {
        if (!alive || installing.current) return;
        setStatus({ kind: 'failed', message: describeError(err) });
      }
    };

    void run();
    if (intervalMs === undefined) return () => { alive = false; };
    const timer = setInterval(() => void run(), intervalMs);
    return () => { alive = false; clearInterval(timer); };
  }, [intervalMs]);

  async function install(version: string): Promise<void> {
    installing.current = true;
    setStatus({ kind: 'installing', version });
    try {
      await getAppUpdater().downloadAndInstall();
      // 성공하면 앱이 다시 뜨므로 여기로 돌아오지 않는다. 돌아왔다면 재시작이 일어나지
      // 않은 것이고, 그것은 사람이 알아야 할 이상 상태다 — 조용히 넘기지 않는다.
      installing.current = false;
      setStatus({ kind: 'failed', message: 'the app did not restart after installing' });
    } catch (err) {
      installing.current = false;
      setStatus({ kind: 'failed', message: describeError(err) });
    }
  }

  return { status, install };
}
