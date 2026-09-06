import { useState } from 'react';
import { getAppUpdater } from '../../lib/appUpdater';
import { Button, ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';

/**
 * 앱 내부 업데이트 화면.
 *
 * ## 이 화면의 규칙: **사유를 지어내지 않는다**
 *
 * 확인이 실패하면 "실패했다"고만 적는다. 네트워크가 끊겼는지, 릴리즈에 `latest.json` 이
 * 없는지, 서명이 안 맞는지는 **우리가 모른다** — 플러그인은 그 구분을 주지 않는다.
 * 모르는 것을 아는 척 적으면 사람이 엉뚱한 곳을 고치느라 시간을 쓴다. 그래서 원인 대신
 * 플러그인이 준 원문을 그대로 붙인다.
 *
 * 같은 이유로 "최신이다"와 "확인하지 못했다"를 **절대 합치지 않는다.** 확인 실패를
 * "최신입니다"로 보여 주는 것이 이 화면이 저지를 수 있는 가장 나쁜 거짓말이다 —
 * 사람은 업데이트가 필요 없다고 믿고 옛 버전에 머문다.
 */

/**
 * 화면이 사람에게 보여 줄 수 있는 상태. **문자열이 아니라 태그**로 둔다 — 문자열이면
 * "확인 실패"와 "최신"이 같은 자리에 섞여 들어가는 것을 타입이 못 막는다.
 */
type Status =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'uptodate' }
  | { kind: 'available'; version: string }
  | { kind: 'installing' }
  /** 확인·설치가 실패했다. `message` 는 플러그인이 준 원문이다 — 우리가 해석하지 않는다. */
  | { kind: 'failed'; message: string };

/** 예외에서 사람에게 보여 줄 한 줄을 뽑는다. 형태를 모르는 값이 올 수 있다. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function UpdatesSettings() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function check() {
    setStatus({ kind: 'checking' });
    try {
      const found = await getAppUpdater().check();
      setStatus(found ? { kind: 'available', version: found.version } : { kind: 'uptodate' });
    } catch (err) {
      setStatus({ kind: 'failed', message: describe(err) });
    }
  }

  async function install() {
    setStatus({ kind: 'installing' });
    try {
      await getAppUpdater().downloadAndInstall();
      // 성공하면 앱이 다시 뜨므로 여기로 돌아오지 않는다. 돌아왔다면 재시작이 일어나지
      // 않은 것이고, 그것은 사람이 알아야 할 이상 상태다 — 조용히 넘기지 않는다.
      setStatus({ kind: 'failed', message: 'the app did not restart after installing' });
    } catch (err) {
      setStatus({ kind: 'failed', message: describe(err) });
    }
  }

  const busy = status.kind === 'checking' || status.kind === 'installing';

  return (
    <SettingsPage title="Updates" description="How this app gets to a newer version.">
      <SettingsGroup>
        <ReadonlyRow label="Version" value={__APP_VERSION__} />
        <ReadonlyRow label="Automatic updates" value="Available" />
        <div className="flex items-center gap-4 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-fg">Check for updates</span>
            <span className="mt-0.5 block text-fg-subtle" role="status">
              {status.kind === 'idle' && 'murmur has not checked yet in this session.'}
              {status.kind === 'checking' && 'Checking…'}
              {status.kind === 'uptodate' && `murmur is up to date at ${__APP_VERSION__}.`}
              {status.kind === 'available' && `Version ${status.version} is available.`}
              {status.kind === 'installing' && 'Downloading and installing…'}
              {/* 실패는 실패라고 적는다. 원문을 붙여 사람이 원인을 직접 볼 수 있게 한다. */}
              {status.kind === 'failed' && `Could not complete: ${status.message}`}
            </span>
          </span>
          {status.kind === 'available' ? (
            <Button variant="primary" disabled={busy} onClick={() => void install()}>
              {status.kind === 'available' ? 'Download and install' : 'Installing…'}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void check()}>
              {status.kind === 'checking' ? 'Checking…' : 'Check now'}
            </Button>
          )}
        </div>
      </SettingsGroup>

      {/*
        재시작이 무엇을 건드리고 무엇을 안 건드리는지.

        **에이전트 문장은 유지한다** — 실측으로 여전히 참이고, `#431` 이후 오히려
        더 강해졌다. 러너는 앱이 아니라 daemon 이 소유하고(`packages/daemon/src/runners.ts`),
        daemon 자신도 `setsid` 로 앱과 다른 프로세스 그룹에 있다
        (`src-tauri/src/main.rs` 의 `detached_command`). 앱에는 종료 시 러너를 죽이는
        경로가 아예 없고, 다시 뜰 때는 살아 있는 daemon 에 **다시 붙는다**
        (`daemon_client.rs` 의 `ensure_daemon` → `EnsureKind::Attached`).

        **초안 문장은 고쳤다** — 그 자리는 이미 거짓이었다. `#184` 가 초안을 기기 로컬에
        저장하게 했고(`lib/prefs.ts` 의 `draftsStorage`), 앱은 기동 때 그것을 다시
        읽는다(`state/controller.ts` 의 `hydrateDrafts`). 지금 지워지는 시점은 재시작이
        아니라 **로그아웃**이다. 업데이트 기능을 넣으면서 이 줄을 그대로 뒀다면 사람이
        "재시작하면 쓰던 글이 날아간다"고 믿고 업데이트를 미뤘을 것이다.

        열린 스레드는 여전히 복원되지 않는다 — 화면 위치는 세션 한정 인메모리라
        `localStorage` 에 넣지 않는다(`state/appStore.ts`).
      */}
      <p className="text-fg-subtle">
        Installing an update restarts murmur. That does not disturb your agents: they are owned
        by a background daemon that outlives the app, and murmur re-attaches to it on launch.
        Unsent drafts are kept across a restart; which thread you had open is not.
      </p>
    </SettingsPage>
  );
}
