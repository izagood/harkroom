import { sessionStore } from '../../lib/session';
import { useAppStore } from '../../state/appStore';
import { ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';

export function ConnectionSettings({ onSignOut }: { onSignOut(): void }) {
  const connected = useAppStore((s) => s.connected);
  const baseUrl = sessionStore.load()?.baseUrl ?? '—';

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
