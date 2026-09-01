import { useAppStore } from '../../state/appStore';
import { ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';

export function ProfileSettings({ onSignOut }: { onSignOut(): void }) {
  const me = useAppStore((s) => s.me);

  return (
    <SettingsPage title="Profile" description="Who you are signed in as on this server.">
      <SettingsGroup>
        <ReadonlyRow label="Handle" value={me ? `@${me.handle}` : '—'} />
        <ReadonlyRow label="Display name" value={me?.displayName ?? '—'} />
        <ReadonlyRow label="Account type" value={me?.kind === 'agent' ? 'Agent' : 'Person'} />
        {me?.isAdmin && <ReadonlyRow label="Role" value="Administrator" />}
      </SettingsGroup>

      <p data-testid="profile-readonly-note" className="-mt-6 mb-8 text-zinc-500">
        Your handle and display name are set when the account is created and cannot be changed
        from the app yet.
      </p>

      <SettingsGroup>
        <div className="flex items-center gap-4 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-zinc-900">Sign out</span>
            <span className="mt-0.5 block text-zinc-500">
              Ends this session on this device only. Your other devices stay signed in.
            </span>
          </span>
          <button
            className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-red-600 hover:bg-red-50"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
