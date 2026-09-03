import { useEffect, useState } from 'react';
import type { HandleGroupRow } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useAppStore } from '../../state/appStore';

interface GroupWithMembers {
  group: HandleGroupRow;
  members: string[];
}

export function HandleGroupsSettings() {
  const [groups, setGroups] = useState<HandleGroupRow[]>([]);
  const [selected, setSelected] = useState<GroupWithMembers | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [newHandle, setNewHandle] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');

  const isAdmin = useAppStore((s) => s.me?.isAdmin === true);
  const accounts = useAppStore((s) => s.accounts);

  const loadGroups = () => {
    setLoading(true);
    setError(null);
    void getController().listHandleGroups()
      .then(setGroups)
      .catch(() => setError('목록을 받지 못했다'))
      .finally(() => setLoading(false));
  };

  useEffect(loadGroups, []);

  const loadGroupMembers = async (id: string) => {
    try {
      const result = await getController().getHandleGroup(id);
      setSelected(result);
    } catch {
      setError('구성원을 받지 못했다');
    }
  };

  const createGroup = async () => {
    if (!newHandle.trim() || !newDisplayName.trim()) return;
    if (!/^[a-z0-9_-]{2,32}$/.test(newHandle)) {
      setError('이름은 소문자·숫자·-·_ 2~32자여야 한다');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await getController().createHandleGroup({ handle: newHandle, displayName: newDisplayName });
      setNewHandle('');
      setNewDisplayName('');
      loadGroups();
    } catch {
      setError('만들지 못했다 (이미 있는 이름일 수 있다)');
    } finally {
      setSaving(false);
    }
  };

  const updateGroupName = async () => {
    if (!selected || !editingName || !editDisplayName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await getController().updateHandleGroup(selected.group.id, { displayName: editDisplayName });
      setEditingName(null);
      setEditDisplayName('');
      loadGroups();
      loadGroupMembers(selected.group.id);
    } catch {
      setError('이름을 저장하지 못했다');
    } finally {
      setSaving(false);
    }
  };

  const deleteGroup = async () => {
    if (!selected) return;
    if (!confirm(`정말로 "@${selected.group.handle}" 집합을 지우시겠습니까?`)) return;
    setSaving(true);
    setError(null);
    try {
      await getController().deleteHandleGroup(selected.group.id);
      setSelected(null);
      loadGroups();
    } catch {
      setError('지우지 못했다');
    } finally {
      setSaving(false);
    }
  };

  const addMembers = async (accountIds: string[]) => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await getController().addHandleGroupMembers(selected.group.id, accountIds);
      loadGroupMembers(selected.group.id);
    } catch {
      setError('구성원을 추가하지 못했다');
    } finally {
      setSaving(false);
    }
  };

  const removeMembers = async (accountIds: string[]) => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await getController().removeHandleGroupMembers(selected.group.id, accountIds);
      loadGroupMembers(selected.group.id);
    } catch {
      setError('구성원을 제거하지 못했다');
    } finally {
      setSaving(false);
    }
  };

  const pick = (g: HandleGroupRow) => {
    setSelected(null);
    setError(null);
    loadGroupMembers(g.id);
  };

  const field = 'w-full rounded border border-zinc-300 px-3 py-2';
  const label = 'block text-xs font-medium text-zinc-600';

  const humanAccounts = Object.values(accounts).filter((a) => a.kind === 'human');

  return (
    <div className="flex h-full min-h-0 bg-white">
      <aside className="w-56 shrink-0 border-r border-zinc-200 p-3">
        {isAdmin && (
          <div className="mb-3 space-y-2 rounded border border-zinc-200 p-2">
            <div className="text-[11px] font-medium text-zinc-600">새 집합</div>
            <input
              className={field}
              placeholder="handle"
              value={newHandle}
              onChange={(e) => setNewHandle(e.target.value)}
            />
            <input
              className={field}
              placeholder="표시 이름"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
            />
            <button
              className="w-full rounded bg-zinc-900 px-3 py-2 text-left text-white disabled:opacity-50"
              disabled={saving || !newHandle.trim() || !newDisplayName.trim()}
              onClick={() => void createGroup()}
            >
              만들기
            </button>
          </div>
        )}

        <div className="text-[11px] uppercase tracking-wide text-zinc-500">집합</div>
        {loading && <div className="px-1 py-2 text-zinc-400">불러오는 중…</div>}
        {!loading && groups.length === 0 && <div className="px-1 py-2 text-zinc-400">아직 없다</div>}
        {groups.map((g) => (
          <button
            key={g.id}
            className={`w-full rounded px-2 py-1.5 text-left ${selected?.group.id === g.id ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}
            onClick={() => pick(g)}
          >
            <span className="font-medium">@{g.handle}</span>
            <span className="ml-1 text-[10px] text-zinc-500">{g.displayName}</span>
          </button>
        ))}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-zinc-400">
            집합을 선택하세요
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
              <h2 className="text-base font-bold">@{selected.group.handle}</h2>
              {isAdmin && (
                <button
                  className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                  onClick={() => void deleteGroup()}
                >
                  집합 삭제
                </button>
              )}
            </header>

            <div className="w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-5">
              {error && <p role="alert" className="text-xs text-red-600">{error}</p>}

              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">이름</div>
                {editingName === selected.group.id ? (
                  <div className="mt-2 flex gap-2">
                    <input
                      className={field}
                      value={editDisplayName}
                      onChange={(e) => setEditDisplayName(e.target.value)}
                    />
                    <button
                      className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700"
                      disabled={saving}
                      onClick={() => void updateGroupName()}
                    >
                      저장
                    </button>
                    <button
                      className="rounded px-2 py-1 text-xs text-zinc-500"
                      onClick={() => { setEditingName(null); setEditDisplayName(''); }}
                    >
                      취소
                    </button>
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-sm">{selected.group.displayName}</span>
                    {isAdmin && (
                      <button
                        className="text-[11px] text-indigo-600 hover:underline"
                        onClick={() => { setEditingName(selected.group.id); setEditDisplayName(selected.group.displayName); }}
                      >
                        이름 바꾸기
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">구성원 ({selected.members.length})</div>
                <div className="mt-2 space-y-1">
                  {selected.members.length === 0 ? (
                    <div className="text-[11px] text-zinc-400">구성원이 없습니다</div>
                  ) : (
                    selected.members.map((id) => {
                      const account = accounts[id];
                      return (
                        <div key={id} className="flex items-center justify-between rounded bg-zinc-50 px-2 py-1.5">
                          <span className="text-xs">
                            {account ? `@${account.handle}` : `계정 ID: ${id}`}
                          </span>
                          {isAdmin && (
                            <button
                              className="text-[11px] text-red-600 hover:underline"
                              onClick={() => void removeMembers([id])}
                            >
                              제거
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {isAdmin && (
                  <div className="mt-3">
                    <div className="text-[11px] text-zinc-500 mb-1">구성원 추가</div>
                    <select
                      className={field}
                      value=""
                      onChange={(e) => {
                        if (e.target.value) {
                          void addMembers([e.target.value]);
                          e.target.value = '';
                        }
                      }}
                    >
                      <option value="">계정 선택…</option>
                      {humanAccounts
                        .filter((a) => !selected.members.includes(a.id))
                        .map((a) => (
                          <option key={a.id} value={a.id}>@{a.handle}</option>
                        ))}
                    </select>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}