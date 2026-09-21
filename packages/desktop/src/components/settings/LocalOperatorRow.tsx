/**
 * 에이전트 상세의 **이 머신** 절 — 스펙 2026-09-20 §3 능력. 배정은 서버의 결정이고 능력은
 * 오퍼레이터의 것이라 양쪽이 동의해야 돈다. 이 절은 그 둘째 절반이다: 이 머신의 오퍼레이터
 * 로컬 설정에 이 에이전트를 넣거나 뺀다(작업 디렉터리와 함께). Tauri 표면이 없으면(웹) 그리지
 * 않는다 — 그 머신에는 오퍼레이터가 없다.
 */
import { useCallback, useEffect, useState } from 'react';
import { getController } from '../../state/controller';
import { hasOperatorLocalSurface, listLocalAgents, removeLocalAgent, setLocalAgent } from '../../lib/operatorLocal';
import { useT } from '../../i18n/useT';

interface LocalState { registered: boolean; present: boolean; workingDir: string }

export function LocalOperatorRow({ agentId, disabled }: { agentId: string; disabled?: boolean }) {
  const t = useT();
  const available = hasOperatorLocalSurface();
  const baseUrl = getController().api?.baseUrl ?? null;
  const [state, setState] = useState<LocalState | 'error' | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!available || !baseUrl) return;
    void listLocalAgents().then((r) => {
      const c = r.communities.find((x) => x.baseUrl === baseUrl);
      const entry = c?.agents[agentId];
      const next: LocalState = { registered: c?.registered ?? false, present: entry !== undefined, workingDir: entry?.workingDir ?? '' };
      setState(next);
      setDraft(next.workingDir);
    }).catch(() => setState('error'));
  }, [available, baseUrl, agentId]);
  useEffect(() => { load(); }, [load]);

  if (!available || !baseUrl) return null;

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true); setNotice(null);
    try { await fn(); setNotice(done); load(); }
    catch (e) { setNotice(t('agents.local.failed', { reason: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  };

  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="agent-local-operator">
      <div className="text-meta font-medium text-fg-muted">{t('agents.local.heading')}</div>
      {state === null && <p className="mt-1 text-meta text-fg-subtle">{t('agents.local.loading')}</p>}
      {state === 'error' && <p className="mt-1 text-meta text-danger">{t('agents.local.listFailed')}</p>}
      {state !== null && state !== 'error' && (
        <>
          {!state.registered && (
            <p className="mt-1 text-meta text-warning" data-testid="agent-local-unregistered">{t('agents.local.unregistered')}</p>
          )}
          <label className="mt-2 flex items-center gap-2 text-meta text-fg">
            <input
              type="checkbox"
              aria-label={t('agents.local.enable')}
              checked={state.present}
              disabled={busy || disabled}
              onChange={(e) => {
                const on = e.target.checked;
                void run(
                  () => (on ? setLocalAgent(baseUrl, agentId, { workingDir: draft }) : removeLocalAgent(baseUrl, agentId)),
                  on ? t('agents.local.added') : t('agents.local.removed'),
                );
              }}
            />
            {t('agents.local.enable')}
          </label>
          {state.present && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                aria-label={t('agents.local.workingDir')}
                className="min-w-[16rem] flex-1 rounded border border-border bg-surface px-2 py-1 font-mono text-meta text-fg"
                placeholder={t('agents.local.workingDirPlaceholder')}
                value={draft}
                disabled={busy || disabled}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                className="rounded border border-border px-2 py-1 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
                disabled={busy || disabled || draft === state.workingDir}
                onClick={() => void run(() => setLocalAgent(baseUrl, agentId, { workingDir: draft }), t('agents.local.saved'))}
              >
                {t('agents.local.save')}
              </button>
            </div>
          )}
          {notice && <p className="mt-1 text-meta text-fg-subtle" data-testid="agent-local-notice">{notice}</p>}
          <p className="mt-1 text-meta text-fg-subtle">{t('agents.local.note')}</p>
        </>
      )}
    </div>
  );
}
