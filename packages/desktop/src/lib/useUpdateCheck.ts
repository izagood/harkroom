import { useEffect, useState } from 'react';
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
  /**
   * `message` 는 플러그인이 준 원문이다 — 우리가 해석하지 않는다. `reason` 은 **우리가 아는**
   * 실패에만 붙는다 — 그때 화면은 원문 대신 사전의 말을 쓴다(`message` 는 영어 원문으로 남아 로그·
   * 사전이 없는 자리를 위해 둔다).
   */
  | { kind: 'failed'; message: string; reason?: 'notRestarted' };

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
  /** 마지막으로 **답을 받은** 시각(ms). 한 번도 못 받았으면 null — "아직 확인 안 함" 은 이때만이다. */
  checkedAt: number | null;
  /** 지금 묻고 있는가. `status` 와 따로 둔다 — 묻는 동안에도 앞의 답(있다·최신)은 여전히 참이다. */
  checking: boolean;
  /** 이 세션에서 사람이 "나중에" 를 누른 버전. 더 새 버전이 나오면 다시 말한다. */
  dismissedVersion: string | null;
  /**
   * 새 버전을 이미 안 뒤에 **다시 물었다가 실패한** 것. 이때는 `status` 를 `failed` 로 덮지 않는다 —
   * 덮으면 6시간마다 도는 확인이 한 번 실패하는 것만으로 이미 찾은 새 버전과 설치 버튼이 사라진다.
   * 앞의 답("0.3.184 가 있다")은 여전히 참이고, 그 뒤의 확인이 실패했다는 것도 참이다 — 둘 다 보여 준다.
   * 다음 확인이 답을 받으면 지운다.
   */
  recheckFailure: { message: string; at: number } | null;
  check(): Promise<void>;
  install(version: string): Promise<void>;
  dismiss(version: string): void;
}

/**
 * **상태는 앱에 하나다**(UX ③ H4). 전에는 이 훅을 부르는 자리마다 상태를 따로 뒀고,
 * 설정의 Updates 탭은 이 훅도 안 쓰고 제 상태를 또 뒀다 — 그래서 사이드바 알약은
 * "v0.3.63 Update" 인데 같은 순간 Updates 탭은 "이번 세션에 아직 확인하지 않았다" 였다.
 * 같은 질문(새 버전이 있나)에 한 화면이 두 답을 했다.
 *
 * 그래서 답을 모듈에 하나 두고 자리들은 구독만 한다. 누가 물어도 모두가 같은 답을 본다.
 *
 * **표면이 바뀌면 답을 버린다**(`owner`). 답은 그 업데이터가 한 말이다 — 테스트가
 * `setAppUpdater` 로 갈아끼우거나 커뮤니티가 바뀌어 표면이 새로 서면, 앞 표면의 "있다" 를
 * 새 표면의 사실로 들고 가지 않는다.
 */
interface Snapshot {
  status: UpdateStatus;
  checkedAt: number | null;
  checking: boolean;
  dismissedVersion: string | null;
  recheckFailure: { message: string; at: number } | null;
}
const INITIAL: Snapshot = { status: { kind: 'idle' }, checkedAt: null, checking: false, dismissedVersion: null, recheckFailure: null };
let snap: Snapshot = INITIAL;
let owner: ReturnType<typeof getAppUpdater> | null = null;
let inflight: Promise<void> | null = null;
let installing = false;
/** 마지막으로 **물으러 나간** 시각(성공·실패 무관). 창이 돌아왔을 때 주기가 밀렸는지 판정한다. */
let lastAttemptAt: number | null = null;
const listeners = new Set<(s: Snapshot) => void>();

function publish(next: Partial<Snapshot>): void {
  snap = { ...snap, ...next };
  for (const l of listeners) l(snap);
}

/** 지금 표면을 돌려주되, 앞 표면의 답이면 버린다(위 주석). */
function updater(): ReturnType<typeof getAppUpdater> {
  const u = getAppUpdater();
  if (u !== owner) {
    owner = u;
    snap = INITIAL;
    inflight = null;
    installing = false;
    lastAttemptAt = null;
  }
  return u;
}

/** 묻는다. 이미 묻고 있으면 그 물음에 합류한다 — 두 자리가 동시에 열려도 GitHub 에 한 번만 묻는다. */
export function checkForUpdate(): Promise<void> {
  const u = updater();
  if (installing) return Promise.resolve();
  if (inflight) return inflight;
  lastAttemptAt = Date.now();
  publish({ checking: true });
  const run = (async () => {
    try {
      const found = await u.check();
      if (u !== owner || installing) return;
      publish({
        status: found ? { kind: 'available', version: found.version } : { kind: 'uptodate' },
        checkedAt: Date.now(),
        recheckFailure: null,
      });
    } catch (err) {
      if (u !== owner || installing) return;
      const message = describeError(err);
      // 이미 새 버전을 알고 있으면 그 답을 지키고 실패는 곁에 적는다(`recheckFailure` 의 주석).
      if (snap.status.kind === 'available') publish({ recheckFailure: { message, at: Date.now() } });
      else publish({ status: { kind: 'failed', message }, recheckFailure: null });
    } finally {
      if (u === owner) { inflight = null; publish({ checking: false }); }
    }
  })();
  inflight = run;
  return run;
}

async function installUpdate(version: string): Promise<void> {
  const u = updater();
  installing = true;
  publish({ status: { kind: 'installing', version }, recheckFailure: null });
  try {
    await u.downloadAndInstall();
    // 성공하면 앱이 다시 뜨므로 여기로 돌아오지 않는다. 돌아왔다면 재시작이 일어나지
    // 않은 것이고, 그것은 사람이 알아야 할 이상 상태다 — 조용히 넘기지 않는다.
    installing = false;
    publish({ status: { kind: 'failed', message: 'the app did not restart after installing', reason: 'notRestarted' } });
  } catch (err) {
    installing = false;
    publish({ status: { kind: 'failed', message: describeError(err) } });
  }
}

/**
 * 구독한다. 표면이 있고 **아직 아무도 묻지 않았으면** 한 번 묻는다. `intervalMs` 를 주면
 * 그 주기로 다시 묻는다 — 주기는 앱을 쓰는 동안 늘 서 있는 자리(사이드바 알림) 하나만 준다.
 *
 * 주기는 **새 버전을 이미 안 뒤에도 멈추지 않는다** — 0.3.184 를 받아 둔 채 하루를 켜 두면
 * 그 사이 0.3.185 가 나올 수 있고, 다음 답이 표시를 그 버전으로 바꾼다.
 *
 * `setInterval` 만 믿지 않는다: 노트북이 잠들거나 창이 가려지면 WebView 가 타이머를 미루거나
 * 멈춰서, 아침에 창을 열었을 때 "checked" 가 어젯밤 시각에 머문다. 그래서 창이 다시 보이거나
 * 포커스를 얻을 때 마지막 물음이 한 주기보다 오래됐으면 그 자리에서 묻는다.
 */
export function useUpdateCheck({ intervalMs }: { intervalMs?: number } = {}): UseUpdateCheck {
  const [state, setState] = useState<Snapshot>(() => { updater(); return snap; });

  useEffect(() => {
    listeners.add(setState);
    setState(snap);
    return () => { listeners.delete(setState); };
  }, []);

  useEffect(() => {
    if (!hasUpdateSurface()) return;
    if (snap.checkedAt === null && !inflight && snap.status.kind === 'idle') void checkForUpdate();
    if (intervalMs === undefined) return;
    const timer = setInterval(() => void checkForUpdate(), intervalMs);
    const catchUp = () => {
      if (document.visibilityState === 'hidden') return;
      if (lastAttemptAt !== null && Date.now() - lastAttemptAt < intervalMs) return;
      void checkForUpdate();
    };
    window.addEventListener('focus', catchUp);
    document.addEventListener('visibilitychange', catchUp);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', catchUp);
      document.removeEventListener('visibilitychange', catchUp);
    };
  }, [intervalMs]);

  return {
    ...state,
    check: checkForUpdate,
    install: installUpdate,
    dismiss: (version) => publish({ dismissedVersion: version }),
  };
}
