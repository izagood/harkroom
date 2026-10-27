import { Fragment, useEffect, useMemo, useState } from 'react';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { useT } from '../../i18n/useT';
import { DirectoryRow } from '../Directory';
import { hasCapability } from '../../lib/capabilities';
import { SettingsColumns, SettingsGrid, SettingsGroup, SettingsPage } from './primitives';
import { MemberAccessPanel } from './MemberAccessPanel';
import { errorText } from '../../lib/errorText';
import { canIssueResetCode, loginIdsSupported, ResetCodeButton, resetSupported } from '../PasswordReset';
import { InviteMailPanel, inviteMailSupported, TokenInvite } from './InviteMail';

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
 * - **줄을 누르면 곁 칸이 그 사람의 역할·권한 칸이 된다**(designer 시안 B, 스레드 d5e5c5d4). 줄마다 역할 칩이 선다.
 *   좁은 폭(설정 본문 900 미만)에서는 곁 칸이 목록 아래로 내려가 멀리 떨어지므로, 그때는 **누른 줄 바로 아래**에
 *   펼친다. 두 자리를 다 그리고 container query 로 하나만 보인다 — 폭을 JS 로 재면 그 경계가 `SettingsColumns` 와 갈린다.
 *
 * `SectionId` 는 `'invite'` 그대로 둔다. 바깥 배선(`onOpenSettings('invite')`)과 저장된 위치가 그 값을
 * 들고 있고, 사람이 읽는 것은 id 가 아니라 `settings.nav.invite` 의 이름이다.
 */
export function InviteSettings() {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const accounts = useActiveStore((s) => s.accounts);
  // 재설정 코드(#1409)는 서버 판과 capability 둘 다로 연다 — 옛 서버엔 버튼이 없다(하한을 올리지 않는다).
  const serverVersion = useActiveStore((s) => s.serverVersion?.version ?? null);
  const resetOn = resetSupported(serverVersion);
  /**
   * 사람들의 로그인 ID — 재설정 코드를 발급할 수 있는 관리자에게만(소유자 A안, 10-23). handle 과 다른 사람이 있어
   * (10-22 다른 사용자) 「이 사람 로그인 ID 가 뭐지」를 여기서 답한다. 서버가 권한으로 거르고, 화면은 그 권한이 있을 때만 부른다.
   * 못 받으면(옛 서버 404·실패) 줄을 그리지 않을 뿐이다.
   */
  const loginIdsOn = hasCapability(me, 'member.reset_password') && loginIdsSupported(serverVersion);
  const [loginIds, setLoginIds] = useState<Record<string, string>>({});
  // 초대 메일·보낸 초대 목록(서버 0.4.280~). 옛 서버는 지금 흐름(토큰 한 번 보이기)만 — 하한을 올리지 않는다.
  const mailUi = inviteMailSupported(serverVersion);
  // Directory 와 같은 세 갈래 — 둘이면 "아직 안 왔다" 가 "아무도 없다" 로 보인다.
  const [load, setLoad] = useState<{ kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoad({ kind: 'loading' });
    // force: 5초 스로틀에 걸린 호출은 묻지도 않고 resolve 된다(Directory 의 같은 자리).
    getController().refreshAccounts({ force: true }).then(
      () => { if (alive) setLoad({ kind: 'ready' }); },
      (err: unknown) => { if (alive) setLoad({ kind: 'error', message: errorText(err, t) }); },
    );
    return () => { alive = false; };
  }, [attempt]);

  const people = useMemo(
    () => Object.values(accounts).filter((a) => a.kind === 'human').sort((a, b) => a.handle.localeCompare(b.handle)),
    [accounts],
  );

  // 목록을 다시 읽을 때(다시 시도)·사람이 늘거나 줄 때 함께 다시 읽는다(designer #1490 n2 — 연 채로 새 사람이 가입하면).
  const peopleKey = useMemo(() => people.map((a) => a.id).join(','), [people]);
  useEffect(() => {
    if (!loginIdsOn) { setLoginIds({}); return; }
    let alive = true;
    getController().loginIds().then((m) => { if (alive) setLoginIds(m); }, () => { if (alive) setLoginIds({}); });
    return () => { alive = false; };
  }, [loginIdsOn, attempt, me?.id, peopleKey]);

  // 고른 사람이 목록에서 사라지면(지워짐·다른 커뮤니티로 바뀜) 칸도 접는다.
  const selected = selectedId ? people.find((a) => a.id === selectedId) ?? null : null;
  const panel = (where: 'side' | 'inline') => selected && (
    <MemberAccessPanel key={`${where}-${selected.id}`} person={selected} me={me} onBack={() => setSelectedId(null)} testId={`member-access-${where}`} />
  );

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
                  : <SettingsGrid as="ul" className="gap-y-0">{people.map((a) => <Fragment key={a.id}><DirectoryRow account={a} showKind={false}
                    roleChip
                    selected={a.id === selectedId}
                    onSelect={() => setSelectedId((cur) => (cur === a.id ? null : a.id))}
                    // 로그인 ID 는 「누구인가」라 @handle 바로 뒤에 둔다 — 둘이 다른 것을 한눈에 견준다(designer #1490 n1).
                    // 최대 64자라 좁은 칸에서는 잘리고 title 로 전체를 보인다(s1). 오른쪽 끝에는 버튼만.
                    detail={loginIds[a.id] ? (
                      <span className="flex min-w-0 items-baseline gap-1 text-meta text-fg-subtle" data-testid={`member-login-id-${a.id}`}>
                        <span aria-hidden>·</span>
                        <span className="shrink-0">{t('members.loginId')}</span>
                        <code className="min-w-0 max-w-[10rem] truncate font-mono" title={loginIds[a.id]} data-testid={`member-login-id-value-${a.id}`}>{loginIds[a.id]}</code>
                      </span>
                    ) : null}
                    actions={resetOn && canIssueResetCode(me, a) ? <ResetCodeButton account={a} /> : null} />
                    {a.id === selectedId && (
                      <li className="my-1 rounded-compose border border-border bg-surface-raised @min-[900px]/settings:hidden">{panel('inline')}</li>
                    )}</Fragment>)}</SettingsGrid>}
              </div>
            </SettingsGroup>
          </>
        )}
        side={(
          <>
            {selected && (
              <div className="hidden @min-[900px]/settings:block">
                <SettingsGroup>{panel('side')}</SettingsGroup>
              </div>
            )}
            <div className={selected ? '@min-[900px]/settings:hidden' : ''}>
            {/* 서버 `POST /invites` 는 `requireCap('member.invite')` 다 — admin 이 아니어도 그 능력을 받았으면 발급한다(UX ⑦b-2).
                능력이 없으면 「보낸 초대」 목록도 그리지 않는다 — 받는 사람 주소가 보인다(시안 c5). */}
            {hasCapability(me, 'member.invite') && mailUi
              ? <InviteMailPanel lead={<p className="mb-3 text-fg-subtle">{t('members.panel.pickHint')}</p>} />
              : (
                <SettingsGroup title={t('members.invite.title')}>
                  <div className="px-4 py-3" data-testid="members-invite">
                    {!hasCapability(me, 'member.invite') ? (
                      <p className="text-fg-subtle">{t('invite.notAdmin')}</p>
                    ) : (
                      <>
                        <p className="mb-1 text-fg-subtle">{t('members.panel.pickHint')}</p>
                        <p className="mb-3 text-fg-subtle">{t('invite.note')}</p>
                        <TokenInvite primary />
                      </>
                    )}
                  </div>
                </SettingsGroup>
              )}
            </div>
          </>
        )}
      />
    </SettingsPage>
  );
}
