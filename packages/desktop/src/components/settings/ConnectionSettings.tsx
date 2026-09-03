import { useAppStore } from '../../state/appStore';
import { getController } from '../../state/controller';
import { usePrefsStore } from '../../state/prefsStore';
import { ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';

export function ConnectionSettings({ onSignOut }: { onSignOut(): void }) {
  const connected = useAppStore((s) => s.connected);
  const runnerAutoStart = usePrefsStore((s) => s.runnerAutoStart);
  const setRunnerAutoStart = usePrefsStore((s) => s.setRunnerAutoStart);
  const runnerRepoPath = usePrefsStore((s) => s.runnerRepoPath);
  const setRunnerRepoPath = usePrefsStore((s) => s.setRunnerRepoPath);
  // 보관된 값이 아니라 **지금 붙어 있는** 주소를 보여준다. 키체인 읽기가 비동기가 되면서
  // 렌더 중에 읽을 수 없게 됐고, 어차피 사용자가 알고 싶은 것은 실제 연결 대상이다.
  const baseUrl = getController().api.baseUrl || '—';

  return (
    <SettingsPage title="Connection" description="The murmur server this app talks to.">
      <SettingsGroup>
        <ReadonlyRow label="Server" value={baseUrl} />
        <ReadonlyRow
          label="Realtime connection"
          value={
            <span className="inline-flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
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
            <span className="block font-medium text-zinc-900">Auto-start runners</span>
            <span className="mt-0.5 block text-zinc-500">
              Launch runners for agents you own when the app starts.
            </span>
          </span>
          <button
            className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              runnerAutoStart ? 'bg-blue-600' : 'bg-zinc-300'
            }`}
            onClick={() => setRunnerAutoStart(!runnerAutoStart)}
            role="switch"
            aria-checked={runnerAutoStart}
            aria-label="러너 자동 기동"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                runnerAutoStart ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        {/* 저장소 경로만 설정에서 받는다 — **명령 자체는 받지 않는다.** 사람이 편집할 수
            있는 명령은 곧 Tauri shell 스코프를 와일드카드로 열어야 한다는 뜻이고, 그것이
            임의 명령 실행 표면이 된다(runnerLauncher.ts::RUNNER_SCOPE_NAME 주석). */}
        <div className="px-4 py-3">
          <label className="block font-medium text-zinc-900" htmlFor="runner-repo-path">
            murmur repository path
          </label>
          <span className="mt-0.5 block text-zinc-500">
            Runners start with <code className="font-mono">pnpm --filter @murmur/agent start</code>
            {' '}in this directory. Leave empty to not start any.
          </span>
          <input
            id="runner-repo-path"
            className="mt-2 w-full rounded border border-zinc-300 px-2 py-1 font-mono text-xs"
            placeholder="/Users/me/dev/murmur"
            value={runnerRepoPath}
            onChange={(e) => setRunnerRepoPath(e.target.value)}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup>
        <div className="flex items-center gap-4 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-zinc-900">Use a different server</span>
            <span className="mt-0.5 block text-zinc-500">
              Sign out to enter another server address.
            </span>
          </span>
          <button
            className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 font-medium hover:bg-zinc-50"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
