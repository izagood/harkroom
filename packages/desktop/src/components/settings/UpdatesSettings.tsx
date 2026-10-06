import { useUpdateCheck } from '../../lib/useUpdateCheck';
import { useT } from '../../i18n/useT';
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
/**
 * **사이드바와 같은 답을 읽는다**(UX ③ H4). 전에는 이 화면이 제 상태를 따로 뒀다 — 사이드바가
 * 이미 "0.3.63 이 있다" 고 말하는 순간에도 여기는 "이번 세션에 아직 확인하지 않았다" 였다.
 * 이제 `useUpdateCheck` 의 공용 답을 읽고, "아직 확인 안 함" 은 **정말 한 번도 답을 못 받았을
 * 때만** 쓴다. [지금 확인] 은 같은 물음에 합류한다(두 자리가 동시에 물어도 한 번만 묻는다).
 */
function checkedLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function UpdatesSettings() {
  const t = useT();
  const { status, checkedAt, checking, recheckFailure, check, install } = useUpdateCheck();
  const busy = checking || status.kind === 'installing';

  let newVersion: string;
  if (status.kind === 'available') {
    newVersion = `${status.version} · checked ${checkedLabel(checkedAt ?? Date.now())}`;
    // 새 버전을 안 뒤의 확인이 실패했으면 그것도 적는다 — "checked" 시각이 왜 멈췄는지 사람이 안다.
    if (recheckFailure) newVersion += ` · re-check failed ${checkedLabel(recheckFailure.at)}: ${recheckFailure.message}`;
  }
  else if (status.kind === 'installing') newVersion = `${status.version} · downloading and installing…`;
  else if (status.kind === 'uptodate') newVersion = `None — up to date · checked ${checkedLabel(checkedAt ?? Date.now())}`;
  // 실패는 실패라고 적는다. 원문을 붙여 사람이 원인을 직접 볼 수 있게 한다.
  else if (status.kind === 'failed') newVersion = `Could not complete: ${status.message}`;
  else newVersion = checking ? 'Checking…' : 'Not checked yet';

  return (
    <SettingsPage section="updates" description={t('settings.desc.updates')}>
      <SettingsGroup>
        {/* 순서가 사양이다(UX ③): 지금 버전 → 새 버전(확인 시각) → 설치. 사이드바 칸의
            "0.3.59 → 0.3.63" 을 세로로 편 모양이다. */}
        <ReadonlyRow label="Current version" value={__APP_VERSION__} />
        <ReadonlyRow label="New version" value={<span role="status" data-testid="updates-new-version">{newVersion}</span>} />
        <div className="flex items-center justify-end gap-2 px-4 py-3">
          {/* [Check now] 는 새 버전을 안 뒤에도 남긴다 — 0.3.184 를 받아 둔 사이 0.3.185 가 나왔을 수
              있다. 다시 물어 더 새 판이 있으면 표시와 [Restart to install] 이 그 판을 가리킨다
              (`appUpdater` 가 설치할 핸들을 마지막 확인의 것으로 바꾼다). */}
          <Button disabled={busy} onClick={() => void check()}>
            {checking ? 'Checking…' : 'Check now'}
          </Button>
          {(status.kind === 'available' || status.kind === 'installing') && (
            <Button variant="primary" disabled={busy} onClick={() => void install(status.version)}>
              {status.kind === 'installing' ? 'Installing…' : 'Restart to install'}
            </Button>
          )}
        </div>
      </SettingsGroup>

      {/*
        재시작이 무엇을 건드리고 무엇을 안 건드리는지.

        **에이전트 문장은 유지한다** — 실측으로 여전히 참이고, `#431` 이후 오히려
        더 강해졌다. 러너는 앱이 아니라 daemon 이 소유하고(`packages/operator/src/runners.ts`),
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
        Installing an update restarts harkroom. That does not disturb your agents: they are owned
        by a background daemon that outlives the app, and harkroom re-attaches to it on launch.
        Unsent drafts are kept across a restart; which thread you had open is not.
      </p>
    </SettingsPage>
  );
}
