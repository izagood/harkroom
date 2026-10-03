import { useEffect, useState } from 'react';
import type { ApiConnectorView, GrantRow, MessageRow } from '@harkroom/shared';
import { getController } from '../state/controller';
import { useActiveStore } from '../state/communities';
import { useLocale, useT } from '../i18n/useT';
import type { MessageKey } from '../i18n';
import { Overlay } from './Overlay';
import { ApiGrantForm, type ApiGrantInitial } from './settings/ApiGrantForm';
import type { SectionId } from './settings/sections';

/**
 * API 막힘 카드(외부 API 권한 C안 P4b, designer v3 ④). 서버가 래퍼의 거절로 세운 시스템 줄(`meta.blocked`, P4a)을 카드로 그린다 —
 * 에이전트의 ask 선택지가 아니다. 버튼은 **에이전트 소유자인 사람**에게만 서고, 처리는 그 사람 세션의 REST(`PUT /accounts/:id/grants`)다.
 * 남에게는 「소유자 @x 만 줄 수 있다」만 보인다.
 *
 * 대화상자는 서버 기록으로만 채우고 막힌 요청보다 넓히지 않는다: GET 이면 읽기만, 경로는 첫 마디까지(`/api/clusters/1` → `/api/`).
 * 「쓰기는 사람 글 턴만」은 폼이 기본값 없이 고르게 한다.
 */
export interface BlockedMeta {
  kind: 'api'; agentId: string; ownerAccountId: string | null; code: string; lastCode?: string; count: number; lastAt: string;
  connectorId: string | null; connectorName: string | null; method: string; path: string | null; lastRequest?: string;
}

export function readBlocked(meta: Record<string, unknown>): BlockedMeta | null {
  const b = meta.blocked as Partial<BlockedMeta> | undefined;
  if (!b || b.kind !== 'api' || typeof b.agentId !== 'string' || typeof b.code !== 'string') return null;
  return {
    kind: 'api', agentId: b.agentId, ownerAccountId: typeof b.ownerAccountId === 'string' ? b.ownerAccountId : null,
    code: b.code, lastCode: typeof b.lastCode === 'string' ? b.lastCode : b.code, count: typeof b.count === 'number' ? b.count : 1,
    lastAt: typeof b.lastAt === 'string' ? b.lastAt : '', connectorId: typeof b.connectorId === 'string' ? b.connectorId : null,
    connectorName: typeof b.connectorName === 'string' ? b.connectorName : null, method: typeof b.method === 'string' ? b.method : 'GET',
    path: typeof b.path === 'string' ? b.path : null, lastRequest: typeof b.lastRequest === 'string' ? b.lastRequest : undefined,
  };
}

/** 막힌 경로의 첫 마디까지(`/api/x/1` → `/api/`). 더 넓히지 않는다. 경로를 모르면 빈 글자 — 사람이 적는다(security L1). */
export function firstSegment(path: string | null): string {
  if (!path) return '';
  const m = /^\/[^/]+\//.exec(path);
  return m ? m[0] : path;
}

const GRANT_CODES = new Set(['not_granted', 'expired', 'suspended', 'method_not_allowed', 'path_not_allowed']);

export function BlockedCard({ message, onOpenSettings }: { message: MessageRow; onOpenSettings?: (section?: SectionId, targetId?: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const b = readBlocked(message.meta);
  const me = useActiveStore((s) => s.me);
  const accounts = useActiveStore((s) => s.accounts);
  const [open, setOpen] = useState(false);
  const [connectors, setConnectors] = useState<ApiConnectorView[] | null>(null);
  // 지금 그 연결에 있는 grant — 있으면 폼이 「지금 → 바꿀 값」을 보이고 [바꾸기]가 된다(security L2).
  const [existing, setExisting] = useState<GrantRow | null | undefined>(undefined);
  const [done, setDone] = useState(false);
  const agentIdForLoad = b?.agentId;
  const connectorIdForLoad = b?.connectorId;
  useEffect(() => {
    if (!open || connectors || !agentIdForLoad) return;
    getController().listConnectors().then(setConnectors, () => setConnectors([]));
    getController().listGrants(agentIdForLoad).then(
      (rows) => setExisting(rows.find((g) => g.capability === 'api.call' && g.scope === `connector:${connectorIdForLoad ?? ''}`) ?? null),
      () => setExisting(null));
  }, [open, connectors, agentIdForLoad, connectorIdForLoad]);
  if (!b) return null;

  const handle = accounts[b.agentId]?.handle ?? b.agentId.slice(0, 8);
  const owner = b.ownerAccountId ? accounts[b.ownerAccountId]?.handle ?? '?' : '?';
  const isOwner = !!me && b.ownerAccountId === me.id && me.kind === 'human';
  const code = b.lastCode ?? b.code;
  // 서버는 위험한 경로를 「(경로 생략)」으로 싣는다(P4a L1) — 화면 말로 바꾼다(designer D3).
  const shownRequest = (b.lastRequest ?? `${b.method} ${b.path ?? '(경로 생략)'}`).replace('(경로 생략)', t('blocked.pathOmitted'));
  // [설정 바꾸기…](cause_not_human, designer D2)는 지금 grant 그대로 연다 — initial 없이 existing 으로.
  const humanOnlyEdit = code === 'cause_not_human';
  const initial: ApiGrantInitial | undefined = b.connectorId && !humanOnlyEdit
    ? { connectorId: b.connectorId, scope: b.method === 'GET' ? 'read' : 'write', pathPrefix: firstSegment(b.path) }
    : undefined;
  const mine = (connectors ?? []).filter((c) => c.ownerAccountId === me?.id && c.id === b.connectorId);

  return (
    <div className="mt-1 rounded border border-border border-l-4 border-warning-border bg-surface-raised p-2 text-meta" data-testid="blocked-card">
      <div className="font-medium text-fg">🔒 {t('blocked.title', { handle })}</div>
      <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-fg">
        <dt className="text-fg-subtle">{t('blocked.request')}</dt>
        <dd className="min-w-0 break-all font-mono">{b.connectorName ?? '—'} {shownRequest}</dd>
        <dt className="text-fg-subtle">{t('blocked.reason')}</dt>
        <dd>{t(`blocked.why.${code}` as MessageKey)}</dd>
        <dt className="text-fg-subtle">{t('blocked.today')}</dt>
        <dd>{t('blocked.count', { n: String(b.count), when: b.lastAt ? new Date(b.lastAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '' })}</dd>
      </dl>
      {done && <p className="mt-1 text-fg" data-testid="blocked-done">{t('blocked.done')}</p>}
      {!done && isOwner && (
        <div className="mt-2 flex flex-wrap gap-2">
          {GRANT_CODES.has(code) && initial && (
            <button type="button" className="rounded bg-accent px-2 py-1 font-medium text-fg-on-strong" onClick={() => setOpen(true)}>{t('blocked.give')}</button>
          )}
          {humanOnlyEdit && b.connectorId && (
            <button type="button" className="rounded bg-accent px-2 py-1 font-medium text-fg-on-strong" onClick={() => setOpen(true)}>{t('blocked.changeSetting')}</button>
          )}
          {(code === 'no_secret' || code === 'secret_expired') && onOpenSettings && (
            <button type="button" className="rounded bg-accent px-2 py-1 font-medium text-fg-on-strong" onClick={() => onOpenSettings('secrets')}>{t('blocked.newValue')}</button>
          )}
          {code === 'no_connector' && onOpenSettings && (
            <button type="button" className="rounded bg-accent px-2 py-1 font-medium text-fg-on-strong" onClick={() => onOpenSettings('secrets')}>{t('blocked.makeConnection')}</button>
          )}
          {onOpenSettings && (
            <button type="button" className="rounded border border-border px-2 py-1 text-fg-muted" onClick={() => onOpenSettings('agents', b.agentId)}>{t('blocked.openSettings')}</button>
          )}
        </div>
      )}
      {!isOwner && <p className="mt-1 text-fg-subtle" data-testid="blocked-owner-only">{t('blocked.ownerOnly', { owner })}</p>}
      {open && (
        <Overlay label={t('blocked.dialogTitle', { handle })} onClose={() => setOpen(false)} className="w-[32rem]" align="center">
          <div className="p-4">
            <div className="text-body font-medium text-fg">{t('blocked.dialogTitle', { handle })}</div>
            <p className="mt-1 text-meta text-fg-subtle">{t('blocked.dialogNote')}</p>
            {connectors === null || existing === undefined
              ? <p className="mt-2 text-meta text-fg-muted">{t('secrets.loading')}</p>
              : <ApiGrantForm agentId={b.agentId} connectors={mine} initial={initial} existing={existing} onCancel={() => setOpen(false)} onDone={() => { setOpen(false); setDone(true); }} />}
          </div>
        </Overlay>
      )}
    </div>
  );
}
