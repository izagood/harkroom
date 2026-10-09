/**
 * 에이전트 상세의 **"다른 에이전트가 고를 수 있는 모델"** 절(087, jaebin 승인 결정 3·9·11).
 *
 * 다른 에이전트가 이 에이전트를 부르며(`message.post`·`message.delegate` 의 `agentModels`) 그 스레드에서
 * 쓸 모델·effort 를 고를 수 있는데, **이 목록 안에서만**이다. 비면 못 고른다(opt-in 기본값).
 * 판정은 서버가 한다(`agentModelPicks.ts::applyAgentPicks`) — 이 화면은 목록을 고치고 저장할 뿐이다.
 *
 * - **소유자에게만 그린다.** 서버의 문이 사람·소유자(`owner_only`)라서 admin 이어도 소유자가 아니면
 *   저장이 403 이다 — 보이는데 못 고치는 칸은 그리지 않는다(security ③ 참고 의견).
 * - 한 줄은 (모델·effort 묶음)이다(결정 11). effort 를 하나도 안 켜면 그 모델은 effort 를 못 고른다
 *   — 서버 jsonb 의 `efforts: []` 와 같은 뜻이다.
 * - **좁히면 묻는다**(security 참고 의견): 저장한 뒤 서버가 "목록 밖으로 나간 에이전트 지정이 n개
 *   남았다"(`outside`)고 하면, 그것을 풀지 이 자리에서 묻는다. 묻지 않고 두면 좁힌 목록과 달리 그
 *   스레드들은 옛 값으로 계속 돈다. 사람이 정한 지정은 대상이 아니다(결정 4).
 */
import { useEffect, useState } from 'react';
import type { AgentModelOptions, AgentPickableModel, AgentView } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useT } from '../../i18n/useT';
import { ModelPicker } from './ModelPicker';
import { usePendingEdit } from './pendingEdits';

/** 하네스가 effort 목록을 안 밝혔을 때 고를 값 — 상세의 Effort 칸과 같은 목록이다. */
const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const FIELD = 'rounded-row border border-border bg-surface px-2 py-1 text-meta text-fg';

const same = (a: readonly AgentPickableModel[], b: readonly AgentPickableModel[]) =>
  JSON.stringify(a) === JSON.stringify(b);

export function AgentPickableSection({ agent, disabled }: { agent: AgentView; disabled?: boolean }) {
  const t = useT();
  const [options, setOptions] = useState<AgentModelOptions | 'error' | null>(null);
  const [saved, setSaved] = useState<AgentPickableModel[]>([]);
  const [draft, setDraft] = useState<AgentPickableModel[]>([]);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 저장 뒤 남은 목록 밖 에이전트 지정 수. 0 보다 크면 정리할지 묻는다. */
  const [outside, setOutside] = useState(0);
  const [cleared, setCleared] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setOptions(null); setOutside(0); setCleared(null); setError(null);
    // 동기 예외(옛 컨트롤러 등)도 '못 읽음'으로 받는다 — 이 절 하나 때문에 상세 화면 전체가 죽지 않게.
    Promise.resolve().then(() => getController().agentModelOptions(agent.id))
      .then((o) => {
        if (!alive) return;
        setOptions(o);
        setSaved(o.pickable ?? []);
        setDraft(o.pickable ?? []);
      })
      .catch(() => { if (alive) setOptions('error'); });
    return () => { alive = false; };
  }, [agent.id]);

  const save = async (clearOutside: boolean): Promise<boolean> => {
    setBusy(true); setError(null);
    try {
      const res = await getController().setAgentPickableModels(agent.id, draft, clearOutside);
      setSaved(res.models);
      setDraft(res.models);
      setOutside(res.outside ?? 0);
      setCleared(clearOutside ? (res.cleared ?? 0) : null);
      return true;
    } catch (err) {
      setError(t('agents.pickable.saveFailed', { reason: err instanceof Error ? err.message : String(err) }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // 모델 목록은 상세의 저장 바로 모은다(A3) — 못 읽었으면 걸지 않는다(빈 목록을 저장하면 목록이 지워진다).
  const loaded = options !== null && options !== 'error';
  const inBar = usePendingEdit('pickable', loaded && !same(draft, saved) ? 1 : 0, () => save(false), () => setDraft(saved));

  if (options === null) {
    return (
      <Frame t={t}><p className="mt-2 text-meta text-fg-muted">{t('agents.pickable.loading')}</p></Frame>
    );
  }
  if (options === 'error') {
    // 못 읽은 것을 빈 목록으로 그리면 "아무도 못 고른다"는 거짓 사실이 되고, 그 위에서 저장하면 목록을 지운다.
    return (
      <Frame t={t}><p role="alert" className="mt-2 text-meta text-danger">{t('agents.pickable.loadFailed')}</p></Frame>
    );
  }

  const models = options.models;
  const effortsOf = (model: string): readonly string[] =>
    models?.find((m) => m.id === model)?.efforts ?? FALLBACK_EFFORTS;
  const off = busy || disabled;
  const dirty = !same(draft, saved);
  const name = adding.trim();
  const canAdd = name !== '' && !draft.some((e) => e.model === name);

  const toggleEffort = (model: string, effort: string) => setDraft((prev) => prev.map((e) => (
    e.model !== model ? e : {
      ...e,
      efforts: e.efforts.includes(effort)
        ? e.efforts.filter((x) => x !== effort)
        // 하네스가 밝힌 순서(낮은 것부터)를 지킨다 — 누른 순서로 쌓이면 같은 목록이 다르게 저장된다.
        : effortsOf(model).filter((x) => x === effort || e.efforts.includes(x)),
    })));

  return (
    <Frame t={t}>
      {draft.length === 0 ? (
        <p className="mt-2 text-meta text-fg-subtle" data-testid="pickable-empty">{t('agents.pickable.empty')}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {draft.map((e) => (
            <li key={e.model} data-testid={`pickable-row-${e.model}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-row bg-surface px-2 py-1.5">
              <span className="font-mono text-meta font-medium text-fg">{e.model}</span>
              <span className="flex flex-wrap items-center gap-2">
                {effortsOf(e.model).map((x) => (
                  <label key={x} className="flex items-center gap-1 text-meta text-fg-muted">
                    <input
                      type="checkbox"
                      aria-label={t('agents.pickable.effortLabel', { model: e.model, effort: x })}
                      checked={e.efforts.includes(x)}
                      disabled={off}
                      onChange={() => toggleEffort(e.model, x)}
                    />
                    {x}
                  </label>
                ))}
              </span>
              {e.efforts.length === 0 && (
                <span className="text-meta text-fg-subtle">{t('agents.pickable.noEffort')}</span>
              )}
              <button
                type="button"
                className="ml-auto rounded-row px-1.5 py-0.5 text-meta text-fg-muted hover:bg-surface-sunken"
                aria-label={t('agents.pickable.remove', { model: e.model })}
                disabled={off}
                onClick={() => setDraft((prev) => prev.filter((p) => p.model !== e.model))}
              >
                {t('agents.pickable.removeShort')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ModelPicker 가 고르개 뒤에 내놓는 안내문(목록 실패 등)은 줄 아래로 내린다 — 넓은 칸에서 고르개 · 긴 안내문 · 「추가」
          순으로 한 줄에 서서 「추가」가 고르개와 떨어졌다(designer #1256 nit 3). */}
      <div className="mt-2 flex flex-wrap items-center gap-2 [&>span]:order-last [&>span]:basis-full">
        <ModelPicker value={adding} models={models} onChange={setAdding} className={FIELD} />
        <button
          type="button"
          data-testid="pickable-add"
          className="rounded-row border border-border px-2 py-1 text-meta text-fg hover:bg-surface-hover disabled:opacity-50"
          disabled={off || !canAdd}
          onClick={() => {
            // 새 줄은 effort 없이 시작한다 — 비싼 effort 를 켜는 것은 소유자가 손으로 하는 일이다.
            setDraft((prev) => [...prev, { model: name, efforts: [] }]);
            setAdding('');
          }}
        >
          {t('agents.pickable.add')}
        </button>
        {!inBar && <button
          type="button"
          data-testid="pickable-save"
          className="ml-auto rounded-row bg-accent px-2 py-1 text-meta font-medium text-fg-on-strong hover:bg-accent-hover disabled:opacity-50"
          disabled={off || !dirty}
          onClick={() => void save(false)}
        >
          {t('agents.pickable.save')}
        </button>}
      </div>

      {outside > 0 && (
        <div role="alertdialog" aria-label={t('agents.pickable.outsideTitle')} data-testid="pickable-outside"
          className="mt-2 rounded-row border border-warning-border bg-warning-surface px-2 py-1.5 text-meta text-warning">
          <p>{t('agents.pickable.outsideAsk', { n: String(outside) })}</p>
          <div className="mt-1.5 flex justify-end gap-2">
            <button type="button" data-testid="pickable-keep" disabled={off}
              className="rounded-row px-2 py-1 text-meta text-fg-muted hover:bg-surface-sunken"
              onClick={() => setOutside(0)}>
              {t('agents.pickable.keep')}
            </button>
            <button type="button" data-testid="pickable-clear" disabled={off}
              className="rounded-row border border-warning-border bg-surface px-2 py-1 text-meta font-medium text-fg hover:bg-surface-hover"
              onClick={() => void save(true)}>
              {t('agents.pickable.clear')}
            </button>
          </div>
        </div>
      )}
      {cleared !== null && cleared > 0 && (
        <p className="mt-2 text-meta text-fg-subtle" data-testid="pickable-cleared">{t('agents.pickable.cleared', { n: String(cleared) })}</p>
      )}
      {error && <p role="alert" className="mt-2 text-meta text-danger">{error}</p>}
    </Frame>
  );
}

function Frame({ t, children }: { t: ReturnType<typeof useT>; children: React.ReactNode }) {
  return (
    <div className="rounded-row border border-border p-3" data-testid="agent-pickable">
      <div className="text-meta font-medium text-fg-muted">{t('agents.pickable.heading')}</div>
      <p className="mt-1 text-meta text-fg-subtle">{t('agents.pickable.note')}</p>
      {children}
    </div>
  );
}
