import { usePrefsStore } from '../../state/prefsStore';
import { SettingsGroup, SettingsPage, Toggle } from './primitives';

/** Tauri v2 가 주입하는 표식. 브라우저 dev 모드에는 알림 플러그인 자체가 없다. */
const hasNotificationSurface = (): boolean => '__TAURI_INTERNALS__' in window;

export function NotificationSettings() {
  const n = usePrefsStore((s) => s.notifications);
  const set = usePrefsStore((s) => s.setNotifications);

  return (
    <SettingsPage
      title="Notifications"
      description="murmur only notifies you while its window is in the background."
    >
      {!hasNotificationSurface() && (
        <p data-testid="no-notification-surface"
          className="mb-8 rounded-xl border border-warning-border bg-warning-surface px-4 py-3 text-warning">
          This build has no system notification surface, so nothing is delivered here.
          Your choices are still saved and apply once you run the desktop app.
        </p>
      )}

      <SettingsGroup>
        <Toggle
          label="Enable notifications"
          description="Turn this off to stay quiet without losing the choices below."
          checked={n.enabled}
          onChange={(v) => set({ enabled: v })}
        />
      </SettingsGroup>

      <SettingsGroup title="Notify me about">
        <Toggle label="Mentions" description="Someone writes @you in a channel."
          checked={n.mention} disabled={!n.enabled} onChange={(v) => set({ mention: v })} />
        <Toggle label="Thread replies" description="A reply lands in a thread you are part of."
          checked={n.threadReply} disabled={!n.enabled} onChange={(v) => set({ threadReply: v })} />
        <Toggle label="Direct messages" description="Someone messages you directly."
          checked={n.dm} disabled={!n.enabled} onChange={(v) => set({ dm: v })} />
      </SettingsGroup>

      <SettingsGroup title="Content">
        <Toggle
          label="Show message preview"
          description="Off keeps the message text off your lock screen — you still see who wrote it and where."
          checked={n.showPreview} disabled={!n.enabled} onChange={(v) => set({ showPreview: v })}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
