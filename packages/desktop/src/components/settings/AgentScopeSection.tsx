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
import { useState } from 'react';
import { CREDENTIAL_SCOPES, INVOKE_SCOPES, type AgentView, type CredentialScope, type InvokeScope } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { ApiError } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { AgentMcpSection } from './AgentMcpSection';
import { ImmediateBadge } from './pendingEdits';
import { Toggle } from './primitives';

export function AgentScopeSection({ agent, agents = [], disabled, onUpdated }: {
  agent: AgentView;
  /** 대리 호출자 후보를 고를 목록 — 상세 화면이 이미 받아 둔 `listAgents()` 결과다(새 왕복 없음). */
  agents?: AgentView[];
  disabled?: boolean;
  onUpdated: (next: AgentView) => void;
}) {
  const t = useT();
  const accounts = useActiveStore((s) => s.accounts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [pickDelegate, setPickDelegate] = useState('');

  const explain = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === 'scope_invariant') return t('agents.scope.errInvariant');
      if (err.code === 'scope_widening') return t('agents.scope.errWidening');
      if (err.code === 'unknown_mcp_server') return t('agents.scope.errUnknownMcp');
      if (err.code === 'delegate_not_eligible') return t('agents.scope.errDelegate');
    }
    return t('agents.scope.errFailed', { reason: err instanceof Error ? err.message : String(err) });
  };
  const run = async (fn: () => Promise<AgentView>) => {
    setBusy(true); setError(null);
    try { onUpdated(await fn()); } catch (e) { setError(explain(e)); } finally { setBusy(false); }
  };

  // 옛 서버(스코프 마이그레이션 전)는 이 두 필드를 주지 않는다 — 없으면 빈 목록으로 그린다.
  const invokers = agent.invokers ?? [];
  const humans = Object.values(accounts).filter((a) => a.kind === 'human' && !invokers.includes(a.id));
  const off = busy || disabled;
  /*
    대리 호출자 후보(서버 073). 서버와 **같은 조건**으로 거른다 — 같은 소유자·그 에이전트도 owner.
    판정은 서버가 넣을 때·부를 때 다시 한다; 여기서 거르는 것은 넣으면 400 이 날 줄을 애초에
    보이지 않게 하려는 것뿐이다(고르고 나서 거절당하면 "왜 안 되나"를 사람이 캐야 한다).
  */
  const delegates = agent.delegates ?? [];
  const delegateCandidates = agents.filter((a) => a.id !== agent.id && !delegates.includes(a.id)
    && a.invokeScope === 'owner' && agent.ownerAccountId != null && a.ownerAccountId === agent.ownerAccountId);
  /*
    형제 기본 신뢰(서버 083). 켜져 있으면 같은 소유자의 owner 에이전트는 명단 없이 부르므로 명단을
    그리지 않는다 — 보이면 "여기 없는 에이전트는 못 부른다"로 읽힌다. 옛 서버는 필드를 주지 않고
    (undefined) PATCH 의 모르는 키를 조용히 버리므로, 그때는 스위치를 그리지 않고 명단만 그린다.
  */
  const trustKnown = agent.trustSiblings !== undefined;
  const showDelegates = agent.trustSiblings !== true;

  return (
    <div className="rounded-row border border-border p-3" data-testid="agent-scope">
      {/*
        **한 줄 요약 + 펼치기**(UX ⑨b, designer 사양 ⑨: "부를 수 있는 곳은 한 줄로 요약"). 상세 화면에서 이 절은
        고르는 칸이 넷(부르는 사람·자격증명·명단·대리 호출자)에 MCP 까지 서서 가장 길었다 — 대부분은 읽기만
        한다. 지금 값은 접혀 있어도 요약 줄이 말하고, 고칠 때만 편다. 오류는 접힘 밖에 둔다(아래).
      */}
      {/* **펼친 채 시작한다**(jaebin, 설정 폭 승인 때). 접혀 있으면 누가 부를 수 있는지가 화면에서 사라진다 —
          권한 탭에서 가장 먼저 읽혀야 할 것이다. 접는 손잡이는 그대로 둔다. 안의 값은 전부터 DOM 에 있었다. */}
      <details open data-testid="agent-scope-details" className="group">
      <summary className="cursor-pointer list-none">
        <div className="text-meta font-medium text-fg-muted">{t('agents.scope.heading')}<ImmediateBadge label={t('agents.detail.immediate')} /> <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-180">▾</span></div>
        <p data-testid="agent-scope-summary" className="mt-1 text-meta text-fg">
          {[
            t(`agents.scope.invoke.${agent.invokeScope}`),
            t(`agents.scope.credential.${agent.credentialScope}`),
            ...(agent.invokeScope === 'list' ? [t('agents.scope.summaryInvokers', { count: String(invokers.length) })] : []),
            ...(delegates.length ? [t('agents.scope.summaryDelegates', { count: String(delegates.length) })] : []),
            // MCP 절도 이 접힘 안이다 — 접힌 채로 몇 개 붙었는지 말한다(designer #1059).
            ...((agent.mcpServers ?? []).length ? [t('agents.scope.summaryMcp', { count: String((agent.mcpServers ?? []).length) })] : []),
          ].join(' · ')}
        </p>
      </summary>
      <p className="mt-1 text-meta text-fg-subtle">{t('agents.scope.note')}</p>

      <div className="mt-2 flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-meta text-fg">
          {t('agents.scope.invoke')}
          <select
            aria-label={t('agents.scope.invoke')}
            className="rounded-row border border-border bg-surface px-2 py-1 text-meta text-fg"
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
            className="rounded-row border border-border bg-surface px-2 py-1 text-meta text-fg"
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
              <li key={id} className="flex items-center gap-1 rounded-row border border-border px-2 py-0.5 text-meta text-fg">
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
              onClick={() => { const id = pick; setPick(''); void run(() => getController().addInvoker(agent.id, id)); }}
            >
              {t('agents.scope.addInvoker')}
            </button>
          </div>
        </div>
      )}

      {agent.invokeScope === 'owner' && trustKnown && (
        <div className="-mx-4 mt-2 text-meta" data-testid="agent-trust-siblings">
          <Toggle
            label={t('agents.scope.trustSiblings')}
            description={t(agent.trustSiblings ? 'agents.scope.trustSiblingsOn' : 'agents.scope.trustSiblingsOff')}
            checked={agent.trustSiblings === true}
            disabled={off}
            onChange={(trustSiblings) => void run(() => getController().updateAgent(agent.id, { trustSiblings }))}
          />
        </div>
      )}

      {agent.invokeScope === 'owner' && showDelegates && (
        <div className="mt-3" data-testid="agent-delegates">
          <div className="text-meta text-fg-muted">{t('agents.scope.delegates')}</div>
          <p className="mt-1 text-meta text-fg-subtle">{t('agents.scope.delegatesNote')}</p>
          {delegates.length === 0 && <p className="mt-1 text-meta text-fg-subtle">{t('agents.scope.delegatesNone')}</p>}
          <ul className="mt-1 flex flex-wrap gap-2">
            {delegates.map((id) => (
              <li key={id} className="flex items-center gap-1 rounded-row border border-border px-2 py-0.5 text-meta text-fg">
                @{accounts[id]?.handle ?? id}
                <button
                  className="text-fg-subtle hover:text-danger"
                  aria-label={t('agents.scope.removeDelegate', { handle: accounts[id]?.handle ?? id })}
                  disabled={off}
                  onClick={() => void run(() => getController().removeDelegate(agent.id, id))}
                >×</button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <select
              aria-label={t('agents.scope.addDelegate')}
              className="rounded-row border border-border bg-surface px-2 py-1 text-meta text-fg"
              disabled={off || delegateCandidates.length === 0}
              value={pickDelegate}
              onChange={(e) => setPickDelegate(e.target.value)}
            >
              <option value="">{t(delegateCandidates.length ? 'agents.scope.pickAgent' : 'agents.scope.noDelegateCandidates')}</option>
              {delegateCandidates.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
            </select>
            <button
              className="rounded-row border border-border px-2 py-1 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
              disabled={off || !pickDelegate}
              onClick={() => { const id = pickDelegate; setPickDelegate(''); void run(() => getController().addDelegate(agent.id, id)); }}
            >
              {t('agents.scope.addInvoker')}
            </button>
          </div>
        </div>
      )}

      {/* MCP 는 한 절에서 끝낸다(레지스트리·이 머신 정의·scope) — `AgentMcpSection` 머리 주석. */}
      <AgentMcpSection agent={agent} disabled={disabled} onUpdated={onUpdated} />
      </details>

      {error && <p role="alert" className="mt-2 text-meta text-danger" data-testid="agent-scope-error">{error}</p>}
    </div>
  );
}
