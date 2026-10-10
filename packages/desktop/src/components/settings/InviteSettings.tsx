import { useEffect, useMemo, useState } from 'react';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { useT } from '../../i18n/useT';
import { DirectoryRow } from '../Directory';
import { hasCapability } from '../../lib/capabilities';
import { SettingsColumns, SettingsGrid, SettingsGroup, SettingsPage } from './primitives';

/**
 * 설정 › 워크스페이스 › **멤버와 초대**(UX ⑥b-5, designer 사양 ⑥: "Invite + Directory 의 사람 목록").
 *
 * 전에는 초대 토큰만 있었고, 이 커뮤니티에 **누가 이미 있는지**는 Directory 오버레이를 따로 열어야
 * 보였다 — 사람을 부르기 전에 볼 것과 부르는 버튼이 다른 화면에 있었다.
 *
 * - 멤버 목록은 **모두가 본다.** `GET /accounts` 는 `requireAccount` 이고 Directory 도 모두에게 열려
 *   있으므로 새로 드러나는 것이 없다. 줄은 `DirectoryRow` 를 그대로 쓴다(비활성·낡은 presence 규칙이
 *   한 곳에 산다).
 * - 초대 토큰 발급은 **admin 만** 한다. 전에는 admin 이 아니면 페이지 전체가 닫혔는데, 이제는
 *   초대 묶음만 그 사실을 말하고 목록은 그대로 보인다(워크스페이스 묶음의 "읽기 전용", ⑥b-1).
 * - 에이전트는 여기 안 그린다 — 에이전트 › 목록이 그 자리다.
 *
 * `SectionId` 는 `'invite'` 그대로 둔다. 바깥 배선(`onOpenSettings('invite')`)과 저장된 위치가 그 값을
 * 들고 있고, 사람이 읽는 것은 id 가 아니라 `settings.nav.invite` 의 이름이다.
 */
export function InviteSettings() {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const accounts = useActiveStore((s) => s.accounts);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Directory 와 같은 세 갈래 — 둘이면 "아직 안 왔다" 가 "아무도 없다" 로 보인다.
  const [load, setLoad] = useState<{ kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoad({ kind: 'loading' });
    // force: 5초 스로틀에 걸린 호출은 묻지도 않고 resolve 된다(Directory 의 같은 자리).
    getController().refreshAccounts({ force: true }).then(
      () => { if (alive) setLoad({ kind: 'ready' }); },
      (err: unknown) => { if (alive) setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { alive = false; };
  }, [attempt]);

  const people = useMemo(
    () => Object.values(accounts).filter((a) => a.kind === 'human').sort((a, b) => a.handle.localeCompare(b.handle)),
    [accounts],
  );

  const createInvite = async () => {
    setError(null);
    setToken(null);
    setBusy(true);
    try {
      const newToken = await getController().createInvite();
      setToken(newToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('invite.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage section="invite" description={t('members.note')} layout="list">
      {/* 사람 격자가 주 칸, 초대 발급이 곁 칸(시안 v1 「멤버와 초대」). 900 미만에서는 사람 → 초대 순으로 쌓인다. */}
      <SettingsColumns
        testId="members-columns"
        main={(
          <>
            {/* 숫자는 **아는 때만** 단다 — 처음 열 때 store 가 비어 있으면 "멤버 (0)" 이 "불러오는 중" 과
                함께 섰다가 바뀐다. 0 은 "아무도 없다" 로 읽힌다(designer #1034). 실패하고 비었을 때도 같다. */}
            <SettingsGroup title={people.length === 0 && load.kind !== 'ready'
              ? t('members.list.heading')
              : t('members.list.title', { count: String(people.length) })}>
              <div className="px-2 py-2" data-testid="members-list">
                {/* 실패는 목록 위에 남긴다 — 실패를 빈 목록으로 삼키면 "아무도 없다" 로 읽힌다. */}
                {load.kind === 'error' && (
                  <div role="alert" className="mb-2 rounded-row border border-danger-border bg-danger-surface p-2 text-danger">
                    {t('directory.listFailed', { reason: load.message })}
                    <button
                      onClick={() => setAttempt((n) => n + 1)}
                      className="ml-2 rounded-row bg-danger px-2 py-0.5 text-fg-on-strong hover:bg-danger-hover"
                    >
                      {t('directory.retry')}
                    </button>
                  </div>
                )}
                {people.length === 0
                  ? <p className="px-2 py-1 text-fg-subtle">{load.kind === 'loading' ? t('directory.loading') : t('members.list.empty')}</p>
                  : <SettingsGrid as="ul" className="gap-y-0">{people.map((a) => <DirectoryRow key={a.id} account={a} showKind={false} />)}</SettingsGrid>}
              </div>
            </SettingsGroup>
          </>
        )}
        side={(
          <>
            <SettingsGroup title={t('members.invite.title')}>
              <div className="px-4 py-3" data-testid="members-invite">
                {/* 서버 `POST /invites` 는 `requireCap('member.invite')` 다 — admin 이 아니어도 그 능력을 받았으면 발급한다(UX ⑦b-2). */}
                {!hasCapability(me, 'member.invite') ? (
                  <p className="text-fg-subtle">{t('invite.notAdmin')}</p>
                ) : (
                  <>
                    <p className="mb-3 text-fg-subtle">{t('invite.note')}</p>

                    {token && (
                      <div className="mb-4 rounded-row border border-warning-border bg-warning-surface p-3">
                        {/* 크기를 안 적어 본문단 13px 을 물려받는다 — "지금 안 적으면 다시 못 본다"는
                            **놓치면 되돌릴 수 없는** 문장이다. 아래 토큰 자체는 등폭 11px 이라 이 경고와
                            값이 두 단으로 갈린다. */}
                        <div className="font-semibold text-warning">
                          {t('invite.tokenWarning')}
                        </div>
                        <code className="mt-1 block break-all rounded-row bg-surface-raised p-2 text-meta">{token}</code>
                        <div className="mt-2 text-meta text-warning">
                          {t('invite.tokenNextStep')}
                        </div>
                      </div>
                    )}

                    {error && (
                      <div className="mb-4 rounded-row border border-danger-border bg-danger-surface p-3">
                        <p className="text-meta text-danger">{error}</p>
                      </div>
                    )}

                    <button
                      className="rounded-row bg-accent px-4 py-2 font-medium text-fg-on-strong disabled:opacity-50"
                      // 토큰이 하나 나왔다고 버튼을 잠그지 않는다 — 초대는 여러 사람에게 하는 일이고,
                      // 토큰은 한 번 쓰면 소진되므로 두 번째 사람에게는 새 토큰이 필요하다. 다시 누르면
                      // 앞 토큰은 화면에서 사라지므로(다시 볼 수 없다) 그 사실을 라벨로 알린다.
                      disabled={busy}
                      onClick={() => void createInvite()}
                    >
                      {busy ? t('invite.busy') : token ? t('invite.createAgain') : t('invite.create')}
                    </button>
                  </>
                )}
              </div>
            </SettingsGroup>
          </>
        )}
      />
    </SettingsPage>
  );
}
