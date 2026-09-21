/**
 * 에이전트 상세의 **호출 범위·자격증명** 절 — 스펙 2026-09-20 §6.
 *
 * 값은 넷이고 전부 서버가 판정한다(`agentScopes.test.ts`): 불변식(personal ⟺ owner), 넓히기
 * 금지, 레지스트리 밖 이름, personal 이름의 credentialScope. 이 화면은 고른 값을 **그 자리에서**
 * 저장하고 서버의 거절 코드를 사람 말로 옮길 뿐이다 — 판정을 여기 복사하면 한쪽만 고치는 날
 * 조용히 열리는 쪽으로 어긋난다(`invokeGate.ts` 머리 주석과 같은 이유).
 *
 * 저장 버튼이 따로 없는 이유: 상세의 저장(`configPatch`)은 지시문·모델 같은 정의를 싣는다. 스코프는
 * 인가의 값이라 그 본문에 섞이면 소유자가 지시문을 고칠 때마다 스코프 검사가 같이 돌고, 넓히기
 * 거절이 "지시문을 저장하지 못했다"로 읽힌다.
 */
import { useEffect, useState } from 'react';
import { CREDENTIAL_SCOPES, INVOKE_SCOPES, type AgentView, type CredentialScope, type InvokeScope, type McpServerRow } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { ApiError } from '../../lib/api';
import { useT } from '../../i18n/useT';

export function AgentScopeSection({ agent, disabled, onUpdated }: {
  agent: AgentView;
  disabled?: boolean;
  onUpdated: (next: AgentView) => void;
}) {
  const t = useT();
  const accounts = useActiveStore((s) => s.accounts);
  const [registry, setRegistry] = useState<McpServerRow[] | 'error' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');

  useEffect(() => {
    // 약속 안에서 부른다 — 표면이 없는 컨트롤러(부분 가짜)에서도 동기 예외가 아니라 '읽지 못했다'다.
    void Promise.resolve().then(() => getController().mcpServers()).then(setRegistry).catch(() => setRegistry('error'));
  }, []);

  const explain = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === 'scope_invariant') return t('agents.scope.errInvariant');
      if (err.code === 'scope_widening') return t('agents.scope.errWidening');
      if (err.code === 'unknown_mcp_server') return t('agents.scope.errUnknownMcp');
    }
    return t('agents.scope.errFailed', { reason: err instanceof Error ? err.message : String(err) });
  };
  const run = async (fn: () => Promise<AgentView>) => {
    setBusy(true); setError(null);
    try { onUpdated(await fn()); } catch (e) { setError(explain(e)); } finally { setBusy(false); }
  };

  // 옛 서버(스코프 마이그레이션 전)는 이 두 필드를 주지 않는다 — 없으면 빈 목록으로 그린다.
  const invokers = agent.invokers ?? [];
  const mcpServers = agent.mcpServers ?? [];
  const humans = Object.values(accounts).filter((a) => a.kind === 'human' && !invokers.includes(a.id));
  const off = busy || disabled;

  return (
    <div className="rounded border border-border p-3" data-testid="agent-scope">
      <div className="text-meta font-medium text-fg-muted">{t('agents.scope.heading')}</div>
      <p className="mt-1 text-meta text-fg-subtle">{t('agents.scope.note')}</p>

      <div className="mt-2 flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-meta text-fg">
          {t('agents.scope.invoke')}
          <select
            aria-label={t('agents.scope.invoke')}
            className="rounded border border-border bg-surface px-2 py-1 text-meta text-fg"
            disabled={off}
            value={agent.invokeScope}
            onChange={(e) => {
              const invokeScope = e.target.value as InvokeScope;
              void run(() => getController().updateAgent(agent.id, { invokeScope }));
            }}
          >
            {INVOKE_SCOPES.map((v) => <option key={v} value={v}>{t(`agents.scope.invoke.${v}`)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-meta text-fg">
          {t('agents.scope.credential')}
          <select
            aria-label={t('agents.scope.credential')}
            className="rounded border border-border bg-surface px-2 py-1 text-meta text-fg"
            disabled={off}
            value={agent.credentialScope}
            onChange={(e) => {
              const credentialScope = e.target.value as CredentialScope;
              void run(() => getController().updateAgent(agent.id, { credentialScope }));
            }}
          >
            {CREDENTIAL_SCOPES.map((v) => <option key={v} value={v}>{t(`agents.scope.credential.${v}`)}</option>)}
          </select>
        </label>
      </div>

      {agent.invokeScope === 'list' && (
        <div className="mt-3" data-testid="agent-invokers">
          <div className="text-meta text-fg-muted">{t('agents.scope.invokers')}</div>
          {invokers.length === 0 && <p className="mt-1 text-meta text-fg-subtle">{t('agents.scope.invokersNone')}</p>}
          <ul className="mt-1 flex flex-wrap gap-2">
            {invokers.map((id) => (
              <li key={id} className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-meta text-fg">
                @{accounts[id]?.handle ?? id}
                <button
                  className="text-fg-subtle hover:text-danger"
                  aria-label={t('agents.scope.removeInvoker', { handle: accounts[id]?.handle ?? id })}
                  disabled={off}
                  onClick={() => void run(() => getController().removeInvoker(agent.id, id))}
                >×</button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <select
              aria-label={t('agents.scope.addInvoker')}
              className="rounded border border-border bg-surface px-2 py-1 text-meta text-fg"
              disabled={off}
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">{t('agents.scope.pickPerson')}</option>
              {humans.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
            </select>
            <button
              className="rounded border border-border px-2 py-1 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
              disabled={off || !pick}
              onClick={() => { const id = pick; setPick(''); void run(() => getController().addInvoker(agent.id, id)); }}
            >
              {t('agents.scope.addInvoker')}
            </button>
          </div>
        </div>
      )}

      <div className="mt-3" data-testid="agent-mcp-servers">
        <div className="text-meta text-fg-muted">{t('agents.scope.mcp')}</div>
        {registry === null && <p className="mt-1 text-meta text-fg-subtle">{t('agents.scope.mcpLoading')}</p>}
        {registry === 'error' && <p className="mt-1 text-meta text-danger">{t('agents.scope.mcpListFailed')}</p>}
        {Array.isArray(registry) && registry.length === 0 && (
          <p className="mt-1 text-meta text-fg-subtle">{t('agents.scope.mcpNone')}</p>
        )}
        {Array.isArray(registry) && registry.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-3">
            {registry.map((row) => {
              const on = mcpServers.includes(row.name);
              return (
                <li key={row.name}>
                  <label className="flex items-center gap-1 text-meta text-fg">
                    <input
                      type="checkbox"
                      aria-label={row.name}
                      checked={on}
                      disabled={off}
                      onChange={() => {
                        const next = on ? mcpServers.filter((n) => n !== row.name) : [...mcpServers, row.name];
                        void run(() => getController().updateAgent(agent.id, { mcpServers: next }));
                      }}
                    />
                    {row.name}
                    <span className="text-fg-subtle">({t(`mcpServers.kind.${row.credentialKind}`)})</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {error && <p role="alert" className="mt-2 text-meta text-danger" data-testid="agent-scope-error">{error}</p>}
    </div>
  );
}
