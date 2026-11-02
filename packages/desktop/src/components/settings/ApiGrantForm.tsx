import { Segmented } from '../Segmented';
import { useState } from 'react';
import { connectorScope, type ApiConnectorView, type ApiMethod, type GrantRow } from '@harkroom/shared';
import { useLocale } from '../../i18n/useT';
import { getController } from '../../state/controller';
import { ApiError } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { errorText } from '../../lib/errorText';

/**
 * 에이전트에게 `api.call` 을 주는 폼(외부 API 권한 C안 P4b, designer v3 ③·④). 「할 수 있는 일」의 [+ 권한 주기]와 막힘 카드의
 * [권한 주기…] 대화상자가 **같은 폼**을 쓴다 — 두 벌이면 한쪽만 고쳐져 카드에서 주는 권한이 더 넓어지는 날이 온다.
 *
 * - 범위: 읽기만(GET) / 읽기+쓰기(연결이 허용한 메서드 전부). 경로는 이것으로 시작하는 것만.
 * - 만료: 7일(기본)·30일·만료 없음. 읽기+쓰기의 「만료 없음」은 **설정 화면에서만**(`allowWriteNoExpiry`) 생기고, 경고와 확인 체크를
 *   지나야 [주기]가 켜진다(소유자 결정 · security 설계 판정, 2026-11-02). 경고 내용이 바뀌면(범위·만료·「사람 글 턴만」) 체크는
 *   다시 빈 칸이 된다 — 사람은 지금 보이는 경고를 확인해야 한다. 막힘 카드에서는 띄우지 않는다 — 막힌 순간 버튼 하나로 무기한 쓰기가 생기지 않게.
 *   서버는 날짜로 주는 쓰기 만료의 30일 상한(F3)을 그대로 지킨다.
 * - **「쓰기는 사람 글 턴만」은 기본값이 없다**(소유자 지시) — 쓰기를 고르면 예/아니오를 사람이 골라야 [주기]가 켜진다.
 * - 판정은 서버다(소유자만, 내 연결만, limits ⊆ 연결). 화면은 거절을 사람 말로 옮긴다.
 */
export interface ApiGrantInitial {
  connectorId: string;
  /** 막힌 요청이 GET 이면 'read' — 막힌 요청보다 넓게 채우지 않는다(designer ④). */
  scope: 'read' | 'write';
  pathPrefix: string;
}

type Expiry = '7d' | '30d' | 'none' | 'keep';

/**
 * - `existing`: 이 에이전트가 그 연결에 이미 가진 grant(security L2·designer D1). grant 는 (에이전트, 연결)마다 한 줄이고 PUT 은
 *   upsert 라 **주면 지금 권한을 대신한다** — 그래서 「지금 → 바꿀 값」을 위에 보이고 버튼 이름을 [바꾸기]로 한다. 넓히기·합치기는 없다.
 * - `initial` 이 없고 `existing` 이 있으면 지금 값으로 연다(카드의 [설정 바꾸기…], designer D2). 만료는 「지금 만료 유지」가 기본.
 * - `initial.pathPrefix` 가 빈 글자면 막힌 경로를 모르는 것이다(security L1) — 칸을 비워 두고 사람이 적기 전엔 [주기]가 꺼진다.
 */
export function ApiGrantForm({ agentId, connectors, initial, existing = null, allowWriteNoExpiry = false, editMode = false, delegatedCount = 0, onDone, onCancel }: {
  agentId: string;
  /**
   * 설정 화면의 [고치기] — 지금 부여를 그 자리에서 고친다(같은 부여 id, 서버가 전→후를 감사한다). 범위·경로도 바꿀 수 있고,
   * 바뀐 칸만 보인다. 막힘 카드의 [설정 바꾸기…]는 false 다(그쪽은 범위·경로를 잠근다, security F1).
   */
  editMode?: boolean;
  /** 이 부여에서 다른 에이전트에게 넘긴 하위 부여 수 — 좁히면 끊길 수 있음을 알린다. */
  delegatedCount?: number;
  /** 읽기+쓰기에 「만료 없음」을 띄운다 — 설정 › 에이전트 › 권한 화면만 true(막힘 카드는 false). */
  allowWriteNoExpiry?: boolean;
  existing?: GrantRow | null;
  /** 고를 수 있는 연결 — 내 것만(서버 규칙과 같다). */
  connectors: ApiConnectorView[];
  initial?: ApiGrantInitial;
  onDone(): void | Promise<void>;
  onCancel(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const exWrite = (existing?.limits?.methods ?? []).some((m) => m !== 'GET');
  const fromExisting = !initial && !!existing;
  const [connectorId, setConnectorId] = useState(initial?.connectorId ?? existing?.scope.replace(/^connector:/, '') ?? connectors[0]?.id ?? '');
  const [scope, setScope] = useState<'read' | 'write'>(initial?.scope ?? (fromExisting && exWrite ? 'write' : 'read'));
  const [pathPrefix, setPathPrefix] = useState(initial?.pathPrefix ?? existing?.limits?.pathPrefix ?? '/');
  const [expiry, setExpiry] = useState<Expiry>(fromExisting ? 'keep' : '7d');
  const [humanOnly, setHumanOnly] = useState<'yes' | 'no' | null>(fromExisting && exWrite ? (existing?.writeNeedsHumanCause ? 'yes' : 'no') : null);
  const [busy, setBusy] = useState(false);
  const [noExpiryConfirmed, setNoExpiryConfirmed] = useState(false);
  // 경고가 넓어지거나 사라졌다 다시 뜨면 확인을 다시 받는다(designer 고칠 것 1) — 이전 확인은 다른 내용에 대한 것이다.
  const confirmKey = `${connectorId}|${scope}|${expiry}|${humanOnly ?? ''}`;
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  if (noExpiryConfirmed && confirmedFor !== confirmKey) { setNoExpiryConfirmed(false); setConfirmedFor(null); }
  const [error, setError] = useState<string | null>(null);

  const c = connectors.find((x) => x.id === connectorId);
  const writeMethods = (c?.methods ?? []).filter((m) => m !== 'GET');
  const canWrite = writeMethods.length > 0;
  // [설정 바꾸기…](fromExisting)는 기존 메서드를 **그대로** 보낸다 — 연결이 더 넓게 허용해도 넓히지 않는다(security F1).
  // 막힘 카드에서는 범위·경로 칸도 잠근다(designer D2). [고치기](editMode)는 범위를 바꿀 수 있다 — 범위를 그대로 두면 지금
  // 메서드 그대로, 바꾸면 읽기만은 GET·읽기+쓰기는 연결이 허용한 전부(새로 줄 때와 같다).
  const exScope: 'read' | 'write' = exWrite ? 'write' : 'read';
  const methods: ApiMethod[] = fromExisting && (!editMode || scope === exScope)
    ? [...((existing?.limits?.methods ?? []) as ApiMethod[])]
    : scope === 'read' ? ['GET'] : [...(c?.methods ?? [])];
  const lockShape = fromExisting && !editMode;
  function describeScope(ms: readonly string[]): string {
    return `${ms.some((m) => m !== 'GET') ? t('apiGrant.rowWrite') : t('apiGrant.rowRead')} (${ms.join('·')})`;
  }
  function hasEditChange(): boolean {
    if (!existing) return true;
    const stale = !!existing.suspendedAt || (existing.expiresAt !== null && Date.parse(existing.expiresAt) <= Date.now());
    return stale || (existing.limits?.methods ?? []).join('·') !== methods.join('·') || (existing.limits?.pathPrefix ?? '') !== pathPrefix
      || effectiveExpiry !== 'keep' || (scope === 'write' && humanOnly !== null && (humanOnly === 'yes') !== !!existing.writeNeedsHumanCause);
  }
  // 「지금 만료 유지」는 지금 grant 가 있고, 쓰기라면 그 만료가 있거나 이 화면이 무기한 쓰기를 고를 수 있을 때만.
  const keepOk = !!existing && (scope === 'read' || existing.expiresAt !== null || allowWriteNoExpiry) && (existing.expiresAt === null || Date.parse(existing.expiresAt) > Date.now());
  const effectiveExpiry: Expiry = (expiry === 'keep' && !keepOk) || (scope === 'write' && expiry === 'none' && !allowWriteNoExpiry) ? '7d' : expiry;
  // 무기한 쓰기 — 새로 무기한으로 주거나 무기한을 그대로 둘 때 경고를 보이고 확인을 받는다.
  const writeNoExpiry = scope === 'write' && (effectiveExpiry === 'none' || (effectiveExpiry === 'keep' && existing?.expiresAt === null));
  const pathOk = /^\/[^\s#\\]*$/.test(pathPrefix) && !pathPrefix.includes('..') && !pathPrefix.includes('?');
  const readOk = !c || c.methods.includes('GET') || scope === 'write';
  const ready = !!c && pathOk && readOk && methods.length > 0 && (scope === 'read' || humanOnly !== null) && (!writeNoExpiry || noExpiryConfirmed)
    // [고치기]는 바뀐 것이 있을 때만 저장한다(멈춘·만료된 부여는 그대로 다시 켜는 것도 바뀜이다).
    && (!editMode || !existing || hasEditChange());

  const submit = async () => {
    if (!c) return;
    setBusy(true); setError(null);
    try {
      const days = effectiveExpiry === '7d' ? 7 : effectiveExpiry === '30d' ? 30 : null;
      await getController().putGrant(agentId, {
        capability: 'api.call', scope: connectorScope(c.id),
        limits: { methods, pathPrefix },
        expiresAt: effectiveExpiry === 'keep' ? existing?.expiresAt ?? null : days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
        ...(scope === 'write' ? { writeNeedsHumanCause: humanOnly === 'yes' } : {}),
        // PUT 은 upsert 라 안 보낸 칸은 기본값으로 돌아간다 — 다시 줄 수 있는 단계를 조용히 0 으로 만들지 않는다(security D2 메모).
        ...(existing ? { delegateDepth: existing.delegateDepth ?? 0 } : {}),
      });
      await onDone();
    } catch (e) {
      if (e instanceof ApiError) {
        const known: Record<string, string> = {
          write_needs_expiry: t('apiGrant.errExpiry'), write_expiry_too_long: t('apiGrant.errExpiry'),
          bad_limits: t('apiGrant.errLimits'), no_connector: t('apiGrant.errConnector'),
        };
        setError(known[e.code] ?? (e.status === 403 ? t('apiGrant.errForbidden') : t('apiGrant.errFailed', { reason: e.message })));
      } else setError(t('apiGrant.errFailed', { reason: errorText(e, t) }));
    } finally { setBusy(false); }
  };

  if (!connectors.length) return <p className="mt-2 text-meta text-fg-subtle" data-testid="api-grant-no-connector">{t('apiGrant.noConnector')}</p>;

  // 메서드를 글자로 적는다 — 「읽기+쓰기」만으로는 메서드가 넓어진 것이 안 보인다(security F1).
  const describe = (methods: readonly string[], prefix: string, until: string) =>
    `${methods.some((m) => m !== 'GET') ? t('apiGrant.rowWrite') : t('apiGrant.rowRead')} (${methods.join('·')}) ${prefix || '—'} · ${until}`;
  const untilText = (iso: string | null) => (iso === null ? t('agents.grants.noExpiry') : t('agents.grants.expiresOn', { when: new Date(iso).toLocaleDateString(locale) }));
  // 「바꿀 값」의 만료(designer n5): 유지면 지금 날짜, 아니면 고른 칸.
  const nextUntil = effectiveExpiry === 'keep' ? untilText(existing?.expiresAt ?? null)
    : effectiveExpiry === 'none' ? t('agents.grants.noExpiry') : t(effectiveExpiry === '7d' ? 'apiGrant.expiry7d' : 'apiGrant.expiry30d');
  // [고치기]: 바뀐 칸만 「전 → 후」로 보인다. 서버도 같은 칸을 감사에 전→후로 남긴다.
  const exHuman = !!existing?.writeNeedsHumanCause;
  const changes: { key: string; label: string; from: string; to: string; mono?: boolean }[] = !(editMode && existing) ? [] : [
    // 멈춘 부여를 저장하면 다시 켜진다 — 그것도 바뀜이다(「바뀐 것이 없다」와 어긋나지 않게, designer 고칠 것 1).
    ...(existing.suspendedAt ? [{ key: 'state', label: t('apiGrant.stateLabel'), from: t('apiGrant.stateStopped'), to: t('apiGrant.stateOn') }] : []),
    ...((existing.limits?.methods ?? []).join('·') !== methods.join('·')
      ? [{ key: 'scope', label: t('apiGrant.scope'), from: describeScope(existing.limits?.methods ?? []), to: describeScope(methods) }] : []),
    ...((existing.limits?.pathPrefix ?? '') !== pathPrefix ? [{ key: 'path', label: t('apiGrant.pathShort'), from: existing.limits?.pathPrefix ?? '—', to: pathPrefix || '—', mono: true }] : []),
    ...(effectiveExpiry !== 'keep' ? [{ key: 'expiry', label: t('apiGrant.expiry'), from: untilText(existing.expiresAt), to: nextUntil }] : []),
    ...(scope === 'write' && humanOnly !== null && (exScope !== 'write' || (humanOnly === 'yes') !== exHuman)
      ? [{ key: 'human', label: t('apiGrant.humanOnly'), from: exScope === 'write' ? t(exHuman ? 'apiGrant.humanOnlyYes' : 'apiGrant.humanOnlyNo') : '—', to: t(humanOnly === 'yes' ? 'apiGrant.humanOnlyYes' : 'apiGrant.humanOnlyNo') }] : []),
  ];
  // 좁힘 = 메서드가 빠지거나 새 경로가 옛 경로를 덮지 않을 때. 「덮는다」는 서버 `pathCovered` 와 같은 마디 경계 규칙이다
  // (끝이 `/` 면 글자 접두, 아니면 같거나 `새/…`) — `/api/catalog/` → `/ap` 는 덮지 않는다.
  const oldPrefix = existing?.limits?.pathPrefix ?? '';
  const covers = (prefix: string, path: string): boolean => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`));
  const narrowing = editMode && !!existing && (
    (existing.limits?.methods ?? []).some((m) => !methods.includes(m as ApiMethod)) || (oldPrefix !== pathPrefix && !covers(pathPrefix, oldPrefix)));
  return (
    <div className="mt-2 space-y-2 rounded border border-border bg-surface-sunken p-2 text-meta text-fg" data-testid="api-grant-form">
      {editMode && existing && (
        <div className="space-y-0.5 rounded border border-border bg-surface px-2 py-1" data-testid="api-grant-changes">
          {changes.length === 0
            ? <div className="text-fg-subtle">{t('apiGrant.noChanges')}</div>
            : changes.map((x) => <div key={x.key} data-testid={`api-grant-change-${x.key}`}>{x.label}: <span className={x.mono ? 'font-mono' : ''}>{x.from}</span> → <span className={x.mono ? 'font-mono' : ''}>{x.to}</span></div>)}
          {/* 멈춘 부여를 고치면 다시 켜진다(서버 upsert 가 정지를 푼다) — 만료만 만지다 되살리지 않게 눈에 띄게(security 조건 3). */}
          {existing.suspendedAt && <div className="text-warning" data-testid="api-grant-resume-warning">⚠ {t('apiGrant.resumeWarn')}</div>}
          {narrowing && delegatedCount > 0 && <div className="text-warning" data-testid="api-grant-children-warning">⚠ {t('apiGrant.childrenWarn', { n: String(delegatedCount) })}</div>}
          {existing.expiresAt !== null && Date.parse(existing.expiresAt) <= Date.now() && <div data-testid="api-grant-expired">{t('apiGrant.expiredRenew')}</div>}
        </div>
      )}
      {existing && !editMode && (
        <div className="rounded border border-warning-border bg-warning-surface px-2 py-1 text-warning" data-testid="api-grant-replace">
          <div>{t('apiGrant.now', { what: describe(existing.limits?.methods ?? [], existing.limits?.pathPrefix ?? '', untilText(existing.expiresAt)) })}</div>
          <div>{t('apiGrant.next', { what: describe(methods, pathPrefix, nextUntil) })}</div>
          <div>{t('apiGrant.replaceNote')}</div>
          {existing.expiresAt !== null && Date.parse(existing.expiresAt) <= Date.now() && <div data-testid="api-grant-expired">{t('apiGrant.expiredRenew')}</div>}
        </div>
      )}
      <label className="flex flex-col gap-1">
        {t('apiGrant.connector')}
        <select aria-label={t('apiGrant.connector')} className="rounded border border-border bg-surface px-2 py-1" value={connectorId} disabled={busy || !!initial || fromExisting}
          onChange={(e) => { setConnectorId(e.target.value); setScope('read'); setHumanOnly(null); }}>
          {connectors.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.baseUrl}</option>)}
        </select>
      </label>
      <Segmented label={t('apiGrant.scope')} value={scope} disabled={busy || lockShape}
        onChange={(v) => { setScope(v); if (v === 'write' && expiry === 'none' && !allowWriteNoExpiry) setExpiry('7d'); }}
        options={[
          { value: 'read' as const, label: t('apiGrant.read') },
          ...(canWrite ? [{ value: 'write' as const, label: t('apiGrant.write', { methods: (fromExisting && exScope === 'write' && (!editMode || scope === 'write') ? (existing?.limits?.methods ?? []) : c?.methods ?? []).join('·') }) }] : []),
        ]} />
      <label className="flex flex-col gap-1">
        {t('apiGrant.path')}
        <input aria-label={t('apiGrant.path')} className="rounded border border-border bg-surface px-2 py-1 font-mono" value={pathPrefix} disabled={busy || lockShape} onChange={(e) => setPathPrefix(e.target.value)} />
        {pathPrefix === '' ? <span className="text-warning" data-testid="api-grant-path-unknown">{t('apiGrant.pathUnknown')}</span>
          : !pathOk && <span className="text-warning">{t('apiGrant.pathBad')}</span>}
      </label>
      <Segmented label={t('apiGrant.expiry')} value={effectiveExpiry} disabled={busy} onChange={setExpiry}
        options={([...(keepOk ? ['keep'] as const : []), '7d', '30d', ...(scope === 'read' || allowWriteNoExpiry ? ['none'] as const : [])] as Expiry[]).map((x) => ({
          value: x, label: x === 'keep' ? t('apiGrant.expiryKeep') : t(x === '7d' ? 'apiGrant.expiry7d' : x === '30d' ? 'apiGrant.expiry30d' : 'apiGrant.expiryNone'),
        }))}>
        {scope === 'write' && !allowWriteNoExpiry && <span className="text-fg-subtle">{t('apiGrant.writeExpiryHint')}</span>}
      </Segmented>
      {scope === 'write' && (
        <Segmented label={t('apiGrant.humanOnly')} value={humanOnly} disabled={busy} onChange={setHumanOnly} testId="api-grant-human-only"
          options={[{ value: 'yes' as const, label: t('apiGrant.humanOnlyYes') }, { value: 'no' as const, label: t('apiGrant.humanOnlyNo') }]}>
          <span className="w-full text-fg-subtle">{humanOnly === null ? t('apiGrant.humanOnlyPick') : t('apiGrant.humanOnlyHint')}</span>
        </Segmented>
      )}
      {writeNoExpiry && (
        <div className="rounded-row bg-warning-surface px-2 py-1.5 text-warning" data-testid="api-grant-no-expiry-warning">
          <p>⚠ {t('apiGrant.noExpiryWarn', { methods: methods.filter((m) => m !== 'GET').join('·') })}{humanOnly === 'no' ? ` ${t('apiGrant.noExpiryWarnAgentTurns')}` : ''}</p>
          <label className="mt-1 flex items-center gap-1.5 text-fg">
            <input type="checkbox" checked={noExpiryConfirmed} disabled={busy}
              onChange={(e) => { setNoExpiryConfirmed(e.target.checked); setConfirmedFor(e.target.checked ? confirmKey : null); }} />
            {t('apiGrant.noExpiryConfirm')}
          </label>
        </div>
      )}
      <p className="text-fg-subtle">{t('apiGrant.keyNote')}</p>
      <div className="flex gap-2">
        <button type="button" className="rounded bg-accent px-2 py-1 font-medium text-fg-on-strong disabled:opacity-50" disabled={busy || !ready} onClick={() => void submit()}>{editMode && existing ? t('apiGrant.save') : existing ? t('apiGrant.replace') : t('apiGrant.give')}</button>
        <button type="button" className="rounded border border-border px-2 py-1 hover:bg-surface disabled:opacity-50" disabled={busy} onClick={onCancel}>{t('secrets.cancel')}</button>
      </div>
      {error && <p role="alert" className="text-danger" data-testid="api-grant-error">{error}</p>}
    </div>
  );
}
