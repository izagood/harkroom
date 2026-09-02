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
}

const emptyDraft = (): Draft => ({
  handle: '', instructions: '', harness: 'claude-code', model: '', effort: '', workingDir: '',
  mentionPermission: 'auto',
});

const draftOf = (a: AgentView): Draft => ({
  handle: a.handle,
  instructions: a.instructions,
  harness: a.harness,
  model: a.model ?? '',
  effort: a.effort ?? '',
  workingDir: a.workingDir ?? '',
  mentionPermission: a.mentionPermission,
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = useAppStore((s) => s.me?.isAdmin === true);

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
      const token = await getController().mintPat(selected.id, 'runner');
      setPat(token);
      loadPats(selected.id);
    } catch {
      setError('PAT 를 새로 발급하지 못했다');
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
          {agents.map((a) => (
            <button
              key={a.id}
              className={`w-full rounded px-2 py-1.5 text-left ${selected?.id === a.id ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}
              onClick={() => pick(a)}
            >
              {a.handle}
              <span className="ml-1 text-[10px] text-zinc-400">{a.harness}</span>
            </button>
          ))}
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
              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">PAT (Personal Access Token)</div>
                <div className="mt-2 space-y-2">
                  {pats.length === 0 ? (
                    <div className="text-[11px] text-zinc-400">PAT 가 없다</div>
                  ) : (
                    pats.map((p) => (
                      <div key={p.label} className="flex items-center justify-between rounded bg-zinc-50 px-2 py-1.5">
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
                <button
                  className="mt-2 rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void mintNewPat()}
                >
                  + New PAT
                </button>
              </div>
            )}

            {error && <p className="text-xs text-red-600">{error}</p>}

            {pat && (
              // 서버가 해시만 보관하므로 지금 놓치면 다시 볼 수 없다.
              <div className="rounded border border-amber-300 bg-amber-50 p-3">
                <div className="text-xs font-semibold text-amber-900">
                  이 토큰은 지금만 보인다 — 러너를 띄울 때 쓴다
                </div>
                <code className="mt-1 block break-all rounded bg-white p-2 text-[11px]">{pat}</code>
                <div className="mt-2 text-[11px] text-amber-900">
                  MURMUR_PAT={pat.slice(0, 12)}… pnpm --filter @murmur/agent start
                </div>
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
