import { useEffect, useState } from 'react';
import type { AgentTeamRow, AgentTeamMemberRow } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useAppStore } from '../../state/appStore';

export function TeamsSettings() {
  const [teams, setTeams] = useState<AgentTeamRow[]>([]);
  const [selected, setSelected] = useState<AgentTeamRow | null>(null);
  const [members, setMembers] = useState<AgentTeamMemberRow[]>([]);
  const [newTeamName, setNewTeamName] = useState('');
  const [editName, setEditName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  };

  const submitCreate = async () => {
    if (!newTeamName.trim()) return;
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(newTeamName)) {
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
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(editName)) {
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
    <div className="flex h-full min-h-0 bg-white">
      <aside className="w-56 shrink-0 border-r border-zinc-200 p-3">
        <button
          className="mb-3 w-full rounded bg-zinc-900 px-3 py-2 text-left text-white"
          onClick={startNew}
        >
          + Create team
        </button>
        <div className="text-[11px] uppercase tracking-wide text-zinc-500">Teams</div>
        {teams.length === 0 && <div className="px-1 py-2 text-zinc-400">아직 없다</div>}
        {teams.map((t) => (
          <button
            key={t.id}
            className={`w-full rounded px-2 py-1.5 text-left ${selected?.id === t.id ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}
            onClick={() => void loadTeam(t)}
          >
            {t.name}
          </button>
        ))}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {!selected && (
          <>
            <header className="flex items-center border-b border-zinc-200 px-5 py-3">
              <h2 className="text-base font-bold">Add team</h2>
            </header>
            <div className="w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-5">
              {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
              <label className="block text-xs font-medium text-zinc-600">
                Team name
                <input
                  className="mt-1 w-full rounded border border-zinc-300 px-3 py-2"
                  placeholder="team-name"
                  value={newTeamName}
                  onChange={(e) => { setNewTeamName(e.target.value); setError(null); }}
                  disabled={!isAdmin}
                />
              </label>
              {!isAdmin && (
                <p className="text-xs text-zinc-500">팀을 만들 수 있는 것은 admin 뿐이다</p>
              )}
              <button
                className="rounded bg-indigo-600 px-3 py-2 font-medium text-white disabled:opacity-50"
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
            <header className="flex items-center border-b border-zinc-200 px-5 py-3">
              <h2 className="text-base font-bold">Edit {selected.name}</h2>
            </header>
            <div className="w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-5">
              {error && <p role="alert" className="text-xs text-red-600">{error}</p>}

              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">팀 이름</div>
                <div className="mt-2 flex gap-2">
                  <input
                    className="flex-1 rounded border border-zinc-300 px-3 py-2"
                    value={editName}
                    onChange={(e) => { setEditName(e.target.value); setError(null); }}
                    disabled={!isAdmin}
                  />
                  {isAdmin && (
                    <button
                      className="rounded bg-indigo-600 px-3 py-2 text-white disabled:opacity-50"
                      disabled={busy || editName === selected.name}
                      onClick={() => void submitEdit()}
                    >
                      저장
                    </button>
                  )}
                </div>
              </div>

              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">팀원</div>
                <div className="mt-2 space-y-1">
                  {members.length === 0 && <div className="text-xs text-zinc-400">팀원이 없다</div>}
                  {members.map((m) => (
                    <div key={m.accountId} className="flex items-center justify-between rounded bg-zinc-50 px-2 py-1.5">
                      <span className="text-sm">
                        @{m.handle}
                        {m.disabled && <span className="ml-1 text-[10px] text-zinc-400">(비활성)</span>}
                      </span>
                      {isAdmin && (
                        <button
                          className="text-xs text-red-600 hover:underline"
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
                      className="flex-1 rounded border border-zinc-300 px-2 py-1"
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
                <div className="rounded border border-red-200 p-3">
                  <div className="text-xs font-medium text-red-600">팀 삭제</div>
                  <p className="mt-1 text-[11px] text-zinc-500">팀을 지워도 팀에 속했던 에이전트는 그대로 있다.</p>
                  <button
                    className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void deleteTeam()}
                  >
                    Delete team
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}