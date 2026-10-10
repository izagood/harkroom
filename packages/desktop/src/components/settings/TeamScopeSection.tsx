/**
 * 팀 상세의 **호출 범위** 절(068) — 에이전트의 `AgentScopeSection` 과 같은 네 값·같은 어휘다.
 *
 * 팀 부름은 두 겹으로 판정된다(서버 `invokeGate.ts`): ① 이 팀의 범위, ② 팀원 각자의 범위. 이 절은
 * ①만 고른다. ②가 있다는 사실은 안내 문장이 말한다 — 안 적으면 팀을 community 로 열어 둔 사람이
 * "owner 전용 팀원도 남이 부르면 깬다"고 믿는다.
 *
 * 판정은 서버가 한다. 이 화면은 고른 값을 그 자리에서 저장하고 **응답의 행**을 그린다 — 누른 값을
 * 그대로 믿으면 서버가 거절한 경우(`owner_required`)에도 화면만 바뀐다(`TeamDetail::changeLead` 와
 * 같은 이유).
 */
import { useState } from 'react';
import { INVOKE_SCOPES, type InvokeScope } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { ApiError } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { errorText } from '../../lib/errorText';

export function TeamScopeSection({ teamId, scope, ownerAccountId, invokers, editable, onChanged }: {
  teamId: string;
  /** 옛 서버(068 전)는 값을 주지 않는다 — 그때 이 절은 그리지 않는다(호출부가 거른다). */
  scope: InvokeScope;
  ownerAccountId: string | null;
  invokers: string[];
  editable: boolean;
  onChanged(next: { scope: InvokeScope; ownerAccountId: string | null; invokers: string[] }): void;
}) {
  const t = useT();
  const accounts = useActiveStore((s) => s.accounts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const off = busy || !editable;
  const humans = Object.values(accounts).filter((a) => a.kind === 'human' && !invokers.includes(a.id));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) {
      setError(e instanceof ApiError && e.code === 'owner_required'
        ? t('agents.teams.scope.errOwnerRequired')
        : t('agents.scope.errFailed', { reason: errorText(e, t) }));
    } finally { setBusy(false); }
  };

  const setScope = (invokeScope: InvokeScope) => void run(async () => {
    const row = await getController().setTeamScope(teamId, { invokeScope });
    onChanged({ scope: row.invokeScope, ownerAccountId: row.ownerAccountId, invokers });
  });
  const setInvoker = (accountId: string, present: boolean) => void run(async () => {
    const c = getController();
    const res = present ? await c.addTeamInvoker(teamId, accountId) : await c.removeTeamInvoker(teamId, accountId);
    onChanged({ scope, ownerAccountId, invokers: res.invokers });
  });

  const handleOf = (id: string) => accounts[id]?.handle ?? id;

  return (
    <div className="rounded-row border border-border p-3" data-testid="team-scope">
      <div className="text-meta font-medium text-fg-muted">{t('agents.teams.scope.heading')}</div>
      <p className="mt-1 text-meta text-fg-subtle">{t('agents.teams.scope.note')}</p>
      <label className="mt-2 flex flex-col gap-1 text-meta text-fg">
        {t('agents.scope.invoke')}
        <select
          aria-label={t('agents.scope.invoke')}
          data-testid="team-scope-select"
          className="w-fit rounded-row border border-border bg-surface px-2 py-1 text-meta text-fg"
          disabled={off}
          value={scope}
          onChange={(e) => setScope(e.target.value as InvokeScope)}
        >
          {INVOKE_SCOPES.map((v) => <option key={v} value={v}>{t(`agents.scope.invoke.${v}`)}</option>)}
        </select>
      </label>
      {scope === 'owner' && (
        <p className="mt-1 text-meta text-fg-subtle" data-testid="team-scope-owner">
          {ownerAccountId
            ? t('agents.teams.scope.owner', { handle: handleOf(ownerAccountId) })
            : t('agents.teams.scope.errOwnerRequired')}
        </p>
      )}
      {scope === 'list' && (
        <div className="mt-3" data-testid="team-invokers">
          <div className="text-meta text-fg-muted">{t('agents.scope.invokers')}</div>
          {invokers.length === 0 && <p className="mt-1 text-meta text-fg-subtle">{t('agents.scope.invokersNone')}</p>}
          <ul className="mt-1 flex flex-wrap gap-2">
            {invokers.map((id) => (
              <li key={id} className="flex items-center gap-1 rounded-row border border-border px-2 py-0.5 text-meta text-fg">
                @{handleOf(id)}
                {editable && (
                  <button
                    className="text-fg-subtle hover:text-danger"
                    aria-label={t('agents.scope.removeInvoker', { handle: handleOf(id) })}
                    disabled={off}
                    onClick={() => setInvoker(id, false)}
                  >×</button>
                )}
              </li>
            ))}
          </ul>
          {editable && (
            <div className="mt-2 flex items-center gap-2">
              <select
                aria-label={t('agents.scope.addInvoker')}
                className="rounded-row border border-border bg-surface px-2 py-1 text-meta text-fg"
                disabled={off}
                value={pick}
                onChange={(e) => setPick(e.target.value)}
              >
                <option value="">{t('agents.scope.pickPerson')}</option>
                {humans.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
              </select>
              <button
                className="rounded-row border border-border px-2 py-1 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
                disabled={off || !pick}
                onClick={() => { const id = pick; setPick(''); setInvoker(id, true); }}
              >{t('agents.scope.addInvoker')}</button>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-meta text-danger" data-testid="team-scope-error">{error}</p>}
    </div>
  );
}
