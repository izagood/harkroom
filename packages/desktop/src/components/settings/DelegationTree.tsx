import type { ApiConnectorView } from '@harkroom/shared';
import { useLocale, useT } from '../../i18n/useT';
import { blockedReason, type ForestNode } from '../../lib/delegationForest';

/**
 * 위임 나무의 아래 줄과 「허락 기다림 N」(외부 API P5 desktop, designer v3 ③-2 · security #1157 메모). 판정은 서버다 —
 * 「사슬 막힘」은 표시이고, [허락]·[거절]·[거두기]는 서버가 다시 잰다(루트 사람만·소유자만).
 */
type Accounts = Record<string, { handle: string } | undefined>;

export interface DelegationActions {
  /** 이 줄 하나(와 그 아래)를 거둔다. */
  revoke(node: ForestNode): void;
  decide(node: ForestNode, approve: boolean): void;
  off: boolean;
  canRevoke: boolean;
  /** 대기 줄을 허락·거절할 수 있나 — 서버는 루트 사람만 받는다. */
  canDecide(node: ForestNode): boolean;
}

const handleOf = (accounts: Accounts, id: string) => accounts[id]?.handle ?? id.slice(0, 8);

function Scope({ node }: { node: ForestNode }) {
  const t = useT();
  const locale = useLocale();
  const g = node.grant;
  const write = (g.limits?.methods ?? []).some((m) => m !== 'GET');
  return (
    <>
      <span>{write ? t('apiGrant.rowWrite') : t('apiGrant.rowRead')}</span>
      {g.limits?.pathPrefix && <span className="font-mono text-fg-subtle">{g.limits.pathPrefix}</span>}
      <span className="text-fg-subtle">
        {g.expiresAt === null ? t('agents.grants.noExpiry') : t('agents.grants.expiresOn', { when: new Date(g.expiresAt).toLocaleDateString(locale) })}
      </span>
      {(g.delegateDepth ?? 0) > 0 && <span className="text-fg-subtle">{t('apiGrant.depthLeft', { n: String(g.delegateDepth) })}</span>}
    </>
  );
}

function DecideButtons({ node, a }: { node: ForestNode; a: DelegationActions }) {
  const t = useT();
  if (!a.canDecide(node)) return null;
  return (
    <span className="ml-auto flex gap-1">
      <button type="button" className="rounded bg-accent px-2 py-0.5 font-medium text-fg-on-strong disabled:opacity-50" disabled={a.off}
        data-testid={`delegation-approve-${node.grant.id}`} onClick={() => a.decide(node, true)}>{t('apiGrant.approve')}</button>
      <button type="button" className="rounded border border-border px-2 py-0.5 text-fg hover:text-danger disabled:opacity-50" disabled={a.off}
        data-testid={`delegation-decline-${node.grant.id}`} onClick={() => a.decide(node, false)}>{t('apiGrant.decline')}</button>
    </span>
  );
}

/** 한 마디 아래로 다시 준 줄들 — 들여 쓴 나무. 막힌 줄은 흐리게, 줄마다 [거두기]. */
export function DelegationChildren({ node, accounts, a, level = 1 }: { node: ForestNode; accounts: Accounts; a: DelegationActions; level?: number }) {
  const t = useT();
  if (!node.children.length) return null;
  return (
    <ul className="mt-1 space-y-1" data-testid={`delegation-children-${node.grant.id}`}>
      {node.children.map((c) => {
        const why = blockedReason(c);
        return (
          <li key={c.grant.id} style={{ marginLeft: `${level * 1.25}rem` }}>
            <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-dashed border-border px-2 py-1 text-meta ${why ? 'text-fg-subtle' : 'text-fg'}`}
              data-testid={`delegation-row-${c.grant.id}`} data-blocked={why ?? undefined}>
              <span aria-hidden>↳</span>
              <span className="font-medium">@{handleOf(accounts, c.agentId)}</span>
              <Scope node={c} />
              {why === 'pending' && <span className="rounded bg-warning-surface px-1 text-warning">{t('apiGrant.pendingBadge')}</span>}
              {why === 'chain' && <span className="rounded bg-surface-sunken px-1">{t('apiGrant.blockedChain')}</span>}
              {why === 'pending'
                ? <DecideButtons node={c} a={a} />
                : a.canRevoke && (
                  <button type="button" className="ml-auto rounded border border-border px-2 py-0.5 text-fg hover:text-danger disabled:opacity-50" disabled={a.off}
                    aria-label={t('apiGrant.revokeChildAria', { handle: handleOf(accounts, c.agentId) })}
                    onClick={() => a.revoke(c)}>{t('agents.grants.revoke')}</button>
                )}
            </div>
            <DelegationChildren node={c} accounts={accounts} a={a} level={level + 1} />
          </li>
        );
      })}
    </ul>
  );
}

/** 「허락 기다림 N」 — 절 맨 위. 대기 줄은 알림 없이 생길 수 있어서(서버가 원인 글을 확인하지 못한 경우) 여기 모아 보인다. */
export function PendingDelegations({ pending, accounts, connectors, a }: { pending: ForestNode[]; accounts: Accounts; connectors: ApiConnectorView[]; a: DelegationActions }) {
  const t = useT();
  if (!pending.length) return null;
  return (
    <div className="mt-2 rounded border border-warning-border bg-warning-surface p-2 text-meta" data-testid="delegation-pending">
      <div className="font-medium text-warning">{t('apiGrant.pendingHeading', { n: String(pending.length) })}</div>
      <ul className="mt-1 space-y-1">
        {pending.map((n) => {
          const name = connectors.find((c) => `connector:${c.id}` === n.grant.scope)?.name ?? n.grant.scope.replace(/^connector:/, '').slice(0, 8);
          return (
            <li key={n.grant.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-fg" data-testid={`delegation-pending-${n.grant.id}`}>
              <span>{t('apiGrant.pendingLine', { from: n.parent ? handleOf(accounts, n.parent.agentId) : '?', to: handleOf(accounts, n.agentId) })}</span>
              <span className="font-mono font-medium">{name}</span>
              <Scope node={n} />
              <DecideButtons node={n} a={a} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
