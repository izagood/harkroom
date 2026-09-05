import { useActiveStore } from '../../state/communities';
import { getController } from '../../state/controller';
import { usePrefsStore } from '../../state/prefsStore';
import { ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';

export function ConnectionSettings({ onSignOut }: { onSignOut(): void }) {
  const connected = useActiveStore((s) => s.connected);
  const runnerAutoStart = usePrefsStore((s) => s.runnerAutoStart);
  const setRunnerAutoStart = usePrefsStore((s) => s.setRunnerAutoStart);
  // 보관된 값이 아니라 **지금 붙어 있는** 주소를 보여준다. 키체인 읽기가 비동기가 되면서
  // 렌더 중에 읽을 수 없게 됐고, 어차피 사용자가 알고 싶은 것은 실제 연결 대상이다.
  const baseUrl = getController().api.baseUrl || '—';

  return (
    <SettingsPage title="Connection" description="The murmur server this app talks to.">
      <SettingsGroup>
        {/* #165: 이 행은 계속 **활성 커뮤니티**를 보여 준다. 이 기기가 아는 서버 전부를
            보는 자리는 Communities 다 — 여기서 목록을 또 그리면 같은 사실이 두 곳에 산다. */}
        <ReadonlyRow label="Server" value={baseUrl} />
        <ReadonlyRow
          label="Realtime connection"
          value={
            <span className="inline-flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`} />
              <span data-testid="connection-state">{connected ? 'Connected' : 'Disconnected'}</span>
            </span>
          }
        />
      </SettingsGroup>

      {/* #250: 러너 자동 기동. 이 앱은 **내가 소유한** 에이전트의 러너만 띄우고, 이미
          러너가 붙어 있는 에이전트는 건드리지 않는다. */}
      <SettingsGroup>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-fg">Auto-start runners</span>
            <span className="mt-0.5 block text-fg-subtle">
              Launch runners for agents you own when the app starts.
            </span>
          </span>
          <button
            className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              runnerAutoStart ? 'bg-accent' : 'bg-fg-subtle'
            }`}
            onClick={() => setRunnerAutoStart(!runnerAutoStart)}
            role="switch"
            aria-checked={runnerAutoStart}
            aria-label="러너 자동 기동"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-surface-raised transition-transform ${
                runnerAutoStart ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        {/* 저장소 경로·pnpm 경로 칸은 `#431` 1단계에서 없앴다 — 러너가 Tauri sidecar 로
            바뀌면서 "murmur 소스가 어디 있나"·"pnpm 이 어디 있나"라는 물음 자체가
            사라졌다(sidecar 는 자기 위치를 스스로 알고 pnpm 을 거치지 않는다). 에이전트가
            **일할 저장소**는 에이전트 설정의 `workingDir` 이 맡는다 — 이 화면의 것이 아니다. */}
      </SettingsGroup>

      <SettingsGroup>
        {/* #165: 예전 문구는 "Use a different server / Sign out to enter another server
            address." 였다. (A) 아래서 그것은 **거짓 문장**이다 — 서버를 하나 더 붙이는
            것이 지금 쓰는 것을 버리는 일이 아니다. 그 자리를 커뮤니티 목록을 가리키는
            한 줄로 바꾸고, 로그아웃은 로그아웃이라고만 적는다. */}
        <div className="flex items-center gap-4 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-fg">Sign out of this community</span>
            <span className="mt-0.5 block text-fg-subtle">
              To use another server, add it in Settings › Communities — the switcher appears at the
              left of the sidebar once you are in more than one.
            </span>
          </span>
          <button
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-surface"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
