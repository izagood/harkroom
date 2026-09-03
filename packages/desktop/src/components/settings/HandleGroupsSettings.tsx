import { useState } from 'react';
import type { HandleGroupRow } from '@murmur/shared';
import { HANDLE_PATTERN } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useAppStore } from '../../state/appStore';
import { GroupBadge } from '../Identity';

/**
 * 핸들 집합(#230)의 설정 화면(#285). 만들기·이름 바꾸기·구성원 추가/제거·삭제.
 *
 * **목록은 스토어에서 읽는다 — 여기서 따로 받지 않는다.** 두 가지 이유가 겹친다.
 *
 * ① `#230` 의 관리 라우트(`GET /handle-groups`)는 **admin 전용**이다. 그래서 비-admin
 *    에게 "읽기 전용 목록"을 보이려면 그 라우트로는 안 된다 — 403 이 돌아온다. 집합 목록은
 *    `GET /accounts` 가 계정과 함께 주고(모든 계정이 부를 수 있다) 컨트롤러가 기동 시
 *    스토어에 넣는다. 비-admin 이 목록을 보는 경로는 그것뿐이다.
 * ② 이 화면에서 바꾼 것이 **작성창 후보에 즉시 반영돼야 한다**(#285 결정 3). 화면이
 *    자기만의 사본을 들고 있으면 두 목록이 갈라진다 — 여기서는 새 이름, 후보에는 옛 이름.
 *
 * 구성원 **명단**은 집합을 고를 때 따로 받는다(`GET /handle-groups/:id`, admin 전용).
 * 명단까지 스토어에 넣지 않는 이유: 집합 수만큼 왕복이 늘고, 목록 화면이 필요한 것은
 * 수뿐이다(그 수는 서버가 행에 실어 준다 — `HandleGroupRow.memberCount`).
 *
 * `AgentsSettings.tsx` 를 건드리지 않는다. 레이아웃(왼쪽 목록 + 오른쪽 상세)만 같은 모양이다.
 */
interface GroupWithMembers {
  group: HandleGroupRow;
  members: string[];
}

export function HandleGroupsSettings() {
  // 스토어 구독이다 — `getState()` 스냅샷이면 만들기·이름 바꾸기 뒤에 목록이 그대로 남는다.
  const groups = useAppStore((s) => s.groups);
  const isAdmin = useAppStore((s) => s.me?.isAdmin === true);
  const accounts = useAppStore((s) => s.accounts);

  const [selected, setSelected] = useState<GroupWithMembers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [newHandle, setNewHandle] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  // 지우기는 되돌릴 수 없으니 한 번 더 묻는다. `window.confirm` 은 쓰지 않는다 —
  // Tauri 웹뷰에서 막힐 수 있고, 이 저장소의 선례(`Sidebar` 의 채널 삭제 확인,
  // `AgentsSettings` 의 '정말 지운다')가 모두 화면 안 인라인 확인이다.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /** 서버가 사유를 말해 주면 그것을 보인다 — 우리가 지어낸 한 줄로 덮으면 사유가 사라진다. */
  const reason = (e: unknown, fallback: string): string =>
    (e instanceof Error && e.message ? e.message : fallback);

  const loadGroupMembers = async (id: string) => {
    try {
      setSelected(await getController().getHandleGroup(id));
    } catch (e) {
      // 명단을 못 받은 것과 명단이 빈 것은 다른 사실이다 — 상세를 열지 않고 사유를 말한다.
      setSelected(null);
      setError(reason(e, '구성원 명단을 받지 못했다'));
    }
  };

  const createGroup = async () => {
    if (!newHandle.trim() || !newDisplayName.trim()) return;
    // 문법은 서버와 **같은 것**을 본다 — 여기 정규식을 리터럴로 적으면 계정·집합이 쓰는
    // 한 네임스페이스의 문법이 화면과 서버에서 갈린다(`handleGroupRoutes` 의 주석).
    if (!new RegExp(`^${HANDLE_PATTERN}$`).test(newHandle)) {
      setError('집합 핸들은 계정 핸들과 같은 문법이어야 한다');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await getController().createHandleGroup({ handle: newHandle, displayName: newDisplayName });
      setNewHandle('');
      setNewDisplayName('');
    } catch (e) {
      setError(reason(e, '만들지 못했다 (이미 있는 이름일 수 있다)'));
    } finally {
      setSaving(false);
    }
  };

  const updateGroupName = async () => {
    if (!selected || !editingName || !editDisplayName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await getController().updateHandleGroup(selected.group.id, { displayName: editDisplayName });
      setEditingName(null);
      setEditDisplayName('');
      // 상세 패널의 이름도 함께 바뀐다 — 스토어만 고치면 지금 열려 있는 패널이 옛 이름을 남긴다.
      setSelected({ group: updated, members: selected.members });
    } catch (e) {
      setError(reason(e, '이름을 저장하지 못했다'));
    } finally {
      setSaving(false);
    }
  };

  const deleteGroup = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await getController().deleteHandleGroup(selected.group.id);
      setConfirmingDelete(false);
      setSelected(null);
    } catch (e) {
      setError(reason(e, '지우지 못했다'));
    } finally {
      setSaving(false);
    }
  };

  const changeMembers = async (accountIds: string[], op: 'add' | 'remove') => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const members = op === 'add'
        ? await getController().addHandleGroupMembers(selected.group.id, accountIds)
        : await getController().removeHandleGroupMembers(selected.group.id, accountIds);
      setSelected({ group: selected.group, members });
    } catch (e) {
      // 서버는 에이전트를 넣으려 하면 사유를 담아 400 을 준다(#230 결정 1). 그 문장이
      // 사람에게 도달해야 왜 안 들어갔는지 알 수 있다.
      setError(reason(e, op === 'add' ? '구성원을 추가하지 못했다' : '구성원을 제거하지 못했다'));
    } finally {
      setSaving(false);
    }
  };

  const pick = (g: HandleGroupRow) => {
    setSelected(null);
    setError(null);
    setEditingName(null);
    setConfirmingDelete(false);
    // 비-admin 은 구성원 명단 라우트를 부를 수 없다(admin 전용). 목록과 구성원 수까지가
    // 읽기 전용으로 보이는 전부다 — 부르면 403 을 사유로 보이게 되어 소음이 된다.
    if (isAdmin) void loadGroupMembers(g.id);
  };

  const field = 'w-full rounded border border-zinc-300 px-3 py-2';

  /**
   * 구성원 후보는 **사람 계정뿐**이다 — 에이전트는 집합에 들어가지 않는다(#230 결정 1,
   * `addHandleGroupMembers` 의 주석이 이유를 적는다). 후보에 에이전트를 두고 서버가
   * 400 으로 거절하게 만들면, 사람은 고른 뒤에야 안 된다는 것을 알게 된다.
   */
  const humanAccounts = Object.values(accounts).filter((a) => a.kind === 'human');

  return (
    <div className="flex h-full min-h-0 bg-white">
      <aside className="w-56 shrink-0 border-r border-zinc-200 p-3">
        {isAdmin && (
          <div className="mb-3 space-y-2 rounded border border-zinc-200 p-2">
            <div className="text-[11px] font-medium text-zinc-600">새 집합</div>
            <input
              className={field}
              aria-label="집합 핸들"
              placeholder="handle"
              value={newHandle}
              onChange={(e) => setNewHandle(e.target.value)}
            />
            <input
              className={field}
              aria-label="집합 표시 이름"
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
        {/* 목록이 비어 있는 것과 못 읽은 것을 섞지 않는다: 목록은 스토어(기동 시 조회)에서
            오므로 여기서 "불러오는 중"을 그릴 것이 없고, 조회가 실패했으면 컨트롤러가
            연결 상태로 말한다. 이 자리에서 말할 수 있는 것은 "정말 하나도 없다" 뿐이다. */}
        {groups.length === 0 && <div className="px-1 py-2 text-zinc-400">아직 없다</div>}
        {groups.map((g) => (
          <button
            key={g.id}
            data-testid={`group-row-${g.handle}`}
            className={`flex w-full items-center gap-1 rounded px-2 py-1.5 text-left ${selected?.group.id === g.id ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}
            onClick={() => pick(g)}
          >
            <span className="font-medium">@{g.handle}</span>
            <GroupBadge group={g} />
            <span className="ml-1 truncate text-[10px] text-zinc-500">{g.displayName}</span>
          </button>
        ))}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 오류는 상세 패널 **밖**에 둔다. 안에 두면 상세가 열리지 않는 실패(목록·명단
            조회 실패, 만들기 실패)의 사유가 화면에 아예 나타나지 않는다. */}
        {error && <p role="alert" className="border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700">{error}</p>}
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-zinc-400">
            {isAdmin ? '집합을 선택하세요' : '집합을 만들고 고치는 것은 관리자만 할 수 있습니다'}
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
              <h2 className="text-base font-bold">@{selected.group.handle}</h2>
              {isAdmin && (confirmingDelete ? (
                <span className="flex items-center gap-2">
                  <button
                    className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                    disabled={saving}
                    onClick={() => void deleteGroup()}
                  >
                    정말 지운다
                  </button>
                  <button
                    className="rounded px-2 py-1 text-xs text-zinc-500"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    취소
                  </button>
                </span>
              ) : (
                <button
                  className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                  onClick={() => setConfirmingDelete(true)}
                >
                  집합 삭제
                </button>
              ))}
            </header>

            <div className="w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-5">
              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">이름</div>
                {editingName === selected.group.id ? (
                  <div className="mt-2 flex gap-2">
                    <input
                      className={field}
                      aria-label="새 표시 이름"
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
                          {/* 계정 디렉터리에 없는 id 는 **"모른다"** 다 — 이름 자리를 비우면
                              "구성원이 아니다"로 읽힌다(design.md 4절). id 를 그대로 보인다. */}
                          <span className="text-xs">
                            {account ? `@${account.handle}` : `계정 ID: ${id}`}
                          </span>
                          {isAdmin && (
                            <button
                              className="text-[11px] text-red-600 hover:underline"
                              aria-label={`구성원 제거: ${account ? account.handle : id}`}
                              disabled={saving}
                              onClick={() => void changeMembers([id], 'remove')}
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
                    <div className="mb-1 text-[11px] text-zinc-500">구성원 추가</div>
                    <select
                      className={field}
                      aria-label="구성원 추가"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) void changeMembers([e.target.value], 'add');
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
