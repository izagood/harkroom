import { ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';

export function UpdatesSettings() {
  return (
    <SettingsPage title="Updates" description="How this app gets to a newer version.">
      <SettingsGroup>
        <ReadonlyRow label="Version" value={__APP_VERSION__} />
        <ReadonlyRow label="Automatic updates" value="Not available" />
      </SettingsGroup>

      <p className="text-zinc-500">
        murmur cannot update itself yet — install a newer build to move versions. Restarting the
        app does not disturb your agents: they run as their own processes and keep working.
        Unsent drafts and open threads are not preserved across a restart.
      </p>
    </SettingsPage>
  );
}
