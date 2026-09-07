import { useEffect, useState } from 'react';
import { getAppUpdater } from '../lib/appUpdater';

/**
 * 로그인 **전** 화면의 업데이트 배너.
 *
 * ## 왜 로그인 전에 있어야 하는가 (실측 2026-09-07)
 *
 * 설치본 0.1.7 은 평문 http 서버에 붙지 못했다(macOS ATS 가 요청을 내보내지 않는다).
 * 고친 버전은 이미 릴리즈에 있었지만 업데이트 UI 가 로그인 뒤 Settings 에만 있어서
 * 고리가 닫혀 있었다:
 *
 *   서버에 못 붙는다 → 업데이트해야 한다 → 업데이트는 로그인 뒤에 있다 → 못 붙는다
 *
 * 업데이터는 GitHub releases 만 보고 murmur 서버와 무관하다(`appUpdater.ts` 에
 * `baseUrl`·`token` 참조가 없다). 로그인 뒤에만 있어야 할 이유가 애초에 없었다.
 *
 * ## 이 배너의 규칙: **"확인 실패"를 "최신"으로 합치지 않는다**
 *
 * `UpdatesSettings` 가 세운 규칙을 그대로 물려받는다. 다만 여기서는 그것이 더 미끄럽다:
 * 최신일 때 **아무것도 렌더하지 않는** 화면이므로, 실패도 숨기면 두 상태가 화면상
 * 구분되지 않는다 — 문구를 고치지 않아도 배치만으로 같은 거짓말이 된다. 그래서 실패는
 * 반드시 한 줄 적는다. 로그인 화면이 조금 시끄러워지는 것이 그 대가다.
 *
 * 같은 이유로 사유는 지어내지 않는다. 네트워크인지 서명인지 릴리즈 JSON 인지 우리는
 * 모르고 플러그인도 그 구분을 주지 않으므로, 원문을 그대로 붙인다.
 */

/**
 * 업데이트 표면이 있는 빌드인가. `NotificationSettings.tsx` 의 판정과 같은 형태다.
 *
 * 없는 자리(브라우저 dev·테스트)에서 `check()` 를 부르면 `unavailableUpdater` 가 던지고,
 * 그것을 실패로 적으면 개발 중 로그인 화면에 늘 경고가 붙는다 — **고칠 것이 없는 경고는
 * 사람이 곧 무시하고, 그러면 진짜 실패도 함께 무시된다.** 그래서 부르지 않는다.
 */
const hasUpdateSurface = (): boolean => '__TAURI_INTERNALS__' in window;

/**
 * 배너가 보여 줄 수 있는 상태. **문자열이 아니라 태그**다 — 문자열이면 "확인 실패"와
 * "최신"이 같은 자리에 섞여 들어가는 것을 타입이 못 막는다(`UpdatesSettings` 와 같은 이유).
 */
type Status =
  /** 확인 중이거나, 표면이 없어 확인조차 하지 않는다. 둘 다 아무것도 주장하지 않는다. */
  | { kind: 'idle' }
  | { kind: 'uptodate' }
  | { kind: 'available'; version: string }
  | { kind: 'installing'; version: string }
  /** `message` 는 플러그인이 준 원문이다 — 우리가 해석하지 않는다. */
  | { kind: 'failed'; message: string };

/** 예외에서 사람에게 보여 줄 한 줄을 뽑는다. 형태를 모르는 값이 올 수 있다. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function ConnectUpdateBanner() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    if (!hasUpdateSurface()) return;
    // 화면이 사라진 뒤 setState 하지 않는다 — 로그인 성공은 이 화면을 곧 걷어낸다.
    let alive = true;
    void (async () => {
      try {
        const found = await getAppUpdater().check();
        if (!alive) return;
        setStatus(found ? { kind: 'available', version: found.version } : { kind: 'uptodate' });
      } catch (err) {
        if (!alive) return;
        setStatus({ kind: 'failed', message: describe(err) });
      }
    })();
    return () => { alive = false; };
  }, []);

  async function install(version: string) {
    setStatus({ kind: 'installing', version });
    try {
      await getAppUpdater().downloadAndInstall();
      // 성공하면 앱이 다시 뜨므로 여기로 돌아오지 않는다. 돌아왔다면 재시작이 일어나지
      // 않은 것이고, 그것은 사람이 알아야 할 이상 상태다 — 조용히 넘기지 않는다.
      setStatus({ kind: 'failed', message: 'the app did not restart after installing' });
    } catch (err) {
      setStatus({ kind: 'failed', message: describe(err) });
    }
  }

  // 최신과 확인 전에는 자리 자체가 없다 — 로그인 화면이 평소와 똑같이 보인다.
  if (status.kind === 'idle' || status.kind === 'uptodate') return null;

  if (status.kind === 'failed') {
    return (
      <div className="rounded border border-warning-border bg-warning-surface px-3 py-2">
        {/* 빨강(danger)을 쓰지 않는다 — 그 색은 이 화면에서 이미 로그인 실패가 쓴다.
            같은 색이면 '서버 문제'와 '업데이트 확인 문제'가 한 화면에서 구분되지 않는다. */}
        <p className="text-xs font-medium text-warning">Could not check for updates</p>
        <p className="truncate font-mono text-[10px] text-fg-muted" title={status.message}>
          {status.message}
        </p>
      </div>
    );
  }

  const installing = status.kind === 'installing';
  return (
    <div className="flex items-center gap-2 rounded border border-accent-brand bg-accent-surface px-3 py-2">
      <p className="min-w-0 flex-1 truncate text-xs text-fg">
        {installing ? `Installing v${status.version}…` : `v${status.version} available`}
      </p>
      <button
        type="button"
        disabled={installing}
        onClick={() => void install(status.version)}
        className="rounded bg-accent px-2 py-1 text-xs font-semibold text-fg-on-strong disabled:bg-transparent disabled:text-fg-subtle"
      >
        Update
      </button>
    </div>
  );
}
