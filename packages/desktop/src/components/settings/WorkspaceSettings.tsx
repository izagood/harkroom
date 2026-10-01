import { useCallback } from 'react';
import { useActiveStore } from '../../state/communities';
import { getController } from '../../state/controller';
import { AVATAR_ACCEPT, AVATAR_FORMATS } from '../../lib/avatar';
import { SettingsGroup, SettingsPage } from './primitives';
import { useT } from '../../i18n/useT';
import { AvatarStatus, useAvatarEdit } from './avatarEdit';

/**
 * 워크스페이스 설정 — 지금은 커뮤니티 레일에 걸리는 **아이콘** 하나다(2026-09-29).
 *
 * 올리기·지우기의 단계와 문장은 프로필 사진(`ProfileSettings` 의 `AvatarRow`)과 같은
 * `useAvatarEdit` 한 벌을 쓴다 — 서버도 같은 판정(`detectAvatarType`)을 하므로 받아 주는
 * 형식과 거절 문장이 같다. 두 화면이 단계를 따로 세면 한쪽만 고쳐진다.
 *
 * 바꾸기는 owner/admin 만이다(서버 `requireAdmin`). 멤버에게는 버튼 대신 그 사실을 말한다 —
 * 눌러서 403 을 받게 두면 아무 잘못도 없는 사람 화면에 붉은 글이 뜬다(`AgentDefaultsSettings`).
 */
export function WorkspaceSettings() {
  const t = useT();
  const isAdmin = useActiveStore((s) => s.me?.isAdmin === true);
  const iconUrl = useActiveStore((s) => s.workspaceIconUrl);
  const apply = useCallback(
    (file: File | null, onProgress?: (f: number) => void) => getController().setWorkspaceIcon(file, onProgress),
    [],
  );
  const edit = useAvatarEdit(apply);

  return (
    <SettingsPage section="workspace" description={t('workspaceIcon.description')}>
      <SettingsGroup>
        <div className="px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="font-medium text-fg">{t('workspaceIcon.label')}</span>
            <span className="ml-auto flex items-center gap-3">
              <span
                data-testid="workspace-icon-preview"
                className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-surface-raised text-meta text-fg-subtle"
              >
                {iconUrl ? <img src={iconUrl} alt="" className="h-full w-full object-cover" /> : '—'}
              </span>
              {isAdmin && (
                <>
                  <input
                    ref={edit.pickRef}
                    type="file"
                    data-testid="workspace-icon-file"
                    accept={AVATAR_ACCEPT}
                    className="hidden"
                    onChange={edit.onPicked}
                  />
                  <button
                    className="rounded-lg border border-border px-3 py-1.5 font-medium text-fg hover:bg-surface disabled:opacity-50"
                    disabled={edit.busy}
                    onClick={edit.openPicker}
                  >
                    Upload
                  </button>
                  {iconUrl && (edit.confirmingRemove ? (
                    <>
                      <button
                        className="rounded-lg border border-danger-border bg-danger-surface px-3 py-1.5 font-medium text-danger hover:bg-danger-surface-strong disabled:opacity-50"
                        disabled={edit.busy}
                        onClick={edit.confirmRemove}
                      >
                        {t('profileAvatar.removeConfirm')}
                      </button>
                      <button
                        className="rounded-lg border border-border px-3 py-1.5 font-medium text-fg-muted hover:bg-surface"
                        onClick={edit.cancelRemove}
                      >
                        {t('profileAvatar.removeCancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      className="rounded-lg border border-border px-3 py-1.5 font-medium text-danger hover:bg-danger-surface disabled:opacity-50"
                      disabled={edit.busy}
                      onClick={edit.askRemove}
                    >
                      Remove
                    </button>
                  ))}
                </>
              )}
            </span>
          </div>
          {isAdmin
            ? <p className="mt-1 text-meta text-fg-subtle">{AVATAR_FORMATS}</p>
            : <p data-testid="workspace-icon-admin-only" className="mt-1 text-meta text-fg-subtle">{t('workspaceIcon.adminOnly')}</p>}
          <div className="flex justify-end">
            <AvatarStatus phase={edit.phase} />
          </div>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
