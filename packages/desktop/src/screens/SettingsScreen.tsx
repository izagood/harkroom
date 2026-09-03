import { useState } from 'react';
import { AgentsSettings } from '../components/settings/AgentsSettings';
import { AppearanceSettings } from '../components/settings/AppearanceSettings';
import { CommunitySettings } from '../components/settings/CommunitySettings';
import { ConnectionSettings } from '../components/settings/ConnectionSettings';
import { HandleGroupsSettings } from '../components/settings/HandleGroupsSettings';
import { InviteSettings } from '../components/settings/InviteSettings';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { MessageSettings } from '../components/settings/MessageSettings';
import { ProfileSettings } from '../components/settings/ProfileSettings';
import { TeamsSettings } from '../components/settings/TeamsSettings';
import { UpdatesSettings } from '../components/settings/UpdatesSettings';
import { SETTINGS_GROUPS, type SectionId } from '../components/settings/sections';
import { useActiveStore } from '../state/communities';

export function SettingsScreen({ initialSection = 'profile', targetId, onBack, onSignOut, onCommunitiesEmpty }: {
  initialSection?: SectionId;
  targetId?: string;
  onBack(): void;
  onSignOut(): void;
  /**
   * 마지막 커뮤니티를 뺐다(#165) — `App` 이 `phase` 를 `connect` 로 돌린다. **옵셔널이
   * 아니다**: 기본값을 여기서 공급하면 배선을 잊은 화면에서 그 버튼이 눌러도 아무 일이
   * 없는 항목이 된다(docs/design.md §4).
   */
  onCommunitiesEmpty(): void;
}) {
  const [section, setSection] = useState<SectionId>(initialSection);
  const me = useActiveStore((s) => s.me);

  return (
    <div className="flex h-screen bg-surface-sunken text-sm">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
        <button
          className="flex items-center gap-2 px-4 py-4 text-left font-medium text-fg-muted hover:text-fg"
          onClick={onBack}
        >
          <span aria-hidden>←</span> Back to app
        </button>

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {SETTINGS_GROUPS.map((g) => (
            <div key={g.title} className="mb-4">
              <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-fg-subtle">{g.title}</div>
              {g.items.map((item) => (
                <button
                  key={item.id}
                  className={`flex w-full items-center rounded-lg px-2 py-1.5 text-left
                    ${section === item.id ? 'bg-surface-hover font-medium text-fg' : 'text-fg-muted hover:bg-surface-sunken'}`}
                  aria-current={section === item.id ? 'page' : undefined}
                  onClick={() => setSection(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="border-t border-border px-4 py-3 text-[11px] text-fg-subtle">
          {me ? `@${me.handle} · ` : ''}v{__APP_VERSION__}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {section === 'profile' && <ProfileSettings onSignOut={onSignOut} />}
        {section === 'notifications' && <NotificationSettings />}
        {section === 'messages' && <MessageSettings />}
        {section === 'appearance' && <AppearanceSettings />}
        {section === 'connection' && <ConnectionSettings onSignOut={onSignOut} />}
        {section === 'communities' && <CommunitySettings onCommunitiesEmpty={onCommunitiesEmpty} />}
        {/* AgentsSettings 는 자체 2단 레이아웃이라 SettingsPage 여백을 쓰지 않는다. */}
        {section === 'agents' && <AgentsSettings targetId={targetId} />}
        {section === 'teams' && <TeamsSettings />}
        {section === 'handle-groups' && <HandleGroupsSettings />}
        {section === 'invite' && <InviteSettings />}
        {section === 'updates' && <UpdatesSettings />}
      </main>
    </div>
  );
}
