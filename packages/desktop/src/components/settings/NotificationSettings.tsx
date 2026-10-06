import { usePrefsStore } from '../../state/prefsStore';
import { useT } from '../../i18n/useT';
import { SettingsGroup, SettingsPage, Toggle } from './primitives';

/** Tauri v2 가 주입하는 표식. 브라우저 dev 모드에는 알림 플러그인 자체가 없다. */
const hasNotificationSurface = (): boolean => '__TAURI_INTERNALS__' in window;

export function NotificationSettings() {
  const t = useT();
  const n = usePrefsStore((s) => s.notifications);
  const set = usePrefsStore((s) => s.setNotifications);

  return (
    <SettingsPage
      section="notifications"
      description={t('settings.desc.notifications')}
    >
      {!hasNotificationSurface() && (
        <p data-testid="no-notification-surface"
          className="mb-8 rounded-compose border border-warning-border bg-warning-surface px-4 py-3 text-warning">
          {t('notifications.noSurface')}
        </p>
      )}

      <SettingsGroup>
        <Toggle
          label={t('notifications.enabled')}
          description={t('notifications.enabledNote')}
          checked={n.enabled}
          onChange={(v) => set({ enabled: v })}
        />
      </SettingsGroup>

      <SettingsGroup title={t('notifications.group.about')}>
        <Toggle label={t('notifications.mention')} description={t('notifications.mentionNote')}
          checked={n.mention} disabled={!n.enabled} onChange={(v) => set({ mention: v })} />
        <Toggle label={t('notifications.threadReply')} description={t('notifications.threadReplyNote')}
          checked={n.threadReply} disabled={!n.enabled} onChange={(v) => set({ threadReply: v })} />
        <Toggle label={t('notifications.dm')} description={t('notifications.dmNote')}
          checked={n.dm} disabled={!n.enabled} onChange={(v) => set({ dm: v })} />
      </SettingsGroup>

      <SettingsGroup title={t('notifications.group.content')}>
        <Toggle
          label={t('notifications.preview')}
          description={t('notifications.previewNote')}
          checked={n.showPreview} disabled={!n.enabled} onChange={(v) => set({ showPreview: v })}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
