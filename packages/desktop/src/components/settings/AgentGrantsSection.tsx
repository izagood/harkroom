/**
 * 에이전트 상세의 **「머지·API 권한」** 절(옛 이름 「할 수 있는 일」 — 이름만 봐서는 무엇을 주는지 몰랐다, 스레드 febe9ff8 P1.
 * #1144 가 API 호출 권한을 같은 절에 소제목으로 더해 「PR 머지」 하나로는 이름이 좁아졌다) — 에이전트 머지 권한(스레드 3deac356, designer 안 L2).
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
import { isOrgRepoScope, repoGrantScope } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { ApiError } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { useLocale } from '../../i18n/useT';
import { ConfirmDialog } from '../ConfirmDialog';
import { hasOperatorLocalSurface } from '../../lib/operatorLocal';
import { ImmediateBadge } from './pendingEdits';
import { MergeAccountCell, MergeDeviceNote, useLocalMerge } from './MergeGhUserRow';
import { Segmented } from '../Segmented';
import { buildForest, decidableBy, descendantCount, pendingForRoot, type ForestNode } from '../../lib/delegationForest';
import { DelegationChildren, PendingDelegations, type DelegationActions } from './DelegationTree';

const CAP = 'repo.merge' as const;
const SECRET_CAP = 'secret.create' as const;
type Expiry = 'none' | '7d' | '30d';

/** `repo:<owner>/<name>` → `owner/name`. 서버가 소문자로 정규화해 돌려준다. */
const repoOf = (scope: string): string => scope.replace(/^repo:/, '');
/** `repo:<owner>/*` 의 owner — 조직 전체 grant 가 아니면 null(jaebin 10-09). */
const orgOf = (scope: string): string | null => isOrgRepoScope(scope) ? scope.slice('repo:'.length, -2) : null;

/** 살아 있는 `repo.merge` grant 수 — 목록 카드의 「머지 N」(P1)과 이 절이 같은 셈을 쓴다. */
export function liveMergeGrantCount(rows: readonly GrantRow[], now = Date.now()): number {
  const c = liveMergeCount(rows, now);
  return c.repos + c.orgs;
}

/** 목록 카드 「머지」 칸의 셈 — 정확한 저장소 grant 와 조직 전체 grant(`owner/*`)를 따로 센다(#1255 designer n3: 「저장소 1개」로 읽히지 않게). */
export interface MergeCount { repos: number; orgs: number }
export function liveMergeCount(rows: readonly GrantRow[], now = Date.now()): MergeCount {
  const live = rows.filter((g) => g.capability === CAP && (g.expiresAt === null || Date.parse(g.expiresAt) > now));
  const orgs = live.filter((g) => isOrgRepoScope(g.scope)).length;
  return { repos: live.length - orgs, orgs };
}

export function AgentGrantsSection({ agent, canGrant, canRevoke, disabled, localOperatorId, assignedOperatorName, deviceAgentIds, onCountChange }: {
  agent: AgentView;
  /** 배정된 오퍼레이터(기기)의 이름 — 「다른 기기에서 돈다」 안내에 넣는다(#1140 designer n4). 모르면 null. */
  assignedOperatorName?: string | null;
  /** 목록을 다시 읽을 때마다 살아 있는 grant 수를 알린다 — 목록 카드 「머지 N」 이 따라오게. */
  onCountChange?: (count: MergeCount) => void;
  /**
   * 이 기기 오퍼레이터의 id(`operator.json` 이 적어 둔 값). 에이전트가 **이 기기에 배정돼 있을 때만** 머지 gh 계정 줄을
   * 그린다 — 머지는 그 에이전트를 돌리는 오퍼레이터의 gh 로 되므로 남의 기기 값을 여기서 고칠 수는 없다.
   */
  localOperatorId?: string | null;
  /**
   * 이 기기에 배정된 내 에이전트 id 들(이 에이전트 포함해도 된다). 머지 gh 계정은 기기 전체 값이라(#1265 security n1) 옛 값
   * 옮기기·같은 owner 이어받기를 이 에이전트들의 머지 줄 전부에 한다. 모르면 이 에이전트 줄만.
   */
  deviceAgentIds?: readonly string[];
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
  const [addKind, setAddKind] = useState<'merge' | 'api' | 'secret'>('api');
  // 비밀 만들기(서버 102, 스레드 1a08d0cf): scope '' 하나, 소유자만 준다. 기본은 꺼짐이다.
  const [secretGrant, setSecretGrant] = useState<GrantRow | null>(null);
  // 위임 나무(P5 desktop): 나무는 에이전트를 건너가므로 **내 에이전트 전부**의 api.call 줄을 모아 엮는다(서버는 parentGrantId 만 준다).
  const [forest, setForest] = useState<Map<string, ForestNode>>(new Map());
  // API 행 [바꾸기](#1144 designer b): 같은 폼을 지금 grant 로 연다 — 거두고 다시 주지 않아도 된다.
  const [changing, setChanging] = useState<string | null>(null);
  const [revokingNode, setRevokingNode] = useState<{ node: ForestNode; below: boolean } | null>(null);
  // 같은 기기의 내 다른 에이전트들의 머지 줄(소문자 owner/name·owner/*). 읽기 전엔 null — 그동안 옮기기를 미룬다(첫 에이전트로만 옮기지 않게).
  const [deviceScopes, setDeviceScopes] = useState<string[] | null>(null);
  const deviceKey = (deviceAgentIds ?? []).filter((id) => id !== agent.id).join(',');

  const load = useCallback(async () => {
    try {
      const all = await getController().listGrants(agent.id);
      const rows = all.filter((g) => g.capability === CAP);
      setGrants(rows);
      setApiGrants(all.filter((g) => g.capability === 'api.call'));
      setSecretGrant(all.find((g) => g.capability === SECRET_CAP && g.scope === '') ?? null);
      // 소유자가 볼 때만 나무를 엮는다 — 남의 에이전트 grant 목록은 서버가 admin·소유자에게만 준다.
      if (canGrant) {
        const st = useActiveStore.getState();
        const mine = Object.values(st.accounts)
          .filter((a) => a.kind === 'agent' && a.id !== agent.id && a.ownerAccountId != null && a.ownerAccountId === st.me?.id)
          .map((a) => a.id);
        const others = await Promise.all(mine.map((id) => getController().listGrants(id).catch(() => [] as GrantRow[])));
        setForest(buildForest([...all, ...others.flat()]));
        const onDevice = new Set(deviceKey ? deviceKey.split(',') : []);
        setDeviceScopes([...new Set(mine.flatMap((id, i) => (onDevice.has(id) ? others[i]! : [])
          .filter((g) => g.capability === CAP).map((g) => repoOf(g.scope).toLowerCase())))]);
      } else {
        setForest(buildForest(all));
        setDeviceScopes([]);
      }
      // 소유자가 볼 때만 알린다(#1146 security n2) — admin 이 남의 에이전트를 열어도 목록 카드에 그 숫자가 끼지 않게.
      if (canGrant) onCountChange?.(liveMergeCount(rows));
    } catch { setGrants('error'); }
    try { setConnectors(await getController().listConnectors()); } catch { setConnectors([]); }
    // `onCountChange` 는 부모가 매 렌더 새로 만든다 — 의존에 넣으면 렌더마다 다시 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, canGrant, deviceKey]);
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

  // 저장소 이름은 **정확한 이름 여러 개**(designer 안) — 쉼표·공백·줄바꿈으로 나눈다. 와일드카드는 조직 전체 `owner/*` 하나뿐이다
  // (jaebin 10-09) — `*`·owner 자리의 `*`·`owner/ab*` 는 서버가 거절한다(F1). 모양 판정은 서버와 같은 `repoGrantScope` 다.
  const repos = [...new Set(reposText.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
  const badRepos = repos.filter((r) => repoGrantScope(r) === null);
  const orgRepos = repos.map((r) => repoGrantScope(r)).filter((s): s is string => !!s && isOrgRepoScope(s)).map((s) => orgOf(s)!);
  /** 사람에게 보일 저장소 이름 — 조직 전체면 「owner 조직 전체」. */
  const repoLabel = (scope: string): string => {
    const org = orgOf(scope);
    return org ? t('agents.grants.orgWide', { owner: org }) : repoOf(scope);
  };
  const expiresAt = (): string | null => {
    if (expiry === 'none') return null;
    const days = expiry === '7d' ? 7 : 30;
    return new Date(Date.now() + days * 86_400_000).toISOString();
  };
  const submit = () => run(async () => {
    const at = expiresAt();
    for (const r of repos) await getController().putGrant(agent.id, { capability: CAP, scope: repoGrantScope(r) as string, expiresAt: at });
    setReposText(''); setExpiry('none'); setAdding(false);
  });

  /** 만료된 줄을 그 저장소 그대로 7일 다시 준다(P1). 서버 판정은 [권한 주기] 와 같다(F1·F2) — 같은 PUT 이다. */
  const renew = (g: GrantRow) => run(async () => {
    await getController().putGrant(agent.id, {
      capability: CAP, scope: g.scope, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      ...(g.allowAgentCause ? { allowAgentCause: true } : {}),
    });
  });

  const off = busy || disabled;
  const delegation: DelegationActions = {
    off: !!off,
    canRevoke,
    canDecide: (n) => !!myId && decidableBy(n, myId),
    revoke: (node) => setRevokingNode({ node, below: false }),
    decide: (node, approve) => void run(() => approve ? getController().approveDelegation(node.grant.id) : getController().declineDelegation(node.grant.id)),
  };
  const pending = canGrant && myId ? pendingForRoot(forest, myId) : [];
  const rows = Array.isArray(grants) ? grants : [];
  // 비어 있으면 한 줄로 접는다(P1) — 설명 문단·빈 문장 없이 「PR 머지 · 머지 권한 없음 · [+ 권한 주기]」. 읽는 동안도
  // 같은 모양으로 그린다(#1146 designer b) — 권한 없는 에이전트를 열 때마다 절이 펼쳤다 줄어드는 흔들림을 없앤다.
  // API 호출 권한(#1144)이 하나라도 있으면 접지 않는다 — 그 줄들이 이 절에 산다.
  const compact = (grants === 'loading' || (Array.isArray(grants) && rows.length === 0 && apiGrants.length === 0 && !secretGrant)) && !adding;
  const otherDevice = assignedOperatorName
    ? t('agents.grants.ghUser.otherDevice', { host: assignedOperatorName })
    : t('agents.grants.ghUser.otherDeviceNoName');
  // 머지 gh 계정은 줄마다다(스레드 e085b6a7). 이 기기에 배정된 내 에이전트이고 머지 권한 줄이 있을 때만 오퍼레이터를 묻는다 —
  // 다른 기기면 그 기기의 gh 목록을 여기서 볼 수 없으므로 안내만 둔다(시안 §3 F).
  const assigned = canGrant && hasOperatorLocalSurface() && !!agent.assignment?.operatorId;
  const onThisDevice = assigned && !!localOperatorId && agent.assignment!.operatorId === localOperatorId;
  const { state: localMerge, reach: mergeReach, setScope } = useLocalMerge(
    onThisDevice && rows.length > 0 && deviceScopes !== null ? rows.map((g) => repoOf(g.scope).toLowerCase()) : null,
    deviceScopes ?? [],
  );
  const ghRow = assigned ? (
    onThisDevice
      ? <MergeDeviceNote state={localMerge} />
      : <p className="mt-2 text-meta text-fg-subtle" data-testid="merge-gh-user-other">{otherDevice}</p>
  ) : null;

  // 제목은 이웃 FieldGroup(「실행」·「권한」)과 같은 단이다 — 테두리 상자 없이 h3(#1146 designer 수정 1). 작은 회색
  // 제목이면 이름을 고치고 자리를 올려도 다시 놓친다(f1).
  const heading = <h3 className="text-body font-semibold text-fg">{t('agents.grants.heading')}<ImmediateBadge label={t('agents.detail.immediate')} /></h3>;

  if (compact) {
    // 접힌 동안은 gh 계정 줄을 그리지 않는다(#1146 designer c) — [정하기]와 [+ 권한 주기]가 오른쪽 끝에 겹쳐 서지
    // 않게. 첫 권한을 주면 펼쳐지며 그 줄이 처음 보인다. 막는 힘은 래퍼(`no_gh_user`)에 있다.
    return (
      <section data-testid="agent-grants">
        <div className="flex flex-wrap items-baseline gap-2">
          {heading}
          {grants === 'loading'
            ? <span className="text-meta text-fg-subtle" data-testid="agent-grants-loading">{t('agents.grants.loading')}</span>
            : <span className="text-meta text-fg-subtle" data-testid="agent-grants-none">{t('agents.grants.noneShort')}</span>}
          {canGrant && (
            <button
              className="ml-auto rounded-row border border-border px-2 py-0.5 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
              disabled={off || grants === 'loading'}
              onClick={() => setAdding(true)}
            >
              {t('agents.grants.add')}
            </button>
          )}
        </div>
        {!canGrant && canRevoke && <p className="mt-1 text-meta text-fg-subtle">{t('agents.grants.ownerOnly')}</p>}
        {error && <p role="alert" className="mt-2 text-meta text-danger" data-testid="agent-grants-error">{error}</p>}
      </section>
    );
  }

  return (
    <section data-testid="agent-grants">
      {heading}
      <p className="text-meta text-fg-subtle">{t('agents.grants.note')}</p>
      <PendingDelegations pending={pending} accounts={accounts} connectors={connectors} a={delegation} />

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
              const node = g.id ? forest.get(g.id) : undefined;
              const below = node ? descendantCount(node) : 0;
              return (
                <li key={g.scope} className="space-y-0">
                <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border px-2 py-1 text-meta ${dim ? 'text-fg-subtle' : 'text-fg'}`} data-testid={`agent-api-grant-${c?.name ?? id.slice(0, 8)}`}>
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
                  {canGrant && c && c.ownerAccountId === myId && (
                    <button className="ml-auto rounded border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50" disabled={off}
                      data-testid={`api-grant-change-${c.name}`} aria-expanded={changing === g.scope}
                      onClick={() => setChanging(changing === g.scope ? null : g.scope)}>{t('apiGrant.replace')}</button>
                  )}
                  {canRevoke && (
                    <button className={`${canGrant && c && c.ownerAccountId === myId ? '' : 'ml-auto '}rounded border border-border px-2 py-0.5 text-meta text-fg hover:text-danger disabled:opacity-50`} disabled={off}
                      aria-label={t('apiGrant.revokeAria', { name: c?.name ?? id.slice(0, 8) })}
                      onClick={() => setRevoking(g)}>{t('agents.grants.revoke')}</button>
                  )}
                  {node?.parent && <span className="basis-full text-fg-subtle" data-testid={`delegation-from-${g.id}`}>{t('apiGrant.from', { handle: accounts[node.parent.agentId]?.handle ?? node.parent.agentId.slice(0, 8) })}</span>}
                  {(g.delegateDepth ?? 0) > 0 && <span className="text-fg-subtle">{t('apiGrant.depthLeft', { n: String(g.delegateDepth) })}</span>}
                  {canRevoke && node && below > 0 && (
                    <button className="rounded border border-border px-2 py-0.5 text-meta text-fg hover:text-danger disabled:opacity-50" disabled={off}
                      data-testid={`delegation-revoke-below-${g.id}`}
                      onClick={() => setRevokingNode({ node, below: true })}>{t('apiGrant.revokeBelow')}</button>
                  )}
                </div>
                {changing === g.scope && c && (
                  <ApiGrantForm agentId={agent.id} connectors={[c]} existing={g} onCancel={() => setChanging(null)} onDone={async () => { setChanging(null); await load(); }} />
                )}
                {node && <DelegationChildren node={node} accounts={accounts} a={delegation} />}
                </li>
              );
            })}
          </ul>
          {/* 비밀 만들기 줄이 있으면 그 블록이 「PR 머지」 소제목을 단다 — 두 번 서지 않게. */}
          {!secretGrant && <div className="mt-2 text-meta font-medium text-fg-muted">{t('apiGrant.mergeHeading')}</div>}
        </>
      )}
      {secretGrant && (
        <>
          <div className="mt-2 text-meta font-medium text-fg-muted">{t('agents.grants.secretCreateHeading')}</div>
          <ul className="mt-1 space-y-1">
            {/* 소제목이 이미 「비밀 만들기」다 — 줄 첫 칸은 상태를 말한다(designer n1). 모서리는 바로 위 API 줄과 같은 rounded. */}
            <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border px-2 py-1 text-meta text-fg" data-testid="agent-secret-create-grant">
              <span className="text-fg-muted">{t('agents.grants.secretCreateOn')}</span>
              <span className="text-fg-subtle">
                {t('agents.grants.by', { handle: accounts[secretGrant.grantedBy]?.handle ?? secretGrant.grantedBy, when: new Date(secretGrant.grantedAt).toLocaleDateString(locale) })}
                {' · '}{t('agents.grants.noExpiry')}
              </span>
              {canRevoke && (
                <button className="ml-auto rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:text-danger disabled:opacity-50" disabled={off}
                  onClick={() => setRevoking(secretGrant)}>{t('agents.grants.revoke')}</button>
              )}
            </li>
          </ul>
          <div className="mt-2 text-meta font-medium text-fg-muted">{t('apiGrant.mergeHeading')}</div>
        </>
      )}
      {/* 머지 gh 계정(P2) — 소유자인 사람에게만, 이 기기에서 도는 에이전트에만. */}
      {ghRow}

      {grants === 'loading' && <p className="mt-2 text-meta text-fg-muted">{t('agents.grants.loading')}</p>}
      {grants === 'error' && <p role="alert" className="mt-2 text-meta text-danger">{t('agents.grants.listFailed')}</p>}
      {Array.isArray(grants) && rows.length === 0 && <p className="mt-2 text-meta text-fg-subtle" data-testid="agent-grants-none">{t('agents.grants.none')}</p>}

      {rows.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="agent-grants-list">
          {rows.map((g) => {
            const repo = repoOf(g.scope);
            const expired = g.expiresAt !== null && Date.parse(g.expiresAt) <= Date.now();
            // #1255 security n2: 서버는 정확한 이름과 조직 grant 가 겹치면 **넓게 허락하는 쪽**(allow_agent_cause)을 쓴다. 이 줄은 꺼져
            // 있어도 살아 있는 조직 grant 가 켜져 있으면 실제로는 에이전트가 띄운 턴에서도 머지된다 — 그 사실을 이 줄에 적는다.
            // 배포 저장소는 조직 grant 로 열리지 않는다(#1255) — 서버가 그 줄에 deployRepo 를 실으면 붙이지 않는다(#1258 designer d1).
            const coveringOrg = !g.allowAgentCause && !orgOf(g.scope) && !g.deployRepo
              ? rows.find((o) => orgOf(o.scope) !== null && o.allowAgentCause && repo.startsWith(`${orgOf(o.scope)}/`)
                && (o.expiresAt === null || Date.parse(o.expiresAt) > Date.now()))
              : undefined;
            return (
              // 만료된 줄은 통째로 한 단 낮춘다(지난 nit n4) — 살아 있는 줄과 같은 무게로 보이지 않게. [거두기]는 정리용으로 둔다.
              <li key={g.scope} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-row border border-border px-2 py-1 text-meta ${expired ? 'text-fg-subtle' : 'text-fg'}`} data-testid={`agent-grant-${repo}`} data-expired={expired || undefined}>
                {/* 부여 종류 이름은 두되 한 단 낮춘다(지난 nit n3) — 지금 주인공은 저장소다. */}
                <span className="text-fg-muted">{t('agents.grants.merge')}</span>
                <span className="font-mono">{repo}</span>
                {orgOf(g.scope) && (
                  <span className="rounded-row border border-warning-border bg-warning-surface px-1 text-warning" data-testid={`agent-grant-org-${orgOf(g.scope)}`}>
                    {t('agents.grants.orgWideBadge')}
                  </span>
                )}
                {localMerge !== null && typeof localMerge === 'object' && (
                  <MergeAccountCell scope={repo.toLowerCase()} repoLabel={repoLabel(g.scope)} state={localMerge} reach={mergeReach[repo.toLowerCase()]} setScope={setScope} disabled={off} />
                )}
                {/* 메타(by·날짜·만료)는 둘째 줄로 내린다(시안 §1) — 계정 칸이 들어갈 자리를 만든다. */}
                <span className="order-last basis-full text-fg-subtle">
                  {t('agents.grants.by', { handle: accounts[g.grantedBy]?.handle ?? g.grantedBy, when: new Date(g.grantedAt).toLocaleDateString(locale) })}
                  {' · '}
                  {g.expiresAt === null
                    ? t('agents.grants.noExpiry')
                    : expired ? t('agents.grants.expired') : t('agents.grants.expiresOn', { when: new Date(g.expiresAt).toLocaleDateString(locale) })}
                  {g.allowAgentCause ? ` · ${t('agents.grants.agentCause')}` : ''}
                  {coveringOrg && <span data-testid={`agent-grant-cause-via-org-${repo}`}>{` · ${t('agents.grants.agentCauseViaOrg', { owner: orgOf(coveringOrg.scope)! })}`}</span>}
                </span>
                {expired && canGrant && (
                  <button
                    className="ml-auto rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50"
                    disabled={off}
                    aria-label={t('agents.grants.renewAria', { repo: repoLabel(g.scope) })}
                    onClick={() => void renew(g)}
                  >
                    {t('agents.grants.renew7d')}
                  </button>
                )}
                {canRevoke && (
                  <button
                    className={`${expired && canGrant ? '' : 'ml-auto '}rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:text-danger disabled:opacity-50`}
                    disabled={off}
                    aria-label={t('agents.grants.revokeAria', { repo: repoLabel(g.scope) })}
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
        <Segmented label={t('apiGrant.kind')} showLabel={false} className="mt-2" value={addKind} onChange={setAddKind}
          options={[
            { value: 'api' as const, label: t('apiGrant.kindApi') },
            { value: 'merge' as const, label: t('apiGrant.kindMerge') },
            // 비밀 만들기는 이미 주었으면 고를 칸에서 뺀다(한 줄뿐이다).
            ...(secretGrant ? [] : [{ value: 'secret' as const, label: t('apiGrant.kindSecret') }]),
          ]} />
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
      {canGrant && adding && addKind === 'secret' && !secretGrant && (
        <div className="mt-2 rounded-row border border-border bg-surface-sunken p-2" data-testid="agent-secret-create-add">
          <p className="text-meta text-fg">{t('agents.grants.secretCreateNote')}</p>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded-row border border-border bg-accent px-2 py-1 text-meta font-medium text-accent-fg disabled:opacity-50"
              disabled={off}
              onClick={() => void run(async () => {
                await getController().putGrant(agent.id, { capability: SECRET_CAP, scope: '', expiresAt: null });
                setAdding(false);
              })}
            >
              {t('agents.grants.secretCreateConfirm')}
            </button>
            <button className="rounded-row border border-border px-2 py-1 text-meta text-fg hover:bg-surface disabled:opacity-50" disabled={off} onClick={() => setAdding(false)}>
              {t('agents.grants.cancel')}
            </button>
          </div>
        </div>
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
          {orgRepos.length > 0 && (
            <p className="mt-1 text-meta text-warning" data-testid="agent-grants-org-warning">
              {t('agents.grants.orgWideWarning', { owners: orgRepos.join(', ') })}
            </p>
          )}
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

      {revokingNode && (() => {
        const { node, below } = revokingNode;
        const n = descendantCount(node);
        const handle = accounts[node.agentId]?.handle ?? node.agentId.slice(0, 8);
        return (
          <ConfirmDialog
            title={below ? t('apiGrant.revokeBelowTitle', { n: String(n) }) : t('apiGrant.revokeChildTitle', { handle })}
            detail={below ? t('apiGrant.revokeBelowDetail', { handle }) : t('apiGrant.revokeChildDetail', { handle, n: String(n) })}
            confirmLabel={t('agents.grants.revoke')}
            cancelLabel={t('agents.grants.cancel')}
            danger
            busy={busy}
            onCancel={() => setRevokingNode(null)}
            onConfirm={() => {
              setRevokingNode(null);
              // 아래 줄은 FK cascade 로 함께 지워진다 — [이 아래 전부]는 바로 아래 줄들만 지우면 된다. 이 줄 자신은 남긴다.
              const targets = below ? node.children : [node];
              void run(async () => { for (const c of targets) await getController().deleteGrant(c.agentId, 'api.call', c.grant.scope); });
            }}
          />
        );
      })()}
      {revoking && (
        <ConfirmDialog
          title={revoking.capability === SECRET_CAP
            ? t('agents.grants.secretCreateRevokeTitle', { handle: agent.handle })
            : revoking.capability === 'api.call'
            ? t('apiGrant.revokeTitle', { name: connectors.find((c) => `connector:${c.id}` === revoking.scope)?.name ?? '' })
            : t('agents.grants.revokeTitle', { repo: repoLabel(revoking.scope) })}
          detail={revoking.capability === SECRET_CAP
            ? t('agents.grants.secretCreateRevokeDetail')
            : revoking.capability === 'api.call'
            ? t('apiGrant.revokeDetail', { handle: agent.handle })
            : orgOf(revoking.scope)
            // #1255 designer n1: 조직 grant 를 거둬도 같은 조직에 정확한 이름으로 따로 준 권한은 남는다 — 「조직 전체 머지가 막힌다」고 하지 않는다.
            ? t('agents.grants.revokeDetailOrg', { handle: agent.handle, owner: orgOf(revoking.scope)! })
            : t('agents.grants.revokeDetail', { handle: agent.handle, repo: repoLabel(revoking.scope) })}
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
    </section>
  );
}
