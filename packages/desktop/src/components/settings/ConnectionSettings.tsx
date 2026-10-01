import { useActiveStore } from '../../state/communities';
import { getController } from '../../state/controller';
import { useT } from '../../i18n/useT';
import { ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';

export function ConnectionSettings({ onSignOut }: { onSignOut(): void }) {
  const t = useT();
  const connected = useActiveStore((s) => s.connected);
  // 보관된 값이 아니라 **지금 붙어 있는** 주소를 보여준다. 키체인 읽기가 비동기가 되면서
  // 렌더 중에 읽을 수 없게 됐고, 어차피 사용자가 알고 싶은 것은 실제 연결 대상이다.
  const baseUrl = getController().api.baseUrl || '—';

  return (
    <SettingsPage section="connection" description={t('settings.desc.connection')}>
      <SettingsGroup>
        {/* #165: 이 행은 계속 **활성 커뮤니티**를 보여 준다. 이 기기가 아는 서버 전부를
            보는 자리는 Communities 다 — 여기서 목록을 또 그리면 같은 사실이 두 곳에 산다. */}
        <ReadonlyRow label={t('connection.server')} value={baseUrl} />
        {/* avcs 투영 두 줄(상태·주소)은 설정 › 워크스페이스 › 연동 으로 갔다(UX ⑥b-4). 투영은 이 기기가
            아니라 **워크스페이스 전체**에 걸린다 — 서버가 돌리고, 모든 멤버의 Collab 이 그것을 읽는다. */}
        <ReadonlyRow
          label={t('connection.realtime')}
          value={
            <span className="inline-flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`} />
              <span data-testid="connection-state">{connected ? t('connection.connected') : t('connection.disconnected')}</span>
            </span>
          }
        />
      </SettingsGroup>

      {/* 러너 자동 기동 토글이 여기 있었다(#250). 러너는 이제 오퍼레이터가 서버의 배정을
          받아 띄우므로(스펙 2026-09-20 §2) 앱에 켜고 끌 것이 없다 — 그 자리는 설정의
          Operators 다. */}
      <SettingsGroup>
        {/* #165: 예전 문구는 "Use a different server / Sign out to enter another server
            address." 였다. (A) 아래서 그것은 **거짓 문장**이다 — 서버를 하나 더 붙이는
            것이 지금 쓰는 것을 버리는 일이 아니다. 그 자리를 커뮤니티 목록을 가리키는
            한 줄로 바꾸고, 로그아웃은 로그아웃이라고만 적는다. */}
        <div className="flex items-center gap-4 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-fg">{t('connection.signOutTitle')}</span>
            <span className="mt-0.5 block text-fg-subtle">
              {t('connection.signOutNote')}
            </span>
          </span>
          <button
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-surface"
            onClick={onSignOut}
          >
            {t('profile.signOut')}
          </button>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
