import { useState } from 'react';
import { connectorScope, type ApiConnectorView, type ApiMethod } from '@harkroom/shared';
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

type Expiry = '7d' | '30d' | 'none';

export function ApiGrantForm({ agentId, connectors, initial, onDone, onCancel }: {
  agentId: string;
  /** 고를 수 있는 연결 — 내 것만(서버 규칙과 같다). */
  connectors: ApiConnectorView[];
  initial?: ApiGrantInitial;
  onDone(): void | Promise<void>;
  onCancel(): void;
}) {
  const t = useT();
  const [connectorId, setConnectorId] = useState(initial?.connectorId ?? connectors[0]?.id ?? '');
  const [scope, setScope] = useState<'read' | 'write'>(initial?.scope ?? 'read');
  const [pathPrefix, setPathPrefix] = useState(initial?.pathPrefix ?? '/');
  const [expiry, setExpiry] = useState<Expiry>('7d');
  const [humanOnly, setHumanOnly] = useState<'yes' | 'no' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const c = connectors.find((x) => x.id === connectorId);
  const writeMethods = (c?.methods ?? []).filter((m) => m !== 'GET');
  const canWrite = writeMethods.length > 0;
  const methods: ApiMethod[] = scope === 'read' ? ['GET'] : [...(c?.methods ?? [])];
  const effectiveExpiry: Expiry = scope === 'write' && expiry === 'none' ? '7d' : expiry;
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
        expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
        ...(scope === 'write' ? { writeNeedsHumanCause: humanOnly === 'yes' } : {}),
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

  const seg = (on: boolean) => `rounded px-2 py-1 text-meta ${on ? 'bg-accent text-fg-on-strong' : 'border border-border text-fg hover:bg-surface-hover'}`;
  return (
    <div className="mt-2 space-y-2 rounded border border-border bg-surface-sunken p-2 text-meta text-fg" data-testid="api-grant-form">
      <label className="flex flex-col gap-1">
        {t('apiGrant.connector')}
        <select aria-label={t('apiGrant.connector')} className="rounded border border-border bg-surface px-2 py-1" value={connectorId} disabled={busy || !!initial}
          onChange={(e) => { setConnectorId(e.target.value); setScope('read'); setHumanOnly(null); }}>
          {connectors.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.baseUrl}</option>)}
        </select>
      </label>
      <div role="radiogroup" aria-label={t('apiGrant.scope')} className="flex flex-wrap items-center gap-2">
        <span>{t('apiGrant.scope')}</span>
        <button type="button" role="radio" aria-checked={scope === 'read'} className={seg(scope === 'read')} disabled={busy} onClick={() => setScope('read')}>{t('apiGrant.read')}</button>
        {canWrite && (
          <button type="button" role="radio" aria-checked={scope === 'write'} className={seg(scope === 'write')} disabled={busy}
            onClick={() => { setScope('write'); if (expiry === 'none') setExpiry('7d'); }}>
            {t('apiGrant.write', { methods: (c?.methods ?? []).join('·') })}
          </button>
        )}
      </div>
      <label className="flex flex-col gap-1">
        {t('apiGrant.path')}
        <input aria-label={t('apiGrant.path')} className="rounded border border-border bg-surface px-2 py-1 font-mono" value={pathPrefix} disabled={busy} onChange={(e) => setPathPrefix(e.target.value)} />
        {!pathOk && <span className="text-warning">{t('apiGrant.pathBad')}</span>}
      </label>
      <div role="radiogroup" aria-label={t('apiGrant.expiry')} className="flex flex-wrap items-center gap-2">
        <span>{t('apiGrant.expiry')}</span>
        {(['7d', '30d', ...(scope === 'read' ? ['none'] as const : [])] as Expiry[]).map((x) => (
          <button key={x} type="button" role="radio" aria-checked={effectiveExpiry === x} className={seg(effectiveExpiry === x)} disabled={busy} onClick={() => setExpiry(x)}>
            {t(x === '7d' ? 'apiGrant.expiry7d' : x === '30d' ? 'apiGrant.expiry30d' : 'apiGrant.expiryNone')}
          </button>
        ))}
        {scope === 'write' && <span className="text-fg-subtle">{t('apiGrant.writeExpiryHint')}</span>}
      </div>
      {scope === 'write' && (
        <div role="radiogroup" aria-label={t('apiGrant.humanOnly')} className="flex flex-wrap items-center gap-2" data-testid="api-grant-human-only">
          <span>{t('apiGrant.humanOnly')}</span>
          <button type="button" role="radio" aria-checked={humanOnly === 'yes'} className={seg(humanOnly === 'yes')} disabled={busy} onClick={() => setHumanOnly('yes')}>{t('apiGrant.humanOnlyYes')}</button>
          <button type="button" role="radio" aria-checked={humanOnly === 'no'} className={seg(humanOnly === 'no')} disabled={busy} onClick={() => setHumanOnly('no')}>{t('apiGrant.humanOnlyNo')}</button>
          <span className="w-full text-fg-subtle">{humanOnly === null ? t('apiGrant.humanOnlyPick') : t('apiGrant.humanOnlyHint')}</span>
        </div>
      )}
      <p className="text-fg-subtle">{t('apiGrant.keyNote')}</p>
      <div className="flex gap-2">
        <button type="button" className="rounded border border-border bg-accent px-2 py-1 font-medium text-accent-fg disabled:opacity-50" disabled={busy || !ready} onClick={() => void submit()}>{t('apiGrant.give')}</button>
        <button type="button" className="rounded border border-border px-2 py-1 hover:bg-surface disabled:opacity-50" disabled={busy} onClick={onCancel}>{t('secrets.cancel')}</button>
      </div>
      {error && <p role="alert" className="text-danger" data-testid="api-grant-error">{error}</p>}
    </div>
  );
}
