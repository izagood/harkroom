import { useEffect, useState } from 'react';
import type { MessageRow } from '@harkroom/shared';
import type { OperatorMergeState } from '@harkroom/shared/daemonProtocol';
import { getController } from '../state/controller';
import { ApiError } from '../lib/api';
import { useActiveStore } from '../state/communities';
import { useLocale, useT } from '../i18n/useT';
import { checkLocalMerge, getLocalMerge, hasOperatorLocalSurface, listLocalAgents } from '../lib/operatorLocal';
import { prUrlOf } from './MergeDenialPanel';

/**
 * 머지 거절에서 온 권한 카드의 [이번 한 번 머지](스레드 1b75d7a0 ③, designer 시안 merge-once-card).
 *
 * 서버가 거절 기록으로 채운 `meta.permissionRequest.once`(PR·head·사유)가 있을 때만 선다. 기존 [승인](7일)·[거절]은 그 아래
 * `AskCard` 의 선택지 그대로다. 「한 번」을 누르면 계정·CI 칸이 펼쳐진다 — 늘 보이면 7일 승인도 그 계정을 쓰는 것처럼 읽힌다.
 *
 * - 계정은 **이 기기 오퍼레이터**의 gh 목록이다. 에이전트가 다른 기기에서 돌면 이 기기 계정으로 승인해도 래퍼가 못 쓴다 →
 *   버튼 대신 「그 기기에서」 안내만 둔다.
 * - 닿지 않는(✕) 계정은 고를 수 없다(사전 확인에서 반드시 막힌다). 「확인 못 함」은 고를 수 있고 한 줄 경고를 붙인다.
 * - 고른 계정은 저장하지 않는다(`byScope` 는 7일 grant 줄의 것) — 이 PR 한 번만의 선택이다.
 * - 보내는 것은 계정·CI 완화뿐이고 저장소·PR·head 는 서버가 거절 기록에서 가져온다.
 */
export interface PermissionOnceMeta {
  requestId: string; agentId: string; ownerAccountId: string | null; repo: string;
  number: number; headSha: string; reason: 'not_granted' | 'cause_not_human';
  status: 'pending' | 'granted' | 'denied' | 'approved_once';
  decidedBy: string | null;
  approvedOnce: { ghUser: string; relaxChecks: boolean; expiresAt: string } | null;
}

export function readPermissionOnce(meta: Record<string, unknown>): PermissionOnceMeta | null {
  const p = meta.permissionRequest as Record<string, unknown> | undefined;
  if (!p || p.kind !== 'merge' || typeof p.requestId !== 'string' || typeof p.agentId !== 'string' || typeof p.target !== 'string') return null;
  const o = p.once as Record<string, unknown> | undefined;
  if (!o || typeof o.number !== 'number' || typeof o.headSha !== 'string') return null;
  const a = p.approvedOnce as Record<string, unknown> | undefined;
  const status = p.status === 'granted' || p.status === 'denied' || p.status === 'approved_once' ? p.status : 'pending';
  return {
    requestId: p.requestId, agentId: p.agentId, ownerAccountId: typeof p.ownerAccountId === 'string' ? p.ownerAccountId : null,
    repo: p.target, number: o.number, headSha: o.headSha, reason: o.reason === 'cause_not_human' ? 'cause_not_human' : 'not_granted',
    status, decidedBy: typeof p.decidedBy === 'string' ? p.decidedBy : null,
    approvedOnce: a && typeof a.ghUser === 'string' && typeof a.expiresAt === 'string'
      ? { ghUser: a.ghUser, relaxChecks: a.relaxChecks === true, expiresAt: a.expiresAt } : null,
  };
}

type Device = 'checking' | 'here' | 'elsewhere' | 'no-surface';
type Reach = Record<string, 'ok' | 'no' | 'unknown'>;

export function PermissionOncePanel({ message }: { message: MessageRow }) {
  const t = useT();
  const locale = useLocale();
  const d = readPermissionOnce(message.meta);
  const me = useActiveStore((s) => s.me);
  const accounts = useActiveStore((s) => s.accounts);
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState<Device>('checking');
  const [merge, setMerge] = useState<OperatorMergeState | 'error' | null>(null);
  const [reach, setReach] = useState<Reach>({});
  const [ghUser, setGhUser] = useState('');
  const [relax, setRelax] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; raw: string } | null>(null);
  const [done, setDone] = useState<PermissionOnceMeta['approvedOnce']>(null);
  const isOwner = !!d && !!me && d.ownerAccountId === me.id && me.kind === 'human';
  const repoKey = d?.repo.toLowerCase() ?? '';

  // 펼쳤을 때만 오퍼레이터에 묻는다 — 카드가 그려질 때마다 gh 를 깨우지 않게.
  useEffect(() => {
    if (!open || !d) return;
    let alive = true;
    if (!hasOperatorLocalSurface()) { setDevice('no-surface'); return; }
    void (async () => {
      try {
        const local = await listLocalAgents();
        const here = local.communities.some((c) => Object.prototype.hasOwnProperty.call(c.agents, d.agentId));
        if (!alive) return;
        setDevice(here ? 'here' : 'elsewhere');
        if (!here) return;
        const s = await getLocalMerge();
        if (!alive) return;
        setMerge(s);
        const pre = s.byScope?.[repoKey] ?? null;
        try {
          const r = await checkLocalMerge([repoKey]);
          if (!alive) return;
          const byLogin: Reach = {};
          for (const [login, v] of Object.entries(r.reach[repoKey] ?? {})) byLogin[login] = v.status;
          setReach(byLogin);
          // 이 저장소 줄에 정해 둔 계정이 닿으면 미리 고른다. 그 밖엔 빈칸 — 고르기 전엔 승인 버튼이 꺼져 있다.
          if (pre && byLogin[pre] === 'ok') setGhUser((cur) => cur || pre);
        } catch { /* 닿음을 못 재면 상태 없이 고르게 둔다 */ }
      } catch {
        if (alive) { setDevice('here'); setMerge('error'); }
      }
    })();
    return () => { alive = false; };
  }, [open, d?.agentId, repoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return null;
  const owner = d.ownerAccountId ? accounts[d.ownerAccountId]?.handle ?? '?' : '?';
  const url = prUrlOf({ repo: d.repo, number: d.number });
  const approved = done ?? (d.status === 'approved_once' ? d.approvedOnce : null);
  // 날짜를 붙인 절대 시각 — 「오늘」은 다음 날 틀린다(#1163 n2).
  const when = (iso: string) => new Date(iso).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  const submit = async () => {
    if (!ghUser) return;
    setBusy(true); setError(null);
    try {
      const r = await getController().approvePermissionOnce(d.agentId, d.requestId, { ghUser, relaxChecks: relax });
      setDone({ ghUser, relaxChecks: relax, expiresAt: r.approvalExpiresAt ?? new Date(Date.now() + 86_400_000).toISOString() });
    } catch (e) {
      setError({ code: e instanceof ApiError ? e.code : 'failed', raw: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const list = merge && merge !== 'error' ? merge.accounts ?? [] : [];
  const rank = (login: string) => ({ ok: 0, unknown: 1, no: 2 } as const)[reach[login] ?? 'unknown'];
  const sorted = [...list].sort((a, b) => rank(a.login) - rank(b.login));
  const mark = (login: string) => (reach[login] === 'ok' ? ' ✓' : reach[login] === 'no' ? ' ✕' : '');

  return (
    <div className="mt-1 rounded border border-border border-l-4 border-warning-border bg-surface-raised p-2 text-meta" data-testid="merge-once-card">
      <div className="break-all font-mono text-body font-semibold text-fg" data-testid="merge-once-repo">{d.repo}</div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-fg-subtle">{t('mergeOnce.pr')}</dt>
        <dd>
          {url ? <a href={url} target="_blank" rel="noreferrer noopener" className="text-accent underline" data-testid="merge-once-pr">#{d.number}</a> : <span>#{d.number}</span>}
          <span className="ml-2 font-mono text-fg-muted" data-testid="merge-once-head">{d.headSha.slice(0, 9)}</span>
        </dd>
        <dt className="text-fg-subtle">{t('mergeOnce.why')}</dt>
        <dd data-testid="merge-once-reason" data-reason={d.reason}>
          {d.reason === 'cause_not_human' ? t('mergeOnce.reasonNotHuman') : t('mergeOnce.reasonNotGranted')}
        </dd>
      </dl>

      {approved && (
        <p className={`mt-2 ${Date.parse(approved.expiresAt) <= Date.now() ? 'text-fg-subtle' : 'text-fg'}`} data-testid="merge-once-approved"
          data-expired={Date.parse(approved.expiresAt) <= Date.now() || undefined}>
          {Date.parse(approved.expiresAt) <= Date.now()
            ? t('mergeOnce.approvedExpired', { login: approved.ghUser })
            : t(approved.relaxChecks ? 'mergeOnce.approvedRelaxed' : 'mergeOnce.approved', {
              by: d.decidedBy ? accounts[d.decidedBy]?.handle ?? owner : owner, login: approved.ghUser, until: when(approved.expiresAt),
            })}
        </p>
      )}

      {!approved && d.status === 'pending' && !isOwner && (
        <p className="mt-1 text-fg-subtle" data-testid="merge-once-owner-only">{t('mergeOnce.ownerOnly', { owner })}</p>
      )}

      {!approved && d.status === 'pending' && isOwner && (
        <div className="mt-2">
          {d.reason === 'cause_not_human' && <p className="mb-1 text-fg-muted" data-testid="merge-once-7day-note">{t('mergeOnce.sevenDayNoHelp')}</p>}
          {!open ? (
            <button type="button" data-testid="merge-once-open" onClick={() => setOpen(true)}
              className="rounded bg-accent px-2 py-1 font-medium text-fg-on-strong">
              {t('mergeOnce.open', { n: String(d.number) })}
            </button>
          ) : (
            <div className="space-y-1.5 rounded-row border border-border p-2" data-testid="merge-once-form">
              {device === 'checking' && <p className="text-fg-subtle">{t('mergeOnce.checking')}</p>}
              {(device === 'elsewhere' || device === 'no-surface') && (
                <p className="text-fg" data-testid="merge-once-elsewhere">{t('mergeOnce.elsewhere')}</p>
              )}
              {device === 'here' && (
                <>
                  <label className="flex flex-wrap items-center gap-2">
                    <span className="text-fg-muted">{t('mergeOnce.account')}</span>
                    <select data-testid="merge-once-account" value={ghUser} disabled={busy || merge === null || merge === 'error'}
                      onChange={(e) => setGhUser(e.target.value)}
                      className={`rounded-row border px-1.5 py-0.5 font-mono text-meta ${ghUser ? 'border-border bg-surface-sunken text-fg' : 'border-dashed border-warning-border bg-transparent text-warning'}`}>
                      <option value="" disabled>{t('mergeOnce.pick')}</option>
                      {sorted.map((a) => (
                        <option key={a.login} value={a.login} disabled={reach[a.login] === 'no'}>{a.login + mark(a.login)}</option>
                      ))}
                    </select>
                  </label>
                  {merge === 'error' && <p role="alert" className="text-danger">{t('mergeOnce.accountsFailed')}</p>}
                  {ghUser && reach[ghUser] !== 'ok' && (
                    <p className="text-warning" data-testid="merge-once-unknown">{t('mergeOnce.reachUnknown', { login: ghUser })}</p>
                  )}
                  <label className="flex items-start gap-2">
                    <input type="checkbox" data-testid="merge-once-relax" checked={relax} disabled={busy} onChange={(e) => setRelax(e.target.checked)} className="mt-0.5" />
                    <span>{t('mergeOnce.relax')}<span className="block text-fg-subtle">{t('mergeOnce.relaxHint')}</span></span>
                  </label>
                  <p className="text-fg-subtle">{t('mergeOnce.note')}</p>
                  <div className="flex items-center gap-2">
                    <button type="button" data-testid="merge-once-submit" disabled={busy || !ghUser} onClick={() => void submit()}
                      className="rounded bg-accent px-2 py-1 font-medium text-fg-on-strong disabled:opacity-60">
                      {t('mergeOnce.submit')}
                    </button>
                    <button type="button" className="text-fg-muted underline" onClick={() => setOpen(false)}>{t('mergeOnce.cancel')}</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {error && !approved && (
        <p role="alert" className="mt-1 text-danger" data-testid="merge-once-error" data-code={error.code} title={error.raw}>
          {error.code === 'denial_used' || error.code === 'already_decided' ? t('mergeOnce.errUsed')
            : error.code === 'denial_expired' || error.code === 'request_expired' ? t('mergeOnce.errExpired')
            : error.code === 'forbidden' ? t('mergeOnce.errForbidden')
            : t('mergeOnce.errFailed')}
        </p>
      )}
    </div>
  );
}
