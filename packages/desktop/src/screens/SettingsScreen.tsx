import { useState } from 'react';
import { AgentsSettings } from '../components/settings/AgentsSettings';
import { ClaudeAccountsSettings } from '../components/settings/ClaudeAccountsSettings';
import { AgentDefaultsSettings } from '../components/settings/AgentDefaultsSettings';
import { GallerySettings } from '../components/settings/GallerySettings';
import { AppearanceSettings } from '../components/settings/AppearanceSettings';
import { CommunitySettings } from '../components/settings/CommunitySettings';
import { ConnectionSettings } from '../components/settings/ConnectionSettings';
import { HandleGroupsSettings } from '../components/settings/HandleGroupsSettings';
import { InviteSettings } from '../components/settings/InviteSettings';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { MessageSettings } from '../components/settings/MessageSettings';
import { ProfileSettings } from '../components/settings/ProfileSettings';
import { SkillsSettings } from '../components/settings/SkillsSettings';
import { UpdatesSettings } from '../components/settings/UpdatesSettings';
import { DEFAULT_SECTION, SETTINGS_GROUPS, isSectionId, type SectionId } from '../components/settings/sections';
import { useActiveStore } from '../state/communities';
import { WindowDragStrip } from '../components/WindowDragStrip';

export function SettingsScreen({ initialSection = DEFAULT_SECTION, targetId, onBack, onSignOut, onCommunitiesEmpty }: {
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
  /**
   * **빈 화면은 답이 아니다.** 목차에 없는 값이 들어오면 아래 분기가 전부 거짓이 되어
   * 본문이 통째로 빈다 — 사용자는 "설정이 안 열린다" 로 겪는다(실측 2026-09-07: 투영
   * 띠가 섹션 자리에 `MouseEvent` 를 흘렸다). 부르는 쪽을 고치는 것으로는 **다음** 배선
   * 실수를 막지 못하므로, 이 화면이 모르는 섹션을 기본 섹션으로 되돌린다.
   */
  const [section, setSection] = useState<SectionId>(
    isSectionId(initialSection) ? initialSection : DEFAULT_SECTION,
  );
  const me = useActiveStore((s) => s.me);

  return (
    /* #342: 설정도 `Workspace` 를 **대체해서** 그려진다(겹창이 아니다) — 그래서 여기 있는
       동안에도 창 손잡이가 필요하다. 안쪽 `← Back to app` 은 버튼이라 띠와 겹치지 않는다. */
    /* 글자 크기는 `Workspace` 와 **같은 본문단 13px** 이다(그 파일에 근거를 적어 뒀다).
       설정은 `Workspace` 를 대체해서 그려지므로 이 한 줄이 설정 화면 전체의 기본값이고,
       아래 섹션들이 본문 자리에 크기를 다시 적지 않아도 되는 근거다. */
    <div className="flex h-screen flex-col bg-surface-sunken text-body">
      <WindowDragStrip />
      <div className="flex min-h-0 flex-1">
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
                <div className="px-2 pb-1 text-meta uppercase tracking-wide text-fg-subtle">{g.title}</div>
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

          <div className="border-t border-border px-4 py-3 text-meta text-fg-subtle">
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
          {section === 'claude-accounts' && <ClaudeAccountsSettings />}
          {section === 'agent-defaults' && <AgentDefaultsSettings />}
          {section === 'handle-groups' && <HandleGroupsSettings />}
          {section === 'invite' && <InviteSettings />}
          {section === 'updates' && <UpdatesSettings />}
          {section === 'skills' && <SkillsSettings targetId={targetId} />}
          {section === 'gallery' && <GallerySettings />}
        </main>
      </div>
    </div>
  );
}
