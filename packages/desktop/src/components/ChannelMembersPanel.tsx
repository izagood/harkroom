import { useEffect, useState } from 'react';
import type { AddTeamToChannelResult, AgentTeamRow, ChannelAutoMentionMode, ChannelRow } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useT } from '../i18n/useT';
import type { Translate } from '../i18n';

/**
 * 멤버 패널의 실패 문구(#344). 서버의 사유는 영문이고 이 패널은 그것을 그대로 띄우고 있었다 —
 * 화면에 영어 한 줄이 뜨면 사람은 그것을 오류 코드로 읽는다.
 *
 * 바꿔 적는 것은 **보관 사유 하나뿐**이다. 나머지는 서버 문구를 그대로 남긴다: 여기서 목록을
 * 만들어 두면 서버가 새 사유를 늘릴 때마다 화면이 조용히 원문으로 되돌아가는 자리가 생긴다.
 *
 * 이 문구가 실제로 뜨는 자리는 **멤버 추가와 내보내기**다. 나가기 경로는 `isSelf` 예외(#344)
 * 이후 보관 게이트를 통과하므로 이 사유를 받지 못한다 — 그래도 같은 함수를 통과시키는 이유는
 * 세 자리가 같은 `memberError` 한 칸에 쓰기 때문이다. 그래서 문구도 "나갈 수 없다"가 아니라
 * 남는 두 조작에 참인 것으로 적는다.
 *
 * **번역기를 인자로 받는다**(i18n 구조 판단 (b) — `i18n/index.ts::Translate` 머리말).
 * 이것은 판정이다: 서버 사유 하나를 알아보고 나머지는 그대로 흘린다. 그 판정을 화면 안에
 * 두면 세 호출자가 각자 같은 `if` 를 적게 되고, 서버가 문구를 바꾸는 날 한 곳만 고쳐진다.
 *
 * `fallback` 은 **키가 아니라 이미 번역된 문자열**을 받는다. 자리마다 다른 말이고
 * (초대 · 내보내기 · 나가기), 호출부가 `t()` 를 이미 손에 들고 있어 여기서 다시
 * 키를 풀 이유가 없다.
 */
const memberErrorText = (err: unknown, fallback: string, t: Translate): string => {
  const msg = err instanceof Error ? err.message : fallback;
  return msg === 'archived channels are read-only'
    ? t('sidebar.members.readOnlyArchived')
    : msg;
};

/**
 * 채널 멤버 패널 — 멤버 목록 · 내보내기 · 자동 멘션 · 초대 · 팀 추가 · 나가기(UX ⑦b-2). `Sidebar` 의 인라인
 * 패널을 **그대로** 꺼냈다(규칙과 근거 주석은 옮기기 전과 같다). 열리면(마운트) 목록을 받는다 — 전에는
 * `openMembers` 가 그 일을 했다.
 *
 * **시트 전용이다**(designer #1049): 사이드바의 상자(테두리·"#이름 멤버" 제목)는 그리지 않는다 — 시트 머리가 이미
 * 채널 이름을 말하고, 상자 안의 상자가 된다. **나가기도 여기 없다** — 채널 나가기는 시트 정보 탭 한 곳이다
 * (마지막 멤버 확인도 그 자리 하나). 같은 조작이 두 자리에 살면 확인 문구가 갈라진다.
 */
export function ChannelMembersPanel({ channel, part = 'all' }: {
  channel: ChannelRow;
  /**
   * 어느 몫을 그리나(UX ⑦b-2). 채널 설정 시트는 **멤버**(목록·초대·팀)와 **에이전트**(자동 멘션)를
   * 다른 탭에 둔다. 조회·절차는 한 벌이다.
   */
  part?: 'all' | 'members' | 'agents';
}) {
  const t = useT();
  const ch = channel;
  const me = useActiveStore((s) => s.me);
  const accounts = useActiveStore((s) => s.accounts);
  const channels = useActiveStore((s) => s.channels);
  const channelMembers = useActiveStore((s) => s.channelMembers);
  const channelAutoMentions = useActiveStore((s) => s.channelAutoMentions);
  // 멤버 패널. 열려 있는 채널 id 하나만 둔다 — 여러 채널의 패널이 동시에 열리면 어느
  // 목록을 보고 있는지가 화면에서 사라진다(편집 패널과 같은 규칙).
  const [memberError, setMemberError] = useState<string | null>(null);
  // 자동 멘션 절(#173)의 실패. 멤버 목록 실패와 자리를 나눈다 — 한 문장에 두 사고를 섞으면
  // 사용자는 어느 쪽을 다시 시도해야 하는지 모른다.
  const [autoMentionError, setAutoMentionError] = useState<string | null>(null);
  const [inviteAccountId, setInviteAccountId] = useState('');
  const [teams, setTeams] = useState<AgentTeamRow[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [teamAddResult, setTeamAddResult] = useState<AddTeamToChannelResult | null>(null);
  // 팀 쪽 실패는 멤버 목록 실패와 **다른 자리**에 적는다 — 한 칸을 나눠 쓰면 어느 쪽이
  // 실패했는지가 화면에서 사라진다.
  const [teamError, setTeamError] = useState<string | null>(null);
  // '마지막 멤버가 나간다'는 되돌릴 수 없는 조작이라 한 번 더 묻는다.
  // 패널은 열린 채널 하나만 그리므로 "어느 채널의 패널인가" 는 prop 이다. 옮겨 온 절차가 부르던 자리만 남긴다.
  const setMembersChannelId = (_id: string | null): void => {};

  const resetMembers = (): void => {
    setMembersChannelId(null);
    setMemberError(null);
    setInviteAccountId('');
    setTeams([]);
    setSelectedTeamId('');
    setTeamAddResult(null);
    setTeamError(null);
  };

  /**
   * 멤버 패널을 연다. **조회 실패를 빈 목록으로 삼키지 않는다** — private 채널에서
   * "멤버 없음" 은 "이 채널은 아무도 볼 수 없다"는 뜻이라 거짓 사실이 나가기 경고까지
   * 지운다. 실패하면 목록을 그리지 않고 오류를 보여 준다.
   */
  const openMembers = async (channelId: string): Promise<void> => {
    setMembersChannelId(channelId);
    setAutoMentionError(null);
    // 자동 멘션 목록(#173)은 멤버 목록과 **별개로** 받는다 — 한쪽 실패가 다른 쪽을 가리면 안 된다.
    void getController().loadChannelAutoMentions(channelId)
      .catch((err: unknown) => setAutoMentionError(err instanceof Error ? err.message : t('sidebar.members.autoMentionListFailed')));
    setMemberError(null);
    setInviteAccountId('');
    setTeams([]);
    setSelectedTeamId('');
    setTeamAddResult(null);
    setTeamError(null);
    try {
      await getController().loadChannelMembers(channelId);
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : t('sidebar.members.listFailed'));
      return;
    }
    /**
     * 팀 목록(#172)은 **따로** 받는다. 한 try 에 묶으면 팀 조회가 실패했을 때 화면이
     * "멤버 목록을 받지 못했다"고 말한다 — 멤버 목록은 방금 받았는데 거짓을 말하는 것이다.
     * 팀 목록이 없으면 "팀으로 추가" 자리만 안 뜨면 되고, 그 사실을 따로 알린다.
     *
     * private 채널에서만 부른다: public 채널에는 멤버십이 없어(#156) 서버가 400 으로
     * 거절한다 — 뜻이 없는 조작의 진입점을 만들지 않는다.
     */
    const channel = channels.find((c) => c.id === channelId);
    if (channel?.visibility === 'private') {
      try {
        setTeams(await getController().listTeams());
      } catch {
        setTeamError(t('sidebar.members.teamListFailed'));
      }
    }
  };

  const submitTeamAdd = async (channelId: string): Promise<void> => {
    if (!selectedTeamId) return;
    setTeamAddResult(null);
    setTeamError(null);
    try {
      const result = await getController().addTeamToChannel(channelId, selectedTeamId);
      setTeamAddResult(result);
      setSelectedTeamId('');
      // 넣은 결과가 멤버 목록에 보여야 한다 — 결과 문구만 갱신하면 바로 아래 목록이
      // 방금 들어온 에이전트를 빼고 그린다.
      await getController().loadChannelMembers(channelId);
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : t('sidebar.members.teamAddFailed'));
    }
  };

  const submitInvite = async (channelId: string): Promise<void> => {
    if (!inviteAccountId) return;
    try {
      await getController().inviteChannelMember(channelId, inviteAccountId);
      setInviteAccountId('');
      setMemberError(null);
    } catch (err) {
      setMemberError(memberErrorText(err, t('sidebar.members.inviteFailed'), t));
    }
  };

  /**
   * 자동 멘션을 켜고 끈다(#173). admin 만 부를 수 있다 — 화면도 admin 에게만 토글을 내준다.
   * 실패는 그 절 안에 보여 준다: 서버가 400(에이전트 아님·비활성)이나 403 을 줄 수 있고,
   * 그 사유가 조용히 사라지면 사용자는 체크박스가 고장 났다고 여긴다.
   */
  /**
   * 채널이 이 에이전트를 어떻게 데리고 있나 — 세 값 하나로 정한다(마이그레이션 048).
   *
   * `off` 는 행을 지우는 것이고 나머지 둘은 행의 `mode` 다. 체크박스 두 개로 나누지 않은
   * 이유: 두 상자는 넷을 표현하고(둘 다 켠 상태·둘 다 끈 상태) 그중 둘은 뜻이 없다.
   * 세 값 중 하나라는 것이 사실이므로 컨트롤도 하나다.
   */
  const changeAutoMention = async (
    channelId: string, agentAccountId: string, value: 'off' | ChannelAutoMentionMode,
  ): Promise<void> => {
    setAutoMentionError(null);
    try {
      if (value === 'off') await getController().unsetChannelAutoMention(channelId, agentAccountId);
      else await getController().setChannelAutoMention(channelId, agentAccountId, value);
    } catch (err) {
      setAutoMentionError(err instanceof Error ? err.message : t('sidebar.members.autoMentionFailed'));
    }
  };

  useEffect(() => {
    void openMembers(ch.id);
    return () => resetMembers();
    // 채널·진입 방식이 바뀔 때만 다시 연다 — 절차 함수의 신원은 렌더마다 바뀐다.
  }, [ch.id]);

      const members = channelMembers[ch.id];
      const memberIds = new Set((members ?? []).map((m) => m.accountId));
      const invitable = Object.values(accounts).filter((a) => !memberIds.has(a.id));
      const isMember = !!me && memberIds.has(me.id);
      /**
       * 초대 가능 여부는 **서버 게이트(`assertChannelVisible`)와 같은 술어**다: public 표준
       * 채널은 누구나, private 은 그 채널의 멤버만이다. 넓게 잡으면 admin 이 자기가 없는
       * private 채널에서 초대를 눌러 403 을 받는다 — 눌러서 실패하는 항목은 "할 수 있다"는
       * 거짓 신호다(docs/design.md §4). 목록을 아직 못 받았으면 판정할 근거가 없으므로
       * 내주지 않는다.
       */
      const canInvite = members !== undefined && (ch.visibility === 'public' || isMember);
  return (
        <div data-testid={`members-${ch.id}`}>
          {part !== 'agents' && (<>
          {/* public 과 private 에서 이 목록의 **뜻이 다르다**. public 채널은 멤버가 아니어도
              읽고 쓸 수 있으므로 여기 적힌 사람들은 "볼 수 있는 사람"이 아니라 구독자다 —
              그 말을 하지 않으면 목록에 없는 사람은 못 본다는 뜻으로 읽힌다. private 은
              반대로 이 목록이 곧 볼 수 있는 사람의 전부다. */}
          <p className="mb-1 text-meta text-fg-subtle">
            {ch.visibility === 'private'
              ? t('sidebar.members.scopePrivate')
              : t('sidebar.members.scopePublic')}
          </p>
          {memberError && <p role="alert" className="mb-1 text-meta text-danger">{memberError}</p>}
          {/* 키 자체가 없으면 '아직 못 받았다'다 — 빈 목록으로 그리면 거짓 사실이 된다. */}
          {members === undefined
            ? !memberError && <p className="mb-1 text-meta text-fg-subtle">{t('sidebar.members.loading')}</p>
            : (
              <ul className="mb-1 space-y-0.5">
                {members.length === 0 && <li className="text-meta text-fg-subtle">{t('sidebar.members.empty')}</li>}
                {members.map((m) => {
                  // 디렉터리에 없는 계정은 **아무 종류도 주장하지 않는다** — 모르는 것을
                  // '사람'으로 그리면 에이전트가 사람으로 보이는 거짓 사실이 된다.
                  const account = accounts[m.accountId];
                  return (
                    <li key={m.accountId} className="flex items-center gap-1 text-meta text-fg-muted">
                      <span>@{m.handle}</span>
                      {account && (
                        <span className="rounded-sm bg-surface-raised px-1 text-meta text-fg">
                          {account.kind === 'agent' ? t('sidebar.members.kindAgent') : t('sidebar.members.kindHuman')}
                        </span>
                      )}
                      {/* 채널 역할이 아니라 **계정 속성**이다 — 채널별 역할은 아직 없다(#183).
                          그래서 'admin' 이 아니라 '워크스페이스 admin' 이라고 적는다. */}
                      {account?.isAdmin && (
                        <span
                          className="rounded-sm bg-surface-raised px-1 text-meta text-warning"
                          title={t('sidebar.members.adminBadgeTitle')}
                        >
                          {t('sidebar.members.adminBadge')}
                        </span>
                      )}
                      {me?.isAdmin && m.accountId !== me?.id && (
                        <button
                          className="ml-auto rounded-sm px-1 text-meta text-fg-subtle hover:bg-surface-hover hover:text-danger"
                          aria-label={t('sidebar.members.removeAction', { handle: m.handle })}
                          onClick={() => void getController().leaveChannel(ch.id, m.accountId)
                            .catch((err: unknown) => setMemberError(memberErrorText(err, t('sidebar.members.removeFailed'), t)))}
                        >
                          {t('sidebar.members.remove')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>)}
          {part !== 'members' && (<>
          {/* 자동 멘션(#173). 채널 설정 화면이 따로 없어 채널의 관리 표면인 이 패널에 둔다 —
              admin 전용 편집 폼에 두면 admin 이 아닌 사람은 "이 채널이 누구를 자동으로 부르나"를
              어디에서도 볼 수 없다. admin 은 토글, 나머지는 읽기 전용이다: 서버가 403 을 줄
              조작을 화면이 내주면 "할 수 있다"는 거짓 신호다(docs/design.md §4). */}
          {(() => {
            const autoRows = channelAutoMentions[ch.id];
            const onIds = new Set((autoRows ?? []).map((r) => r.agentAccountId));
            // 에이전트 id → 지금 걸린 모드. 없는 키가 곧 '없음' 이다.
            const modeOf = new Map((autoRows ?? []).map((r) => [r.agentAccountId, r.mode] as const));
            // admin 은 켤 수 있는 에이전트 전부(비활성은 이미 켜져 있을 때만 — 끄는 길은 있어야
            // 한다)를, 나머지는 켜진 것만 본다. 서버가 비활성 에이전트의 추가를 400 으로
            // 막으므로, 그 토글을 내주면 눌러서 실패하는 항목이 된다.
            const agents = Object.values(accounts)
              .filter((a) => a.kind === 'agent' && (me?.isAdmin ? (!a.disabled || onIds.has(a.id)) : onIds.has(a.id)))
              .sort((a, b) => a.handle.localeCompare(b.handle));
            return (
              <div data-testid={`auto-mentions-${ch.id}`} className="mb-1 border-t border-border pt-1">
                <div className="mb-0.5 text-meta text-fg-muted">{t('sidebar.members.autoMentionHeading')}</div>
                <p className="mb-1 text-meta text-fg-subtle">
                  {/*
                    **두 문장이 따로 있다.** 뒤엣것은 admin 이 아닌 사람에게만 붙는 조건절이고,
                    한 키로 합치면 두 경우가 각각 한 문장씩 필요해져 사전 항목이 둘로 늘어난다
                    (그리고 앞 문장이 두 곳에 복제된다). 이어 붙이는 것은 화면의 일이다 —
                    `WaitChainSection` 이 `·` 를 화면에 남긴 것과 같은 규칙이다.
                  */}
                  {t('sidebar.members.autoMentionNote')}
                  {!me?.isAdmin && t('sidebar.members.autoMentionNoteReadOnly')}
                </p>
                {autoMentionError && <p role="alert" className="mb-1 text-meta text-danger">{autoMentionError}</p>}
                {/* 키가 없으면 '아직 못 받았다' — 빈 목록으로 그리면 "아무도 안 부른다"는 거짓 사실이 된다. */}
                {autoRows === undefined
                  ? !autoMentionError && <p className="mb-1 text-meta text-fg-subtle">{t('sidebar.members.loading')}</p>
                  : (
                    <ul className="mb-1 space-y-0.5">
                      {agents.length === 0 && (
                        <li className="text-meta text-fg-subtle">
                          {me?.isAdmin
                            ? t('sidebar.members.autoMentionEmptyAdmin')
                            : t('sidebar.members.autoMentionEmptyReader')}
                        </li>
                      )}
                      {agents.map((a) => (
                        <li key={a.id} className="flex items-center gap-1 text-meta text-fg-muted">
                          {me?.isAdmin ? (
                            <>
                              <span>@{a.handle}</span>
                              <select
                                aria-label={t('sidebar.members.autoMentionMode', { handle: a.handle })}
                                className="rounded-sm border border-border bg-field px-1 py-0.5 text-meta text-fg"
                                value={modeOf.get(a.id) ?? 'off'}
                                onChange={(e) => void changeAutoMention(ch.id, a.id, e.target.value as 'off' | ChannelAutoMentionMode)}
                              >
                                <option value="off">{t('sidebar.members.autoMentionOff')}</option>
                                <option value="available">{t('sidebar.members.autoMentionAvailable')}</option>
                                <option value="always">{t('sidebar.members.autoMentionAlways')}</option>
                              </select>
                            </>
                          ) : (
                            <span>@{a.handle}</span>
                          )}
                          {/* 배지는 **켜진 행에만** 붙는다. admin 목록에는 꺼진 에이전트도 서므로
                              무조건 붙이면 고른 값이 '없음' 인 줄에 '자동' 이라고 적힌다 — 화면이
                              선택과 반대되는 말을 한다. 두 값은 서로 다른 말을 해야 한다: 하나는
                              매 줄에 붙고 하나는 눌러야 부른다. */}
                          {modeOf.get(a.id) === 'always' && (
                            <span className="rounded-sm bg-accent-surface px-1 text-meta text-accent">{t('sidebar.members.autoMentionBadge')}</span>
                          )}
                          {modeOf.get(a.id) === 'available' && (
                            <span className="rounded-sm bg-surface-sunken px-1 text-meta text-fg-muted">{t('sidebar.members.autoMentionAvailableBadge')}</span>
                          )}
                          {a.disabled && <span className="rounded-sm bg-surface-hover px-1 text-meta text-fg-muted">{t('sidebar.members.agentDisabled')}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
            );
          })()}
          </>)}
          {part !== 'agents' && (<>
          {canInvite && (
            <div className="mb-1 flex items-center gap-1">
              <select
                aria-label={t('sidebar.members.inviteSelect')}
                className="flex-1 rounded-sm border border-border bg-field px-1 py-0.5 text-fg"
                value={inviteAccountId}
                onChange={(e) => setInviteAccountId(e.target.value)}
              >
                <option value="">{t('sidebar.members.invitePick')}</option>
                {invitable.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
              </select>
              <button
                className="rounded-row bg-accent px-2 py-0.5 text-meta text-fg-on-strong hover:bg-accent-hover disabled:opacity-40"
                disabled={!inviteAccountId}
                onClick={() => void submitInvite(ch.id)}
              >
                {t('sidebar.members.invite')}
              </button>
            </div>
          )}
          {/*
            팀 추가(#172): **private 채널에서만.** public 채널에는 멤버십이 없어(#156)
            서버가 400 으로 거절하므로 뜻이 없는 진입점을 만들지 않는다.

            admin 게이트를 걸지 **않는다**: 서버의 게이트는 `#156` 의 초대와 같은
            `assertChannelVisible` 이라 그 채널의 멤버면 누구나 넣을 수 있다. 화면만
            admin 으로 좁히면 할 수 있는 조작이 화면에서 사라진다 — 그것도 화면이
            서버와 다른 말을 하는 것이다.

            팀이 하나도 없으면 고를 것이 없으니 자리도 없다. 다만 목록을 **못 받은**
            것은 다른 사실이라 `teamError` 로 따로 말한다.
          */}
          {ch.visibility === 'private' && teamError && (
            <p role="alert" className="mb-1 text-meta text-warning">{teamError}</p>
          )}
          {ch.visibility === 'private' && teams.length > 0 && (
            <div className="mb-1 space-y-1">
              <div className="text-meta text-fg-subtle">{t('sidebar.members.teamHeading')}</div>
              <div className="flex items-center gap-1">
                <select
                  aria-label={t('sidebar.members.teamSelect')}
                  className="flex-1 rounded-sm border border-border bg-field px-1 py-0.5 text-fg"
                  value={selectedTeamId}
                  onChange={(e) => { setSelectedTeamId(e.target.value); setTeamAddResult(null); }}
                >
                  <option value="">{t('sidebar.members.teamPick')}</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <button
                  className="rounded-row bg-accent px-2 py-0.5 text-meta text-fg-on-strong hover:bg-accent-hover disabled:opacity-40"
                  disabled={!selectedTeamId}
                  onClick={() => void submitTeamAdd(ch.id)}
                >
                  {t('sidebar.members.teamAdd')}
                </button>
              </div>
              {teamAddResult && (
                <div className="text-meta text-fg-muted">
                  {teamAddResult.added.length > 0 && <span>{t('sidebar.members.teamAdded', { names: teamAddResult.added.join(', ') })}</span>}
                  {teamAddResult.skipped.length > 0 && <span className="ml-1 text-warning">{t('sidebar.members.teamSkipped', { names: teamAddResult.skipped.join(', ') })}</span>}
                  {teamAddResult.alreadyMember.length > 0 && <span className="ml-1">{t('sidebar.members.teamAlready', { names: teamAddResult.alreadyMember.join(', ') })}</span>}
                </div>
              )}
            </div>
          )}
          </>)}
        </div>
  );
}
