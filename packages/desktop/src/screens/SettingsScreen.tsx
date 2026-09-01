import { useState } from 'react';
import { AgentsSettings } from '../components/settings/AgentsSettings';
import { ConnectionSettings } from '../components/settings/ConnectionSettings';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { ProfileSettings } from '../components/settings/ProfileSettings';
import { UpdatesSettings } from '../components/settings/UpdatesSettings';
import { SETTINGS_GROUPS, type SectionId } from '../components/settings/sections';
import { useAppStore } from '../state/appStore';

export function SettingsScreen({ initialSection = 'profile', onBack, onSignOut }: {
  initialSection?: SectionId;
  onBack(): void;
  onSignOut(): void;
}) {
  const [section, setSection] = useState<SectionId>(initialSection);
  const me = useAppStore((s) => s.me);

  return (
    <div className="flex h-screen bg-zinc-100 text-sm">
      <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50">
        <button
          className="flex items-center gap-2 px-4 py-4 text-left font-medium text-zinc-700 hover:text-zinc-900"
          onClick={onBack}
        >
          <span aria-hidden>←</span> Back to app
        </button>

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {SETTINGS_GROUPS.map((g) => (
            <div key={g.title} className="mb-4">
              <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-zinc-500">{g.title}</div>
              {g.items.map((item) => (
                <button
                  key={item.id}
                  className={`flex w-full items-center rounded-lg px-2 py-1.5 text-left
                    ${section === item.id ? 'bg-zinc-200/70 font-medium text-zinc-900' : 'text-zinc-700 hover:bg-zinc-200/40'}`}
                  aria-current={section === item.id ? 'page' : undefined}
                  onClick={() => setSection(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="border-t border-zinc-200 px-4 py-3 text-[11px] text-zinc-500">
          {me ? `@${me.handle} · ` : ''}v{__APP_VERSION__}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {section === 'profile' && <ProfileSettings onSignOut={onSignOut} />}
        {section === 'notifications' && <NotificationSettings />}
        {section === 'connection' && <ConnectionSettings onSignOut={onSignOut} />}
        {/* AgentsSettings 는 자체 2단 레이아웃이라 SettingsPage 여백을 쓰지 않는다. */}
        {section === 'agents' && <AgentsSettings />}
        {section === 'updates' && <UpdatesSettings />}
      </main>
    </div>
  );
}
