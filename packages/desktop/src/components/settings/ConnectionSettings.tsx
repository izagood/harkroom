import { useState } from 'react';
import { useActiveStore } from '../../state/communities';
import { getController } from '../../state/controller';
import { usePrefsStore } from '../../state/prefsStore';
import { ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';

export function ConnectionSettings({ onSignOut }: { onSignOut(): void }) {
  const connected = useActiveStore((s) => s.connected);
  const runnerAutoStart = usePrefsStore((s) => s.runnerAutoStart);
  const setRunnerAutoStart = usePrefsStore((s) => s.setRunnerAutoStart);
  const runnerRepoPath = usePrefsStore((s) => s.runnerRepoPath);
  const setRunnerRepoPath = usePrefsStore((s) => s.setRunnerRepoPath);
  const runnerCommand = usePrefsStore((s) => s.runnerCommand);
  const setRunnerCommand = usePrefsStore((s) => s.setRunnerCommand);
  // 입력 중인 값과 저장된 값을 나눈다 — 타이핑 도중의 `/opt/homeb` 를 거절 문구로 덮으면
  // 사람은 글자를 하나도 넣을 수 없다. 거절은 저장 시점에만 말한다.
  const [commandDraft, setCommandDraft] = useState(runnerCommand);
  const [commandError, setCommandError] = useState<string | null>(null);
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
        {/* 저장소 경로만 설정에서 받는다 — **명령 자체는 받지 않는다.** 사람이 편집할 수
            있는 명령은 곧 Tauri shell 스코프를 와일드카드로 열어야 한다는 뜻이고, 그것이
            임의 명령 실행 표면이 된다(runnerLauncher.ts::RUNNER_SCOPE_NAME 주석). */}
        <div className="px-4 py-3">
          <label className="block font-medium text-fg" htmlFor="runner-repo-path">
            murmur repository path
          </label>
          <span className="mt-0.5 block text-fg-subtle">
            Runners start with <code className="font-mono">pnpm --filter @murmur/agent start</code>
            {' '}in this directory. Leave empty to not start any.
          </span>
          <input
            id="runner-repo-path"
            className="mt-2 w-full rounded border border-border bg-field px-2 py-1 font-mono text-xs"
            placeholder="/Users/me/dev/murmur"
            value={runnerRepoPath}
            onChange={(e) => setRunnerRepoPath(e.target.value)}
          />
        </div>
        {/* #305: Dock/Finder 로 띄운 앱은 로그인 셸의 `PATH` 를 물려받지 않아 `pnpm` 을 못
            찾는다(docs/operations.md §8-1 의 같은 함정). 앱이 먼저 로그인 셸의 `PATH` 를
            한 번 읽어 쓰고, 그것이 안 되는 기기에서 **사람이 고치는 길**이 이 칸이다.
            **`pnpm` 실행 파일의 절대 경로만** 받는다 — 명령 전체를 받으면 그것이 임의 실행
            표면이고, 인자는 앱이 고정한다(runnerLauncher.ts::validateRunnerCommand). */}
        <div className="px-4 py-3">
          <label className="block font-medium text-fg" htmlFor="runner-command">
            pnpm path (optional)
          </label>
          <span className="mt-0.5 block text-fg-subtle">
            Absolute path to the <code className="font-mono">pnpm</code> executable, used when the
            app cannot read your login shell&apos;s PATH. Must end with
            {' '}<code className="font-mono">/pnpm</code>. Arguments are fixed by the app.
          </span>
          <input
            id="runner-command"
            className="mt-2 w-full rounded border border-border bg-field px-2 py-1 font-mono text-xs"
            placeholder="/opt/homebrew/bin/pnpm"
            value={commandDraft}
            onChange={(e) => { setCommandDraft(e.target.value); setCommandError(null); }}
            onBlur={() => setCommandError(setRunnerCommand(commandDraft))}
          />
          {commandError && (
            <span className="mt-1 block text-danger" role="alert">{commandError}</span>
          )}
        </div>
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
