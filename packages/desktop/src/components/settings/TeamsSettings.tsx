import { useEffect, useState } from 'react';
import type { AgentTeamRow, AgentTeamMemberRow } from '@murmur/shared';
import { HANDLE_PATTERN } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useAppStore } from '../../state/appStore';

/**
 * 팀 이름 문법. **`HANDLE_PATTERN` 을 그대로 쓴다** — 팀 이름은 계정 handle 과 같은
 * 네임스페이스이고(서버 `teamRoutes.ts` 가 같은 상수로 검사한다), 여기 리터럴로 다시
 * 적으면 한쪽 문법이 바뀔 때 화면과 서버가 갈라진다. 그러면 화면이 통과시킨 이름을
 * 서버가 400 으로 거절하거나, 그 반대가 된다.
 */
const NAME_RE = new RegExp(`^${HANDLE_PATTERN}$`);

export function TeamsSettings() {
  const [teams, setTeams] = useState<AgentTeamRow[]>([]);
  const [selected, setSelected] = useState<AgentTeamRow | null>(null);
  const [members, setMembers] = useState<AgentTeamMemberRow[]>([]);
  const [newTeamName, setNewTeamName] = useState('');
  const [editName, setEditName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 삭제 확인(#155 의 선례). 확인 단계를 **화면 안에** 둔다 — `window.confirm` 은 Tauri
   * 웹뷰에서 막힐 수 있고, 이 저장소의 선례(`Sidebar` 의 채널 삭제·나가기 확인)가 이미
   * 인라인이다. 되돌릴 수 없는 조작을 한 번 누름으로 끝내지 않는다.
   */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isAdmin = useAppStore((s) => s.me?.isAdmin === true);
  const accounts = useAppStore((s) => s.accounts);
  const agents = Object.values(accounts).filter((a) => a.kind === 'agent');

  const reload = () => {
    void getController().listTeams().then(setTeams).catch(() => setError('팀 목록을 받지 못했다'));
  };
  useEffect(reload, []);

  const loadTeam = async (team: AgentTeamRow) => {
    setSelected(team);
    setEditName(team.name);
    setError(null);
    setConfirmDelete(false);
    try {
      const { members: m } = await getController().getTeam(team.id);
      setMembers(m);
    } catch {
      setError('팀 정보를 받지 못했다');
    }
  };

  const startNew = () => {
    setSelected(null);
    setMembers([]);
    setNewTeamName('');
    setError(null);
    setConfirmDelete(false);
  };

  const submitCreate = async () => {
    if (!newTeamName.trim()) return;
    if (!NAME_RE.test(newTeamName.trim())) {
      setError('이름은 영문·숫자·-·_ 2~32자여야 한다');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await getController().createTeam(newTeamName.trim());
      setNewTeamName('');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '팀을 만들지 못했다');
    } finally { setBusy(false); }
  };

  const submitEdit = async () => {
    if (!selected || !editName.trim()) return;
    if (!NAME_RE.test(editName.trim())) {
      setError('이름은 영문·숫자·-·_ 2~32자여야 한다');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await getController().updateTeam(selected.id, editName.trim());
      reload();
      setSelected({ ...selected, name: editName.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : '이름을 바꾸지 못했다');
    } finally { setBusy(false); }
  };

  const deleteTeam = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await getController().deleteTeam(selected.id);
      setSelected(null);
      setMembers([]);
      setConfirmDelete(false);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '팀을 지우지 못했다');
    } finally { setBusy(false); }
  };

  const addMember = async (accountId: string) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const { members: m } = await getController().addTeamMember(selected.id, accountId);
      setMembers(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : '팀원을 추가하지 못했다');
    } finally { setBusy(false); }
  };

  const removeMember = async (accountId: string) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const { members: m } = await getController().removeTeamMember(selected.id, accountId);
      setMembers(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : '팀원을 빼지 못했다');
    } finally { setBusy(false); }
  };

  const memberIds = new Set(members.map((m) => m.accountId));
  const availableAgents = agents.filter((a) => !memberIds.has(a.id));

  return (
    <div className="flex h-full min-h-0 bg-surface-raised">
      <aside className="w-56 shrink-0 border-r border-border p-3">
        <button
          className="mb-3 w-full rounded bg-accent px-3 py-2 text-left text-fg-on-strong hover:bg-accent-hover"
          onClick={startNew}
        >
          + Create team
        </button>
        <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Teams</div>
        {teams.length === 0 && <div className="px-1 py-2 text-fg-muted">아직 없다</div>}
        {teams.map((t) => (
          <button
            key={t.id}
            data-testid={`team-row-${t.name}`}
            className={`w-full rounded px-2 py-1.5 text-left ${selected?.id === t.id ? 'bg-surface-sunken' : 'hover:bg-surface'}`}
            onClick={() => void loadTeam(t)}
          >
            {t.name}
          </button>
        ))}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {!selected && (
          <>
            <header className="flex items-center border-b border-border px-5 py-3">
              <h2 className="text-base font-bold">Add team</h2>
            </header>
            <div className="w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-5">
              {error && <p role="alert" className="text-xs text-danger">{error}</p>}
              <label className="block text-xs font-medium text-fg-muted">
                Team name
                <input
                  aria-label="팀 이름"
                  className="mt-1 w-full rounded border border-border bg-field px-3 py-2"
                  placeholder="team-name"
                  value={newTeamName}
                  onChange={(e) => { setNewTeamName(e.target.value); setError(null); }}
                  disabled={!isAdmin}
                />
              </label>
              {!isAdmin && (
                <p className="text-xs text-fg-subtle">팀을 만들 수 있는 것은 admin 뿐이다</p>
              )}
              <button
                className="rounded bg-accent px-3 py-2 font-medium text-fg-on-strong disabled:opacity-50"
                disabled={busy || !isAdmin || !newTeamName.trim()}
                onClick={() => void submitCreate()}
              >
                Create team
              </button>
            </div>
          </>
        )}

        {selected && (
          <>
            <header className="flex items-center border-b border-border px-5 py-3">
              <h2 className="text-base font-bold">Edit {selected.name}</h2>
            </header>
            <div className="w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-5">
              {error && <p role="alert" className="text-xs text-danger">{error}</p>}

              <div className="rounded border border-border p-3">
                <div className="text-xs font-medium text-fg-muted">팀 이름</div>
                <div className="mt-2 flex gap-2">
                  <input
                    aria-label="팀 이름 수정"
                    className="flex-1 rounded border border-border bg-field px-3 py-2"
                    value={editName}
                    onChange={(e) => { setEditName(e.target.value); setError(null); }}
                    disabled={!isAdmin}
                  />
                  {isAdmin && (
                    <button
                      className="rounded bg-accent px-3 py-2 text-fg-on-strong disabled:opacity-50"
                      disabled={busy || editName === selected.name}
                      onClick={() => void submitEdit()}
                    >
                      저장
                    </button>
                  )}
                </div>
              </div>

              <div className="rounded border border-border p-3">
                <div className="text-xs font-medium text-fg-muted">팀원</div>
                <div className="mt-2 space-y-1">
                  {members.length === 0 && <div className="text-xs text-fg-muted">팀원이 없다</div>}
                  {members.map((m) => (
                    <div key={m.accountId} className="flex items-center justify-between rounded bg-surface px-2 py-1.5">
                      <span className="text-sm">
                        @{m.handle}
                        {m.disabled && <span className="ml-1 text-[10px] text-fg-muted">(비활성)</span>}
                      </span>
                      {isAdmin && (
                        <button
                          aria-label={`팀원 빼기: ${m.handle}`}
                          className="text-xs text-danger hover:underline"
                          onClick={() => void removeMember(m.accountId)}
                        >
                          빼기
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {isAdmin && availableAgents.length > 0 && (
                  <div className="mt-2 flex gap-2">
                    <select
                      aria-label="팀원 추가"
                      className="flex-1 rounded border border-border bg-field px-2 py-1"
                      value=""
                      onChange={(e) => { if (e.target.value) void addMember(e.target.value); }}
                    >
                      <option value="">에이전트 선택…</option>
                      {availableAgents.map((a) => (
                        <option key={a.id} value={a.id}>@{a.handle}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {isAdmin && (
                <div className="rounded border border-danger-border p-3">
                  <div className="text-xs font-medium text-danger">팀 삭제</div>
                  <p className="mt-1 text-[11px] text-fg-subtle">팀을 지워도 팀에 속했던 에이전트는 그대로 있다.</p>
                  {confirmDelete ? (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[11px] text-danger">정말 지우는가?</span>
                      <button
                        className="rounded border border-danger-border bg-danger-surface px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-surface-strong disabled:opacity-50"
                        disabled={busy}
                        onClick={() => void deleteTeam()}
                      >
                        정말 삭제
                      </button>
                      <button
                        className="rounded border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-surface-hover"
                        onClick={() => setConfirmDelete(false)}
                      >
                        취소
                      </button>
                    </div>
                  ) : (
                    <button
                      className="mt-2 rounded border border-danger-border bg-danger-surface px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-surface-strong disabled:opacity-50"
                      disabled={busy}
                      onClick={() => setConfirmDelete(true)}
                    >
                      Delete team
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}