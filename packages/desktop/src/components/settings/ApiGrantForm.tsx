import { Segmented } from '../Segmented';
import { useState } from 'react';
import { connectorScope, type ApiConnectorView, type ApiMethod, type GrantRow } from '@harkroom/shared';
import { useLocale } from '../../i18n/useT';
import { getController } from '../../state/controller';
import { ApiError } from '../../lib/api';
import { useT } from '../../i18n/useT';

/**
 * 에이전트에게 `api.call` 을 주는 폼(외부 API 권한 C안 P4b, designer v3 ③·④). 「할 수 있는 일」의 [+ 권한 주기]와 막힘 카드의
 * [권한 주기…] 대화상자가 **같은 폼**을 쓴다 — 두 벌이면 한쪽만 고쳐져 카드에서 주는 권한이 더 넓어지는 날이 온다.
 *
 * - 범위: 읽기만(GET) / 읽기+쓰기(연결이 허용한 메서드 전부). 경로는 이것으로 시작하는 것만.
 * - 만료: 7일(기본)·30일. 「만료 없음」은 **읽기만**일 때만 생긴다(D3 — 서버도 쓰기의 무기한·30일 초과를 거절한다).
 * - **「쓰기는 사람 글 턴만」은 기본값이 없다**(jaebin 지시) — 쓰기를 고르면 예/아니오를 사람이 골라야 [주기]가 켜진다.
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
export function ApiGrantForm({ agentId, connectors, initial, existing = null, onDone, onCancel }: {
  agentId: string;
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
  const [error, setError] = useState<string | null>(null);

  const c = connectors.find((x) => x.id === connectorId);
  const writeMethods = (c?.methods ?? []).filter((m) => m !== 'GET');
  const canWrite = writeMethods.length > 0;
  // [설정 바꾸기…](fromExisting)는 기존 메서드를 **그대로** 보낸다 — 연결이 더 넓게 허용해도 넓히지 않는다(security F1).
  // 범위·경로 칸도 잠근다: 이 모드에서 바꾸는 것은 「쓰기는 사람 글 턴만」과 만료뿐이다(designer D2).
  const methods: ApiMethod[] = fromExisting
    ? [...((existing?.limits?.methods ?? []) as ApiMethod[])]
    : scope === 'read' ? ['GET'] : [...(c?.methods ?? [])];
  // 「지금 만료 유지」는 지금 grant 가 있고, 쓰기라면 그 만료가 있을 때만(무기한 쓰기는 서버가 거절한다).
  const keepOk = !!existing && (scope === 'read' || existing.expiresAt !== null) && (existing.expiresAt === null || Date.parse(existing.expiresAt) > Date.now());
  const effectiveExpiry: Expiry = (expiry === 'keep' && !keepOk) || (scope === 'write' && expiry === 'none') ? '7d' : expiry;
  const pathOk = /^\/[^\s#\\]*$/.test(pathPrefix) && !pathPrefix.includes('..') && !pathPrefix.includes('?');
  const readOk = !c || c.methods.includes('GET') || scope === 'write';
  const ready = !!c && pathOk && readOk && methods.length > 0 && (scope === 'read' || humanOnly !== null);

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
      } else setError(t('apiGrant.errFailed', { reason: e instanceof Error ? e.message : String(e) }));
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
  return (
    <div className="mt-2 space-y-2 rounded border border-border bg-surface-sunken p-2 text-meta text-fg" data-testid="api-grant-form">
      {existing && (
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
      <Segmented label={t('apiGrant.scope')} value={scope} disabled={busy || fromExisting}
        onChange={(v) => { setScope(v); if (v === 'write' && expiry === 'none') setExpiry('7d'); }}
        options={[
          { value: 'read' as const, label: t('apiGrant.read') },
          ...(canWrite ? [{ value: 'write' as const, label: t('apiGrant.write', { methods: (fromExisting && scope === 'write' ? methods : c?.methods ?? []).join('·') }) }] : []),
        ]} />
      <label className="flex flex-col gap-1">
        {t('apiGrant.path')}
        <input aria-label={t('apiGrant.path')} className="rounded border border-border bg-surface px-2 py-1 font-mono" value={pathPrefix} disabled={busy || fromExisting} onChange={(e) => setPathPrefix(e.target.value)} />
        {pathPrefix === '' ? <span className="text-warning" data-testid="api-grant-path-unknown">{t('apiGrant.pathUnknown')}</span>
          : !pathOk && <span className="text-warning">{t('apiGrant.pathBad')}</span>}
      </label>
      <Segmented label={t('apiGrant.expiry')} value={effectiveExpiry} disabled={busy} onChange={setExpiry}
        options={([...(keepOk ? ['keep'] as const : []), '7d', '30d', ...(scope === 'read' ? ['none'] as const : [])] as Expiry[]).map((x) => ({
          value: x, label: x === 'keep' ? t('apiGrant.expiryKeep') : t(x === '7d' ? 'apiGrant.expiry7d' : x === '30d' ? 'apiGrant.expiry30d' : 'apiGrant.expiryNone'),
        }))}>
        {scope === 'write' && <span className="text-fg-subtle">{t('apiGrant.writeExpiryHint')}</span>}
      </Segmented>
      {scope === 'write' && (
        <Segmented label={t('apiGrant.humanOnly')} value={humanOnly} disabled={busy} onChange={setHumanOnly} testId="api-grant-human-only"
          options={[{ value: 'yes' as const, label: t('apiGrant.humanOnlyYes') }, { value: 'no' as const, label: t('apiGrant.humanOnlyNo') }]}>
          <span className="w-full text-fg-subtle">{humanOnly === null ? t('apiGrant.humanOnlyPick') : t('apiGrant.humanOnlyHint')}</span>
        </Segmented>
      )}
      <p className="text-fg-subtle">{t('apiGrant.keyNote')}</p>
      <div className="flex gap-2">
        <button type="button" className="rounded bg-accent px-2 py-1 font-medium text-fg-on-strong disabled:opacity-50" disabled={busy || !ready} onClick={() => void submit()}>{existing ? t('apiGrant.replace') : t('apiGrant.give')}</button>
        <button type="button" className="rounded border border-border px-2 py-1 hover:bg-surface disabled:opacity-50" disabled={busy} onClick={onCancel}>{t('secrets.cancel')}</button>
      </div>
      {error && <p role="alert" className="text-danger" data-testid="api-grant-error">{error}</p>}
    </div>
  );
}
