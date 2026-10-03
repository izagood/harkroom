/**
 * 에이전트 상세의 **「할 수 있는 일」** 절 — 에이전트 머지 권한(스레드 3deac356, designer 안 L2).
 *
 * 비밀 보관소 부여와 같은 문법이다: 에이전트 × 저장소, 준 사람·날짜, 만료, [거두기]. 판정은 전부 서버가 한다
 * (`grantRoutes.ts` — F1 scope 는 `repo:<owner>/<name>` 만, F2 주는 사람은 그 에이전트의 소유자인 사람, 거두기는
 * 소유자나 admin). 이 화면은 입력을 그대로 보내고 서버의 거절을 사람 말로 옮길 뿐이다 — 판정을 여기 복사하면 한쪽만
 * 고쳐지는 날 조용히 열리는 쪽으로 어긋난다(`AgentScopeSection` 머리 주석과 같은 이유).
 *
 * 카드는 없다. **부여 자체가 승인**이다(jaebin: "내가 권한을 준 에이전트만"). 결과는 서버가 그 스레드에 시스템 줄로
 * 남긴다. 거절 카드의 [권한 주기] 버튼(designer 안)은 1판에서 뺐다 — 서버의 거절 기록·별도 REST 가 먼저다.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AgentView, ApiConnectorView, GrantRow } from '@harkroom/shared';
import { ApiGrantForm } from './ApiGrantForm';
import { repoScope } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { ApiError } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { useLocale } from '../../i18n/useT';
import { ConfirmDialog } from '../ConfirmDialog';
import { hasOperatorLocalSurface } from '../../lib/operatorLocal';
import { MergeGhUserRow } from './MergeGhUserRow';

const CAP = 'repo.merge' as const;
type Expiry = 'none' | '7d' | '30d';

/** `repo:<owner>/<name>` → `owner/name`. 서버가 소문자로 정규화해 돌려준다. */
const repoOf = (scope: string): string => scope.replace(/^repo:/, '');

export function AgentGrantsSection({ agent, canGrant, canRevoke, disabled, localOperatorId }: {
  agent: AgentView;
  /**
   * 이 기기 오퍼레이터의 id(`operator.json` 이 적어 둔 값). 에이전트가 **이 기기에 배정돼 있을 때만** 머지 gh 계정 줄을
   * 그린다 — 머지는 그 에이전트를 돌리는 오퍼레이터의 gh 로 되므로 남의 기기 값을 여기서 고칠 수는 없다.
   */
  localOperatorId?: string | null;
  /** 그 에이전트의 소유자인 사람만 — 서버 F2 와 같다. */
  canGrant: boolean;
  /** 소유자 또는 admin. */
  canRevoke: boolean;
  disabled?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const accounts = useActiveStore((s) => s.accounts);
  const myId = useActiveStore((s) => s.me?.id);
  const [grants, setGrants] = useState<GrantRow[] | 'loading' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reposText, setReposText] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('none');
  const [revoking, setRevoking] = useState<GrantRow | null>(null);
  // API 호출(P4b): 같은 절에 소제목으로 나눈다(designer v3 ③). 연결 이름은 내 연결 목록에서 찾는다 — 없으면 id 앞부분.
  const [apiGrants, setApiGrants] = useState<GrantRow[]>([]);
  const [connectors, setConnectors] = useState<ApiConnectorView[]>([]);
  const [addKind, setAddKind] = useState<'merge' | 'api'>('api');

  const load = useCallback(async () => {
    try {
      const all = await getController().listGrants(agent.id);
      setGrants(all.filter((g) => g.capability === CAP));
      setApiGrants(all.filter((g) => g.capability === 'api.call'));
    } catch { setGrants('error'); }
    try { setConnectors(await getController().listConnectors()); } catch { setConnectors([]); }
  }, [agent.id]);
  useEffect(() => { setGrants('loading'); void load(); }, [load]);

  const explain = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === 'bad_scope') return t('agents.grants.errScope');
      if (err.status === 403) return t('agents.grants.errForbidden');
      if (err.status === 400) return t('agents.grants.errScope');
    }
    return t('agents.grants.errFailed', { reason: err instanceof Error ? err.message : String(err) });
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(explain(e)); } finally { setBusy(false); }
  };

  // 저장소 이름은 **정확한 이름 여러 개**(designer 안) — 쉼표·공백·줄바꿈으로 나눈다. 와일드카드는 없다(서버 F1).
  const repos = [...new Set(reposText.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
  const badRepos = repos.filter((r) => repoScope(r) === null);
  const expiresAt = (): string | null => {
    if (expiry === 'none') return null;
    const days = expiry === '7d' ? 7 : 30;
    return new Date(Date.now() + days * 86_400_000).toISOString();
  };
  const submit = () => run(async () => {
    const at = expiresAt();
    for (const r of repos) await getController().putGrant(agent.id, { capability: CAP, scope: repoScope(r) as string, expiresAt: at });
    setReposText(''); setExpiry('none'); setAdding(false);
  });

  const off = busy || disabled;
  const rows = Array.isArray(grants) ? grants : [];

  return (
    <div className="rounded-row border border-border p-3" data-testid="agent-grants">
      <div className="text-meta font-medium text-fg-muted">{t('agents.grants.heading')}</div>
      <p className="mt-1 text-meta text-fg-subtle">{t('agents.grants.note')}</p>

      {apiGrants.length > 0 && (
        <>
          <div className="mt-2 text-meta font-medium text-fg-muted">{t('apiGrant.heading')}</div>
          <ul className="mt-1 space-y-1" data-testid="agent-api-grants">
            {apiGrants.map((g) => {
              const id = g.scope.replace(/^connector:/, '');
              const c = connectors.find((x) => x.id === id);
              const expired = g.expiresAt !== null && Date.parse(g.expiresAt) <= Date.now();
              const noKey = !!c && c.authKind !== 'none' && !c.secretId;
              const dim = expired || !!g.suspendedAt || noKey;
              const write = (g.limits?.methods ?? []).some((m) => m !== 'GET');
              return (
                <li key={g.scope} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border px-2 py-1 text-meta ${dim ? 'text-fg-subtle' : 'text-fg'}`} data-testid={`agent-api-grant-${c?.name ?? id.slice(0, 8)}`}>
                  <span className="rounded bg-accent-surface px-1 text-accent-text">API</span>
                  <span className="font-mono font-medium">{c?.name ?? id.slice(0, 8)}</span>
                  <span>{write ? t('apiGrant.rowWrite') : t('apiGrant.rowRead')}</span>
                  {g.limits?.pathPrefix && <span className="font-mono text-fg-subtle">{g.limits.pathPrefix}</span>}
                  {write && g.writeNeedsHumanCause && <span className="text-fg-subtle">{t('apiGrant.rowHumanOnly')}</span>}
                  <span className="text-fg-subtle">
                    {t('agents.grants.by', { handle: accounts[g.grantedBy]?.handle ?? g.grantedBy, when: new Date(g.grantedAt).toLocaleDateString(locale) })}
                    {' · '}
                    {g.expiresAt === null ? t('agents.grants.noExpiry') : expired ? t('agents.grants.expired') : t('agents.grants.expiresOn', { when: new Date(g.expiresAt).toLocaleDateString(locale) })}
                  </span>
                  {g.suspendedAt && <span className="rounded bg-warning-surface px-1 text-warning">{t('apiGrant.rowSuspended')}</span>}
                  {noKey && <span className="rounded bg-danger-surface px-1 text-danger">{t('apiGrant.rowNoKey')}</span>}
                  {canRevoke && (
                    <button className="ml-auto rounded border border-border px-2 py-0.5 text-meta text-fg hover:text-danger disabled:opacity-50" disabled={off}
                      aria-label={t('apiGrant.revokeAria', { name: c?.name ?? id.slice(0, 8) })}
                      onClick={() => setRevoking(g)}>{t('agents.grants.revoke')}</button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-2 text-meta font-medium text-fg-muted">{t('apiGrant.mergeHeading')}</div>
        </>
      )}
      {/* 머지 gh 계정(P2) — 소유자인 사람에게만, 이 기기에서 도는 에이전트에만. */}
      {canGrant && hasOperatorLocalSurface() && agent.assignment?.operatorId && (
        localOperatorId && agent.assignment.operatorId === localOperatorId
          ? <MergeGhUserRow disabled={disabled} />
          : <p className="mt-2 text-meta text-fg-subtle" data-testid="merge-gh-user-other">{t('agents.grants.ghUser.otherDevice')}</p>
      )}

      {grants === 'loading' && <p className="mt-2 text-meta text-fg-muted">{t('agents.grants.loading')}</p>}
      {grants === 'error' && <p role="alert" className="mt-2 text-meta text-danger">{t('agents.grants.listFailed')}</p>}
      {Array.isArray(grants) && rows.length === 0 && <p className="mt-2 text-meta text-fg-subtle" data-testid="agent-grants-none">{t('agents.grants.none')}</p>}

      {rows.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="agent-grants-list">
          {rows.map((g) => {
            const repo = repoOf(g.scope);
            const expired = g.expiresAt !== null && Date.parse(g.expiresAt) <= Date.now();
            return (
              <li key={g.scope} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-row border border-border px-2 py-1 text-meta text-fg" data-testid={`agent-grant-${repo}`}>
                <span className="text-fg-muted">{t('agents.grants.merge')}</span>
                <span className="font-mono">{repo}</span>
                <span className="text-fg-subtle">
                  {t('agents.grants.by', { handle: accounts[g.grantedBy]?.handle ?? g.grantedBy, when: new Date(g.grantedAt).toLocaleDateString(locale) })}
                  {' · '}
                  {g.expiresAt === null
                    ? t('agents.grants.noExpiry')
                    : expired ? t('agents.grants.expired') : t('agents.grants.expiresOn', { when: new Date(g.expiresAt).toLocaleDateString(locale) })}
                  {g.allowAgentCause ? ` · ${t('agents.grants.agentCause')}` : ''}
                </span>
                {canRevoke && (
                  <button
                    className="ml-auto rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:text-danger disabled:opacity-50"
                    disabled={off}
                    aria-label={t('agents.grants.revokeAria', { repo })}
                    onClick={() => setRevoking(g)}
                  >
                    {t('agents.grants.revoke')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canGrant && !adding && (
        <button
          className="mt-2 rounded-row border border-border px-2 py-1 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
          disabled={off || grants === 'loading'}
          onClick={() => setAdding(true)}
        >
          {t('agents.grants.add')}
        </button>
      )}
      {!canGrant && canRevoke && <p className="mt-2 text-meta text-fg-subtle">{t('agents.grants.ownerOnly')}</p>}

      {canGrant && adding && (
        <div role="radiogroup" aria-label={t('apiGrant.kind')} className="mt-2 flex gap-2 text-meta">
          <button type="button" role="radio" aria-checked={addKind === 'api'} className={`rounded px-2 py-1 ${addKind === 'api' ? 'bg-accent text-fg-on-strong' : 'border border-border text-fg'}`} onClick={() => setAddKind('api')}>{t('apiGrant.kindApi')}</button>
          <button type="button" role="radio" aria-checked={addKind === 'merge'} className={`rounded px-2 py-1 ${addKind === 'merge' ? 'bg-accent text-fg-on-strong' : 'border border-border text-fg'}`} onClick={() => setAddKind('merge')}>{t('apiGrant.kindMerge')}</button>
        </div>
      )}
      {canGrant && adding && addKind === 'api' && (
        (() => {
          const mine = connectors.filter((c) => c.ownerAccountId === myId);
          const free = mine.filter((c) => !apiGrants.some((g) => g.scope === `connector:${c.id}`));
          // 내 연결이 모두 이미 권한을 가졌으면 「연결이 없다」가 아니라 그 사실을 말한다(designer a).
          return mine.length > 0 && free.length === 0
            ? <p className="mt-2 text-meta text-fg-subtle" data-testid="api-grant-all-granted">{t('apiGrant.allGranted')}</p>
            : <ApiGrantForm agentId={agent.id} connectors={free} onCancel={() => setAdding(false)} onDone={async () => { setAdding(false); await load(); }} />;
        })()
      )}
      {canGrant && adding && addKind === 'merge' && (
        <div className="mt-2 rounded-row border border-border bg-surface-sunken p-2" data-testid="agent-grants-add">
          <label className="flex flex-col gap-1 text-meta text-fg">
            {t('agents.grants.repos')}
            <textarea
              aria-label={t('agents.grants.repos')}
              className="min-h-[3rem] rounded-row border border-border bg-surface px-2 py-1 font-mono text-meta text-fg"
              placeholder={t('agents.grants.reposPlaceholder')}
              disabled={off}
              value={reposText}
              onChange={(e) => setReposText(e.target.value)}
            />
          </label>
          {badRepos.length > 0 && <p className="mt-1 text-meta text-danger">{t('agents.grants.errScope')}: {badRepos.join(', ')}</p>}
          <label className="mt-2 flex items-center gap-2 text-meta text-fg">
            {t('agents.grants.expiry')}
            <select
              aria-label={t('agents.grants.expiry')}
              className="rounded-row border border-border bg-surface px-2 py-1 text-meta text-fg"
              disabled={off}
              value={expiry}
              onChange={(e) => setExpiry(e.target.value as Expiry)}
            >
              <option value="none">{t('agents.grants.expiryNone')}</option>
              <option value="7d">{t('agents.grants.expiry7d')}</option>
              <option value="30d">{t('agents.grants.expiry30d')}</option>
            </select>
          </label>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded-row border border-border bg-accent px-2 py-1 text-meta font-medium text-accent-fg disabled:opacity-50"
              disabled={off || repos.length === 0 || badRepos.length > 0}
              onClick={() => void submit()}
            >
              {t('agents.grants.confirmAdd')}
            </button>
            <button
              className="rounded-row border border-border px-2 py-1 text-meta text-fg hover:bg-surface disabled:opacity-50"
              disabled={off}
              onClick={() => { setAdding(false); setReposText(''); }}
            >
              {t('agents.grants.cancel')}
            </button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-meta text-danger" data-testid="agent-grants-error">{error}</p>}

      {revoking && (
        <ConfirmDialog
          title={revoking.capability === 'api.call'
            ? t('apiGrant.revokeTitle', { name: connectors.find((c) => `connector:${c.id}` === revoking.scope)?.name ?? '' })
            : t('agents.grants.revokeTitle', { repo: repoOf(revoking.scope) })}
          detail={revoking.capability === 'api.call'
            ? t('apiGrant.revokeDetail', { handle: agent.handle })
            : t('agents.grants.revokeDetail', { handle: agent.handle, repo: repoOf(revoking.scope) })}
          confirmLabel={t('agents.grants.revoke')}
          cancelLabel={t('agents.grants.cancel')}
          danger
          busy={busy}
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            const g = revoking;
            setRevoking(null);
            void run(() => getController().deleteGrant(agent.id, g.capability, g.scope));
          }}
        />
      )}
    </div>
  );
}
