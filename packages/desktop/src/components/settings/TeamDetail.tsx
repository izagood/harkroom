import { useEffect, useState } from 'react';
import type { AgentTeamMemberRow, AgentTeamRow, AgentView } from '@murmur/shared';
import { HANDLE_PATTERN } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { Identity } from '../Identity';
import { Button } from './primitives';
import { TeamMemberPicker } from './TeamMemberPicker';
import { useT } from '../../i18n/useT';

/**
 * 팀 이름 문법. **`HANDLE_PATTERN` 을 그대로 쓴다** — 팀 이름은 계정 handle 과 같은
 * 네임스페이스이고(서버 `teamRoutes.ts` 가 같은 상수로 검사한다), 여기 리터럴로 다시
 * 적으면 한쪽 문법이 바뀔 때 화면과 서버가 갈라진다. 그러면 화면이 통과시킨 이름을
 * 서버가 400 으로 거절하거나, 그 반대가 된다.
 *
 * (앞 화면 `TeamsSettings.tsx` 에서 그대로 옮겨 왔다 — 그 판단은 이 변경과 무관하게 맞다.)
 */
const NAME_RE = new RegExp(`^${HANDLE_PATTERN}$`);

/**
 * 팀 하나의 상세 — 이름 · 팀원 · 삭제.
 *
 * ## 이것이 앞 `TeamsSettings.tsx` 의 오른쪽 칸이다
 *
 * 문서 4단계의 진단이 **왼쪽 목록**을 겨눴다: *"에이전트 화면에서 방금 걷어낸 그 모양이
 * 팀에 그대로 남아 있다."* 그래서 걷어낸 것은 왼쪽 칸(`aside` 의 팀 목록 + `+ Create
 * team` 버튼)이고, 그 자리를 `TeamGrid` 의 카드 격자가 대신한다. 오른쪽 칸이 하던 일 —
 * 이름 바꾸기 · 팀원 넣고 빼기 · 삭제 — 는 그대로 이 파일에 남는다.
 *
 * **에이전트 상세와 같은 짝이다**: 격자에서 카드를 누르면 상세가 열리고 `← 팀` 으로
 * 돌아간다(`AgentsSettings` 의 `agent-back` 과 같은 어휘). *"한 번에 한 화면"* 이라는
 * 그 규칙(identity 문서)이 팀에도 그대로 적용된다 — 나란히 두면 상세의 폭이 좁아진다.
 *
 * ## 무엇이 바뀌었나
 *
 * | 자리 | 앞 화면 | 지금 |
 * |---|---|---|
 * | 팀원 | `@handle` 텍스트 줄 | **얼굴** + 이름 |
 * | 팀원 추가 | 네이티브 `select` | `TeamMemberPicker`(얼굴 격자) |
 * | 후보 출처 | 스토어의 `accounts` | **`listAgents()`** (그 파일 주석의 근거) |
 * | 이름의 뜻 | 아무 말 없음 | `@release` 로 부를 수 있다고 말한다 |
 * | 삭제 확인 | 인라인 | **그대로**(아래) |
 *
 * ## 삭제 확인은 지금 것이 맞다 (문서)
 *
 * > *"인라인 확인은 Tauri 웹뷰에서 `window.confirm` 이 막힐 수 있어서 택한 방식이고
 * > 선례도 있다. 그대로 둔다 — 다만 버튼 모양만 프리미티브를 통과한다."*
 *
 * 그래서 구조(`confirmDelete` 상태 · 두 단계)는 앞 화면 그대로이고, 손으로 적혀 있던
 * 버튼 클래스만 `primitives.tsx` 의 `Button` 을 통과한다.
 */
export function TeamDetail({ team, agents, onBack, onChanged }: {
  team: AgentTeamRow;
  /**
   * 후보 명단. **`AgentsSettings` 가 격자를 그리려고 이미 받아 둔 `listAgents()` 의 결과**를
   * 그대로 넘긴다 — 새 왕복이 아니다(`TeamMemberPicker` 의 그 문단에 근거가 있다).
   */
  agents: AgentView[];
  onBack(): void;
  /**
   * 팀이 바뀌었다(이름·팀원·삭제). 호출부가 목록과 카드를 다시 읽는다 — 이 컴포넌트가
   * 직접 스토어를 만지지 않는 이유: 카드 격자의 명단 왕복을 누가 하는지가 한 곳에
   * 있어야 한다(`AgentsSettings` 의 `teamMembers` 주석).
   *
   * `deleted` 를 함께 주는 것이 요점이다 — 지운 팀의 상세에 남아 있을 수 없으므로 호출부가
   * 격자로 되돌려야 하고, 그 판단을 "이름이 바뀐 것"과 같은 신호로 뭉개면 호출부가 다시
   * 구별해야 한다.
   */
  onChanged(change: { deleted: boolean }): void;
}) {
  const t = useT();
  const [members, setMembers] = useState<AgentTeamMemberRow[] | null>(null);
  const [editName, setEditName] = useState(team.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 삭제 확인(#155 의 선례). 확인 단계를 **화면 안에** 둔다 — `window.confirm` 은 Tauri
   * 웹뷰에서 막힐 수 있고, 이 저장소의 선례(`Sidebar` 의 채널 삭제·나가기 확인)가 이미
   * 인라인이다. 되돌릴 수 없는 조작을 한 번 누름으로 끝내지 않는다.
   */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isAdmin = useActiveStore((s) => s.me?.isAdmin === true);
  const accounts = useActiveStore((s) => s.accounts);
  const runnerStates = useActiveStore((s) => s.runnerStates);
  const online = useActiveStore((s) => s.online);
  const connected = useActiveStore((s) => s.connected);

  /**
   * 명단을 받는다. **`GET /teams/:id` 가 명단을 주는 유일한 라우트**다(`appStore.ts` 의
   * `teams` 주석). 팀이 바뀌면 다시 받는다 — `team.id` 를 키로 두는 이유는 격자에서 다른
   * 팀을 골라 이 컴포넌트가 재사용될 때 앞 팀의 명단이 남아 있으면 안 되기 때문이다.
   */
  useEffect(() => {
    let live = true;
    setMembers(null);
    setEditName(team.name);
    setConfirmDelete(false);
    setError(null);
    void getController().getTeam(team.id)
      .then(({ members: m }) => { if (live) setMembers(m); })
      // 명단을 못 받은 것과 명단이 빈 것은 다른 사실이다 — `null` 로 남겨 두면 아래가
      // "불러오는 중"으로 그리고, 사유는 이 줄이 말한다(`HandleGroupsSettings` 와 같은 짝).
      .catch(() => { if (live) setError(t('agents.teams.detailFailed')); });
    return () => { live = false; };
  }, [team.id, team.name, t]);

  const submitEdit = async () => {
    const next = editName.trim();
    if (!next || next === team.name) return;
    if (!NAME_RE.test(next)) {
      setError(t('agents.teams.invalidName'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await getController().updateTeam(team.id, next);
      onChanged({ deleted: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('agents.teams.renameFailed'));
    } finally { setBusy(false); }
  };

  const deleteTeam = async () => {
    setBusy(true);
    setError(null);
    try {
      await getController().deleteTeam(team.id);
      setConfirmDelete(false);
      onChanged({ deleted: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('agents.teams.deleteFailed'));
    } finally { setBusy(false); }
  };

  const addMember = async (accountId: string) => {
    setBusy(true);
    setError(null);
    try {
      const { members: m } = await getController().addTeamMember(team.id, accountId);
      setMembers(m);
      // 카드의 `팀 · N명` 은 `memberCount` 에서 오고 그 값은 **행에 실려 온다** — 명단이
      // 바뀌었으면 목록도 다시 읽어야 그 수가 맞는다(`TeamGrid` 의 그 주석).
      onChanged({ deleted: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('agents.teams.memberAddFailed'));
    } finally { setBusy(false); }
  };

  const removeMember = async (accountId: string) => {
    setBusy(true);
    setError(null);
    try {
      const { members: m } = await getController().removeTeamMember(team.id, accountId);
      setMembers(m);
      onChanged({ deleted: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('agents.teams.memberRemoveFailed'));
    } finally { setBusy(false); }
  };

  const memberIds = new Set((members ?? []).map((m) => m.accountId));
  const candidates = agents.filter((a) => !memberIds.has(a.id));

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-raised">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        {/* `AgentsSettings` 의 `agent-back` 과 같은 어휘·같은 모양이다 — 두 상세가 같은
            격자에서 열리므로 돌아가는 길이 다르게 생기면 사람이 그것을 배워야 한다. */}
        <button
          data-testid="team-back"
          className="rounded px-1.5 py-0.5 text-body text-fg-muted hover:bg-surface-hover"
          onClick={onBack}
        >
          {t('agents.teams.back')}
        </button>
        <h2 className="text-name font-bold">@{team.name}</h2>
      </header>

      <div className="w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-5">
        {error && <p role="alert" className="text-meta text-danger">{error}</p>}

        <div className="rounded border border-border p-3">
          <div className="text-meta font-medium text-fg-muted">{t('agents.teams.nameHeading')}</div>
          {/*
            ## **이름의 뜻을 말한다** (문서 4단계)

            > *"팀 이름은 `HANDLE_PATTERN` 을 써 계정과 같은 네임스페이스다. 즉 `@release`
            > 로 부르면 팀 전체가 깬다. 화면은 그 사실을 한 글자도 말하지 않는다."*

            **이제 실제로 동작한다** — `#570` 이 팀 멘션을 열었고(`services/messages.ts` 가
            `getTeamByName`·`listTeamMembers` 를 부른다) 그 전까지는 예약뿐이었다
            (`AgentTeamRow` 주석: *"그 예약을 이제 쓴다"*). 그래서 이 줄은 앞으로 될 일을
            예고하는 것이 아니라 **지금 되는 일을 적는 것**이다.

            이름 **위**가 아니라 입력칸 **아래**인 이유: 이 사실이 필요한 순간은 이름을
            읽을 때가 아니라 **이름을 정할 때**다. `@release` 라고 지으면 그 이름으로 다섯이
            함께 깬다는 것을 알고 정해야 하고, 그 경고가 입력칸 위에 있으면 사람이 칸을
            채우기 전에 읽고 잊는다.

            **`Handle Groups` 를 여기서 가리킨다.** 문서가 그 관계를 *"이 문서가 정하지 않는
            열린 결정"* 으로 남겼고 코디네이터가 갈라 두기로 정했다 — 그러면 남는 일은
            *"각 화면이 서로를 가리키는 것"* 이다(문서가 적은 그 선택지). 이 자리인 근거는
            위 문단과 같다: 두 장치를 혼동하는 순간이 **이름을 정하는 순간**이다. 같은
            네임스페이스라 `@release` 를 한쪽에서 쓰면 다른 쪽에서 쓸 수 없고, 그 사실을
            알아야 하는 사람은 지금 이 칸에 이름을 치고 있는 사람이다.

            갈리는 축을 **구성원 종류**로 적는다. v0.1.63 실측으로 둘 다 부를 수 있게 됐고
            (`#570`), 남은 차이가 그것 하나다 — 집합은 사람만(`agent_not_allowed`), 팀은
            에이전트만(`not_an_agent`). "팀은 일을 시키는 것이고 집합은 부르는 것"이라고
            적으면 지금은 둘 다 부를 수 있으므로 틀린 말이 된다.
          */}
          <div className="mt-2 flex gap-2">
            <input
              aria-label={t('agents.teams.nameEdit')}
              className="flex-1 rounded border border-border bg-field px-3 py-2"
              value={editName}
              onChange={(e) => { setEditName(e.target.value); setError(null); }}
              disabled={!isAdmin}
            />
            {isAdmin && (
              <Button
                variant="primary"
                disabled={busy || editName.trim() === team.name}
                onClick={() => void submitEdit()}
              >
                {t('agents.teams.nameSave')}
              </Button>
            )}
          </div>
          <p data-testid="team-mention-note" className="mt-2 text-meta text-fg-subtle">
            {/* 이름 자리만 다른 색을 입는다 — 그래서 `{name}` 이 문장에서 뽑혀 있고,
                문장 전체의 어순은 사전이 진다(코드가 조각을 잇지 않는다). */}
            {t('agents.teams.nameNote', { name: team.name })}
          </p>
        </div>

        <div className="rounded border border-border p-3">
          <div className="text-meta font-medium text-fg-muted">{t('agents.teams.membersHeading')}</div>
          {/*
            ## 팀원이 **얼굴**이다 (문서 4단계)

            앞 화면의 진단: *"팀원이 글자다 — `@handle` 텍스트 줄. 옆 화면은 얼굴 그리드인데
            **같은 에이전트가 여기서는 얼굴이 없다**."*

            **여기서는 이름을 함께 적는다.** 카드에서 이름을 나열하지 않는 규칙(*"다섯을
            적으면 카드가 목록이 된다"*)이 이 자리에서는 뒤집히는데, 그 규칙이 겨눈 것이
            **카드**이기 때문이다 — 164px 짜리 카드에서 다섯 줄은 목록이지만, 이 상세는
            *"이 팀에 누가 있나"* 에 답하러 오는 자리이고 거기서는 명단이 곧 답이다.
            얼굴만 두면 사람이 `빼기` 를 누르기 전에 그것이 누구인지 확인할 수단이 없다.

            **상태를 얼굴이 그대로 지닌다** — `runnerStates` 를 넘기지 않고 `Identity` 만
            쓴다는 뜻이 아니다: 이 자리에서는 색을 빼지 않는다. 근거는 문서가 팀 카드에
            대해 세운 것과 **다른 방향**이다 — 카드의 얼굴은 *"이 팀에 하나가 죽어 있다"* 를
            말해야 하지만, 이 줄은 명단이고 명단에서 답하는 질문은 *"누가 들어 있나"* 다.
            죽었는지는 옆 묶음(에이전트 격자)이 답하고, 문서가 팀원을 켜고 끄는 일을 그쪽에
            둔 것과 같은 갈림이다(*"팀원을 켜고 끄는 일은 에이전트 묶음에서 한다"*).
            대신 **비활성**은 적는다 — 그것은 러너 상태가 아니라 팀 호출에서 빠지는 사실이고,
            팀에 관한 말이다.
          */}
          <div className="mt-2 space-y-1">
            {members === null && !error && (
              <div className="text-meta text-fg-muted">{t('agents.teams.memberLoading')}</div>
            )}
            {members !== null && members.length === 0 && (
              <div className="text-meta text-fg-muted">{t('agents.teams.memberEmpty')}</div>
            )}
            {(members ?? []).map((m) => (
              <div
                key={m.accountId}
                data-testid={`team-member-${m.handle}`}
                className="flex items-center gap-2 rounded bg-surface px-2 py-1.5"
              >
                <Identity account={accounts[m.accountId]} className="h-8 w-8 text-sm" variant="avatar" />
                {/* 팀원 이름도 상자 안의 단(11px)이다 — 옆의 `(비활성)`·`빼기` 가 이미 그
                    단이라 이름만 올리면 한 줄에 두 단이 선다. `HandleGroupsSettings` 의
                    구성원 줄이 같은 짝이다. */}
                <span className="min-w-0 flex-1 truncate text-meta">
                  @{m.handle}
                  {m.disabled && <span className="ml-1 text-warning">{t('agents.teams.memberDisabled')}</span>}
                </span>
                {isAdmin && (
                  <button
                    aria-label={t('agents.teams.memberRemoveAction', { handle: m.handle })}
                    className="shrink-0 text-meta text-danger hover:underline"
                    disabled={busy}
                    onClick={() => void removeMember(m.accountId)}
                  >
                    {t('agents.teams.memberRemove')}
                  </button>
                )}
              </div>
            ))}
          </div>
          {/*
            **네이티브 `select` 가 사라진 자리다**(문서 4단계 · B3). 명단을 받은 뒤에만
            그린다 — 못 받았으면 `candidates` 가 "이미 팀원인 것"을 뺄 수 없어서 이미 든
            에이전트를 후보로 내주게 되고, 누르면 서버가 거절한다(거짓 신호).
          */}
          {isAdmin && members !== null && (
            <div className="mt-3">
              <div className="mb-1 text-meta text-fg-subtle">
                {t('agents.teams.memberPickNote')}
              </div>
              <TeamMemberPicker
                candidates={candidates}
                runnerStates={runnerStates}
                online={online}
                connected={connected}
                onAdd={(id) => void addMember(id)}
                busy={busy}
              />
            </div>
          )}
          {!isAdmin && (
            <p className="mt-2 text-meta text-fg-subtle">{t('agents.teams.memberReadOnly')}</p>
          )}
        </div>

        {isAdmin && (
          <div className="rounded border border-danger-border p-3">
            <div className="text-meta font-medium text-danger">{t('agents.teams.deleteHeading')}</div>
            <p className="mt-1 text-meta text-fg-subtle">{t('agents.teams.deleteNote')}</p>
            {/* 인라인 확인은 그대로 두고 **버튼 모양만 프리미티브를 통과한다**(문서). */}
            {confirmDelete ? (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-meta text-danger">{t('agents.teams.deleteConfirmAsk')}</span>
                <Button variant="danger" disabled={busy} onClick={() => void deleteTeam()}>
                  {t('agents.teams.deleteConfirm')}
                </Button>
                <Button onClick={() => setConfirmDelete(false)}>{t('agents.teams.cancel')}</Button>
              </div>
            ) : (
              <div className="mt-2">
                <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  {t('agents.teams.delete')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
