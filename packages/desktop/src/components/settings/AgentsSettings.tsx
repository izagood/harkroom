import { useEffect, useState } from 'react';
import {
  AGENT_HARNESSES, RUNNABLE_HARNESSES, type AgentConfig, type AgentView, type MentionPermission, type PatView,
} from '@murmur/shared';
import { getController } from '../../state/controller';
import { useAppStore } from '../../state/appStore';

/** AGENT_HARNESSES 에조차 없는 harness. 없는 것은 사용자의 CLI 가 아니라 murmur 의 구현이므로
 *  '설치 안 됨'이 아니라 '지원 예정'이다. AGENT_HARNESSES 에는 있지만 아직 못 돌리는 것(RUNNABLE_HARNESSES
 *  밖)은 아래 select 렌더링에서 따로 disabled 처리한다 — 여기 중복해서 적지 않는다. */
const PLANNED = ['cursor', 'goose', 'amp', 'devin'];

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

interface Draft {
  handle: string;
  instructions: string;
  harness: AgentConfig['harness'];
  model: string;
  effort: string;
  workingDir: string;
  mentionPermission: MentionPermission;
  ownerAccountId: string | null;
}

const emptyDraft = (): Draft => ({
  handle: '', instructions: '', harness: 'claude-code', model: '', effort: '', workingDir: '',
  mentionPermission: 'auto', ownerAccountId: null,
});

const draftOf = (a: AgentView): Draft => ({
  handle: a.handle,
  instructions: a.instructions,
  harness: a.harness,
  model: a.model ?? '',
  effort: a.effort ?? '',
  workingDir: a.workingDir ?? '',
  mentionPermission: a.mentionPermission,
  ownerAccountId: a.ownerAccountId,
});

export function AgentsSettings() {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [selected, setSelected] = useState<AgentView | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  // null 이면 'harness 기본값 사용'. 되돌릴 때 model·effort 를 명시적 null 로 비워야 한다.
  const [customized, setCustomized] = useState(false);
  const [pat, setPat] = useState<string | null>(null);
  const [pats, setPats] = useState<PatView[]>([]);
  const [revoking, setRevoking] = useState<string | null>(null);
  // 라벨을 하드코딩하면 재발급이 막힌다 — 라벨은 살아 있는 토큰 안에서 유일하고
  // (마이그레이션 010) 서버가 중복을 409 로 거절한다. 토큰을 잃어 폐기한 뒤 같은 이름으로
  // 다시 발급하는 것이 주 사용 흐름이라, 사용자가 이름을 정할 수 있어야 한다.
  const [newPatLabel, setNewPatLabel] = useState('runner');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = useAppStore((s) => s.me?.isAdmin === true);
  const accounts = useAppStore((s) => s.accounts);
  const humanAccounts = Object.values(accounts).filter((a) => a.kind === 'human');

  const reload = () => {
    void getController().listAgents().then(setAgents).catch(() => setError('에이전트 목록을 받지 못했다'));
  };
  useEffect(reload, []);

  const loadPats = (agentId: string) => {
    if (!isAdmin) return;
    void getController().listPats(agentId).then(setPats).catch(() => setPats([]));
  };

  const pick = (a: AgentView) => {
    setSelected(a);
    setDraft(draftOf(a));
    setCustomized(a.model !== null || a.effort !== null);
    setPat(null);
    setPats([]);
    setRevoking(null);
    setError(null);
    loadPats(a.id);
  };

  const startNew = () => {
    setSelected(null);
    setDraft(emptyDraft());
    setCustomized(false);
    setPat(null);
    setPats([]);
    setRevoking(null);
    setError(null);
  };

  /** 'harness 기본값 사용'이면 명시적 null 로 비운다 — 필드를 안 보내면 서버가 기존 값을 유지한다. */
  const configPatch = (): Partial<AgentConfig> => ({
    instructions: draft.instructions,
    harness: draft.harness,
    model: customized && draft.model ? draft.model : null,
    effort: customized && draft.effort ? draft.effort : null,
    workingDir: draft.workingDir || null,
    mentionPermission: draft.mentionPermission,
    ownerAccountId: draft.ownerAccountId,
  });

  const submit = async () => {
    setError(null);
    if (selected) {
      setBusy(true);
      try {
        const updated = await getController().updateAgent(selected.id, configPatch());
        setSelected(updated);
        reload();
      } catch {
        setError('저장하지 못했다');
      } finally { setBusy(false); }
      return;
    }
    if (!/^[a-z0-9_-]{2,32}$/.test(draft.handle)) {
      setError('이름은 소문자·숫자·-·_ 2~32자여야 한다 (채널에서 @이름 으로 부른다)');
      return;
    }
    setBusy(true);
    try {
      const { pat: minted } = await getController().createAgent({
        handle: draft.handle, displayName: draft.handle, ...configPatch(),
      });
      setPat(minted);
      reload();
    } catch {
      setError('만들지 못했다 (이미 있는 이름일 수 있다)');
    } finally { setBusy(false); }
  };

  const revokePat = async (label: string) => {
    if (!selected) return;
    setError(null);
    try {
      await getController().revokePat(selected.id, label);
      loadPats(selected.id);
    } catch {
      setError('PAT 를 폐기하지 못했다');
    }
    setRevoking(null);
  };

  const mintNewPat = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getController().mintPat(selected.id, newPatLabel.trim());
      setPat(token);
      loadPats(selected.id);
    } catch (e) {
      // 서버가 왜 거절했는지 그대로 보여야 한다 — 특히 '이 라벨은 이미 쓰인다'(409)는
      // 사용자가 라벨만 바꾸면 해결되는 것이라, 뭉개면 막힌 것처럼 보인다.
      setError(e instanceof Error ? e.message : 'PAT 를 새로 발급하지 못했다');
    } finally { setBusy(false); }
  };

  const field = 'w-full rounded border border-zinc-300 px-3 py-2';
  const label = 'block text-xs font-medium text-zinc-600';

  return (
    <div className="flex h-full min-h-0 bg-white">
        <aside className="w-56 shrink-0 border-r border-zinc-200 p-3">
          <button
            className="mb-3 w-full rounded bg-zinc-900 px-3 py-2 text-left text-white"
            onClick={startNew}
          >
            + Create agent
          </button>
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Agents</div>
          {agents.length === 0 && <div className="px-1 py-2 text-zinc-400">아직 없다</div>}
{agents.map((a) => {
              const owner = a.ownerAccountId ? accounts[a.ownerAccountId]?.handle : null;
              return (
                <button
                  key={a.id}
                  className={`w-full rounded px-2 py-1.5 text-left ${selected?.id === a.id ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}
                  onClick={() => pick(a)}
                >
                  {a.handle}
                  <span className="ml-1 text-[10px] text-zinc-400">{a.harness}</span>
                  {/* 세 경우다: 소유자가 없다 / 있고 디렉터리에 있다 / 있는데 디렉터리에
                      없다. 마지막을 빈 칸으로 그리면 "없다"와 구분되지 않는다 —
                      docs/design.md 4절이 금지하는 형태의 거울상이다. */}
                  <span className={`ml-1 text-[10px] ${owner ? 'text-indigo-600' : 'text-zinc-400'}`}>
                    {a.ownerAccountId === null ? '없음' : (owner ?? '알 수 없는 계정')}
                  </span>
                </button>
              );
            })}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center border-b border-zinc-200 px-5 py-3">
            <h2 className="text-base font-bold">{selected ? `Edit ${selected.handle}` : 'Add agent'}</h2>
          </header>

          <div className="w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-5">
            <label className={label}>
              Agent name
              <input
                className={field}
                aria-label="Agent name"
                placeholder="fizz"
                value={draft.handle}
                disabled={selected !== null}
                onChange={(e) => setDraft({ ...draft, handle: e.target.value })}
              />
              {!selected && <span className="text-[11px] text-zinc-500">채널에서 @이름 으로 부른다. 나중에 바꿀 수 없다.</span>}
            </label>

            <label className={label}>
              Agent instructions
              <textarea
                className={`${field} resize-y`}
                aria-label="Agent instructions"
                rows={6}
                placeholder="이 에이전트가 무엇을 하는지 적는다."
                value={draft.instructions}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              />
            </label>

            <div>
              <div className={label}>AI configuration</div>
              <div className="mt-1 flex gap-1">
                <button
                  className={`flex-1 rounded px-3 py-2 ${customized ? 'bg-zinc-100 text-zinc-600' : 'bg-white shadow ring-1 ring-zinc-300'}`}
                  onClick={() => setCustomized(false)}
                >
                  Use harness defaults
                </button>
                <button
                  className={`flex-1 rounded px-3 py-2 ${customized ? 'bg-white shadow ring-1 ring-zinc-300' : 'bg-zinc-100 text-zinc-600'}`}
                  onClick={() => setCustomized(true)}
                >
                  Customize for this agent
                </button>
              </div>
            </div>

            <label className={label}>
              Agent harness
              <select
                className={field}
                aria-label="Agent harness"
                value={draft.harness}
                onChange={(e) => setDraft({ ...draft, harness: e.target.value as AgentConfig['harness'] })}
              >
                {AGENT_HARNESSES.map((h) =>
                  (RUNNABLE_HARNESSES as readonly string[]).includes(h)
                    ? <option key={h} value={h}>{h} (default)</option>
                    : <option key={h} value={h} disabled>{h} (지원 예정)</option>,
                )}
                {PLANNED.map((h) => (
                  <option key={h} value={h} disabled>{h} (지원 예정)</option>
                ))}
              </select>
            </label>

            <label className={label}>
              Mention permission
              <select
                className={field}
                aria-label="Mention permission"
                value={draft.mentionPermission}
                onChange={(e) => setDraft({ ...draft, mentionPermission: e.target.value as MentionPermission })}
              >
                <option value="auto">auto — 멘션 턴에서 도구를 모두 허용</option>
                <option value="readonly">readonly — 읽기만 (상담 전용)</option>
              </select>
              <span className="text-[11px] text-zinc-500">
                사람이 터미널로 직접 조종할 때는 이 설정과 무관하게 하네스가 물어본다.
              </span>
            </label>

            {customized && (
              <div className="grid grid-cols-2 gap-3">
                <label className={label}>
                  Model
                  <input
                    className={field}
                    aria-label="Model"
                    placeholder="harness 기본값"
                    value={draft.model}
                    onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  />
                </label>
                <label className={label}>
                  Effort
                  <select
                    className={field}
                    aria-label="Effort"
                    value={draft.effort}
                    onChange={(e) => setDraft({ ...draft, effort: e.target.value })}
                  >
                    <option value="">harness 기본값</option>
                    {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
                  </select>
                </label>
              </div>
            )}

            <label className={label}>
              Working directory
              <input
                className={field}
                aria-label="Working directory"
                placeholder="/Users/me/some-repo — 비우면 스레드 전용 빈 디렉터리를 새로 만든다"
                value={draft.workingDir}
                onChange={(e) => setDraft({ ...draft, workingDir: e.target.value })}
              />
            </label>

            {selected && isAdmin && (
              <label className={label}>
                소유자
                <select
                  className={field}
                  aria-label="Owner"
                  value={draft.ownerAccountId ?? ''}
                  onChange={(e) => setDraft({ ...draft, ownerAccountId: e.target.value || null })}
                >
                  <option value="">없음 — attach 불가</option>
                  {humanAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.handle}</option>
                  ))}
                </select>
                <span className="text-[11px] text-zinc-500">
                  소유자만 이 에이전트에 attach 할 수 있다.
                </span>
              </label>
            )}

            {!isAdmin && selected && (
              <div className="rounded border border-zinc-100 bg-zinc-50 p-3">
                <div className="text-xs text-zinc-500">
                  {draft.ownerAccountId
                    ? `소유자: @${accounts[draft.ownerAccountId]?.handle ?? '?'}`
                    : '소유자: 없음 — attach 불가'}
                </div>
              </div>
            )}

            {selected && isAdmin && (
              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">PAT (Personal Access Token)</div>
                <div className="mt-2 space-y-2">
                  {pats.length === 0 ? (
                    <div className="text-[11px] text-zinc-400">PAT 가 없다</div>
                  ) : (
                    pats.map((p) => (
                      <div key={`${p.label}:${p.createdAt}`} className="flex items-center justify-between rounded bg-zinc-50 px-2 py-1.5">
                        <div className="text-xs">
                          <span className="font-medium">{p.label}</span>
                          {p.revokedAt && (
                            <span className="ml-2 text-red-600">(폐기됨)</span>
                          )}
                          <span className="ml-2 text-zinc-400">
                            {new Date(p.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        {!p.revokedAt && (
                          revoking === p.label ? (
                            <div className="flex items-center gap-1">
                              <button
                                className="rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700"
                                onClick={() => void revokePat(p.label)}
                              >
                               Really revoke
                              </button>
                              <button
                                className="px-1.5 py-0.5 text-[11px] text-zinc-500"
                                onClick={() => setRevoking(null)}
                              >
                               Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              className="text-[11px] text-red-600 hover:underline"
                              onClick={() => setRevoking(p.label)}
                            >
                              Revoke
                            </button>
                          )
                        )}
                      </div>
                    ))
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    className="w-40 rounded border border-zinc-300 px-2 py-1 text-xs"
                    aria-label="New PAT label"
                    placeholder="runner"
                    value={newPatLabel}
                    onChange={(e) => setNewPatLabel(e.target.value)}
                  />
                  <button
                    className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50"
                    disabled={busy || newPatLabel.trim() === ''}
                    onClick={() => void mintNewPat()}
                  >
                    + New PAT
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-zinc-400">
                  라벨은 살아 있는 토큰 안에서 유일합니다. 폐기하면 같은 라벨을 다시 쓸 수 있습니다.
                </p>
              </div>
            )}

            {error && <p className="text-xs text-red-600">{error}</p>}

            {pat && (
              // 서버가 해시만 보관하므로 지금 놓치면 다시 볼 수 없다.
              <div className="rounded border border-amber-300 bg-amber-50 p-3">
                <div className="text-xs font-semibold text-amber-900">
                  이 토큰은 지금만 보인다 — 서버가 해시만 보관하므로 다시 볼 수 없다
                </div>
                <code className="mt-1 block break-all rounded bg-white p-2 text-[11px]">{pat}</code>
                {/* #125: 이 명령의 토큰을 자르고 말줄임표를 붙여 두면, 그대로 복사해 실행했을 때
                    인증이 실패한다 — "완성된 명령"처럼 보이는데 아니었다. 전체 토큰을 싣는다.
                    바로 위 코드 블록에 이미 전체 토큰이 있으므로 중복 노출이 새 위험은 아니다. */}
                <div className="mt-2 break-all font-mono text-[11px] text-amber-900">
                  MURMUR_PAT={pat} pnpm --filter @murmur/agent start
                </div>
                {/* #125: 등록만으로는 아무 일도 일어나지 않는다. 실측으로 에이전트 6개 중 4개가
                    러너를 가져본 적이 없고 그중 2개는 미읽음 멘션이 쌓인 채였다. 사용자의 기대는
                    "UI 로 등록했으면 러너도 같이 떴어야 하는 것 아닌가"였다 — 그 기대를 바로잡는다.
                    murmur 가 러너를 띄운다고 쓰지 않는다(그건 사실이 아니다, design.md §4). */}
                <p className="mt-2 text-[11px] text-amber-900">
                  murmur 는 러너를 띄우지 않는다. <strong>위 명령을 직접 실행해 러너를 붙이기
                  전까지 이 에이전트는 멘션에 답하지 않는다</strong> — 멘션은 쌓이기만 한다.
                  murmur 저장소를 체크아웃한 머신에서 실행한다.
                </p>
              </div>
            )}
          </div>

          <footer className="w-full max-w-2xl border-t border-zinc-200 px-5 py-3">
            <button
              className="w-full rounded bg-indigo-600 py-2 font-medium text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => void submit()}
            >
              {selected ? 'Save changes' : 'Create agent'}
            </button>
          </footer>
        </div>
    </div>
  );
}
