import type { MessageRow, PermissionCardLine, PermissionCardLineLimits, PermissionCardMandate, PermissionMirrorMeta } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useState } from 'react';
import { useLocale, useT } from '../i18n/useT';
import { ApiError } from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import type { Translate } from '../i18n';
import { messageLinkFromMeta } from '../lib/link';
import { OnceCardRows, useOnceApproval } from './PermissionOncePanel';
import type { SectionId } from './settings/sections';

/**
 * W4 「위임장에 줄 더하기」 카드의 몸(designer 시안 v1, i1). `AskCard` 가 선택지 목록 대신 이것을 그린다.
 *
 * - 🔑 위임장 칩 — 이름이 비면(청중이 위임장 뿌리 채널을 다 못 봄) 「위임장 · 소유자 · MM-DD 시작」.
 * - 줄 상자 — cap 표시(색과 글자 함께) · scope(고정폭) · 선택지별 한도 칩.
 * - 버튼 — 주 버튼 [이 위임장 동안] 또는 [이 스레드로 위임장 만들고 더하기], 보조 [이번 한 번], [거절]은 밑줄 글자.
 *   원본 머지 거절 카드는 한 카드다(g5): PR·head·실패 체크·계정 줄은 `OnceCardRows` 가 카드 안에 그리고, [이번 한 번] 버튼은 여기 하나뿐이다.
 *   그 버튼은 고른 계정(없으면 비움 — 오퍼레이터가 고름)으로 `approvePermissionOnce` 를 보낸다. 거울에는 계정 고르기가 없다(W4-2).
 * - 거울 — 진짜 거울은 `permissionMirror` 의 once·line·mandate 로 같은 카드를, 중립 거울은 원본 링크 한 줄만.
 * - 끝난 카드 — 줄 상자는 남기고 상태 줄 하나.
 */
export type CardSource = {
  line: PermissionCardLine | null;
  mandate: PermissionCardMandate | null;
  mirror: PermissionMirrorMeta | null;
  /** 원본 권한 카드의 `permissionRequest`(거울이면 null). */
  request: Record<string, unknown> | null;
};

export function readCardSource(meta: Record<string, unknown> | undefined): CardSource | null {
  if (!meta) return null;
  const mirror = meta.permissionMirror as PermissionMirrorMeta | undefined;
  if (mirror && typeof mirror.rootId === 'string') {
    return { line: mirror.neutral ? null : validLine(mirror.line), mandate: mirror.neutral ? null : validMandate(mirror.mandate), mirror, request: null };
  }
  const pr = meta.permissionRequest as Record<string, unknown> | undefined;
  if (!pr) return null;
  const line = validLine(pr.line);
  if (!line) return null;
  return { line, mandate: validMandate(pr.mandate), mirror: null, request: pr };
}

/**
 * r5(designer F1): 줄 상자를 그리는 카드면 본문에서 서버가 쓴 대상 줄(meta `bodyTargetLine`) **하나만** 뺀다 — 줄 상자가 같은 것을
 * 말한다. 옛 앱·줄 상자를 못 그리는 카드는 본문을 그대로 둔다(그래야 무엇을 허락하는지 읽힌다). 조건은 `AskCard` 가
 * `MandateLineBody` 의 `LineBox` 를 그리는 조건과 같다: `meta.ask` 가 있고, 중립 거울이 아니고, 줄이 있다.
 */
export function bodyForLineCard(body: string, meta: Record<string, unknown> | undefined): string {
  if (!meta || !meta.ask) return body;
  const src = readCardSource(meta);
  if (!src?.line || src.mirror?.neutral) return body;
  const raw = src.mirror ? src.mirror.bodyTargetLine : src.request?.bodyTargetLine;
  if (typeof raw !== 'string' || !raw) return body;
  const lines = body.split('\n');
  const i = lines.indexOf(raw);
  if (i < 0) return body;
  lines.splice(i, 1);
  return lines.join('\n');
}

function validLine(v: unknown): PermissionCardLine | null {
  const l = v as PermissionCardLine | undefined;
  if (!l || typeof l.cap !== 'string' || typeof l.scope !== 'string') return null;
  return { cap: l.cap, scope: l.scope, limits: l.limits && typeof l.limits === 'object' ? l.limits : {} };
}
function validMandate(v: unknown): PermissionCardMandate | null {
  const m = v as PermissionCardMandate | undefined;
  return m && typeof m.id === 'string' ? { id: m.id, name: typeof m.name === 'string' ? m.name : '', ownerId: m.ownerId, startedAt: m.startedAt } : null;
}

/** MM-DD — 칩의 시작일. 로캘 문장이 아니라 고정 꼴이다(시안 「10-21 시작」). */
export function mmdd(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const CAP_CLASS: Record<string, string> = {
  merge: 'border-accent bg-accent-surface text-accent',
  tool: 'border-border bg-surface-sunken text-fg-muted',
  command: 'border-warning-border bg-warning-surface text-warning',
  bypass: 'border-danger-border bg-danger-surface text-danger',
};

function untilText(ms: number, t: Translate): string {
  return ms >= 86_400_000 ? t('mandateCard.limit.days', { n: String(Math.round(ms / 86_400_000)) }) : t('mandateCard.limit.hours', { n: String(Math.max(1, Math.round(ms / 3_600_000))) });
}

/** `omitPr` — 카드 안에 PR 줄(`OnceCardRows`)이 따로 서면 PR·head 칩은 같은 말이라 뺀다(g-n1). head 는 어디서나 7자(g-n2). */
export function limitChips(l: PermissionCardLineLimits | undefined, t: Translate, omitPr = false): string[] {
  if (!l) return [];
  const out: string[] = [];
  if (l.pr != null && !omitPr) out.push(`PR #${l.pr}`);
  if (l.head && !omitPr) out.push(`head ${l.head.slice(0, 7)}`);
  if (l.ciOverride) out.push(t('mandateCard.limit.ci'));
  if (l.uses != null) out.push(t('mandateCard.limit.uses', { n: String(l.uses) }));
  if (l.untilMs != null) out.push(untilText(l.untilMs, t));
  return out;
}

export function MandateChip({ mandate }: { mandate: PermissionCardMandate | null }) {
  const t = useT();
  const owner = useActiveStore((s) => (mandate?.ownerId ? s.accounts[mandate.ownerId]?.handle ?? null : null));
  if (!mandate) {
    return <div className="text-meta text-fg-muted" data-testid="mandate-chip" data-none><span className="rounded-row border border-border px-1.5 py-0.5">🔑 {t('mandateCard.noMandate')}</span> <span className="text-fg-subtle">{t('mandateCard.noMandateHint')}</span></div>;
  }
  const date = mmdd(mandate.startedAt);
  const parts = [mandate.name || t('mandateCard.mandate'), owner, date ? t('mandateCard.started', { date }) : null].filter(Boolean);
  return (
    <div className="text-meta" data-testid="mandate-chip" data-nameless={mandate.name ? undefined : true}>
      <span className="rounded-row border border-border bg-surface-raised px-1.5 py-0.5 text-fg">🔑 {parts.join(' · ')}</span>
    </div>
  );
}

export function LineBox({ line, show, omitPr = false }: { line: PermissionCardLine; show: string[]; omitPr?: boolean }) {
  const t = useT();
  const chips = show.flatMap((id) => limitChips(line.limits[id as keyof PermissionCardLine['limits']], t, omitPr));
  return (
    <div className="mt-1 rounded-row border border-border bg-surface-raised px-2 py-1.5" data-testid="mandate-line" data-cap={line.cap}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={`rounded-row border px-1.5 text-meta font-semibold ${CAP_CLASS[line.cap] ?? CAP_CLASS.tool}`} data-testid="mandate-line-cap">{line.cap}</span>
        <span className="break-all font-mono text-meta text-fg" data-testid="mandate-line-scope">{line.scope}</span>
      </div>
      {chips.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1" data-testid="mandate-line-limits">
          {[...new Set(chips)].map((c) => <li key={c} className="rounded-row bg-surface-sunken px-1.5 text-meta text-fg-muted">{c}</li>)}
        </ul>
      )}
    </div>
  );
}

const STANDING = ['approve_mandate', 'approve_new_mandate', 'approve'];
const PRIMARY = 'rounded bg-accent px-2.5 py-1 text-body font-medium text-fg-on-strong';
const SECONDARY = 'rounded border border-border bg-surface-raised px-2.5 py-1 text-body text-fg hover:bg-surface-hover';

/**
 * 줄 상자와 버튼. `canChoose` 는 `AskCard` 가 정한다(내 차례이고 열려 있음).
 * `onceByPanel` — 원본 머지 거절 카드라 [이번 한 번]은 계정을 실어 `approvePermissionOnce` 로 보낸다(선택지 답이 아니다).
 */
export function MandateLineBody({ message, src, canChoose, optionIds, answeredWith, closedReason, supersededBy, onOpenSettings, headSaysResult = false }: {
  message: MessageRow; src: CardSource; canChoose: boolean; optionIds: string[];
  answeredWith: string | null; closedReason: string | null; supersededBy: string | null;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
  /** r5: 머리가 이미 결과(「거절함 · X」 등)를 말한다 — 같은 말만 하는 상태 줄은 뺀다(시각·계정·줄 끝·[줄 빼기] 같은 덧말은 남긴다). */
  headSaysResult?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const me = useActiveStore((s) => s.me);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokedLocal, setRevokedLocal] = useState<string | null>(null);
  const ownerOf = src.request && typeof src.request.ownerAccountId === 'string' ? src.request.ownerAccountId : src.mandate?.ownerId ?? null;
  const mirrorHref = messageLinkFromMeta(src.mirror?.rootId);
  const supersededHref = messageLinkFromMeta(supersededBy);
  const ownerHandle = useActiveStore((s) => (ownerOf ? s.accounts[ownerOf]?.handle ?? null : null));
  const onceByPanel = !!src.request && src.request.kind === 'merge' && !!src.request.once;
  const once = useOnceApproval(onceByPanel ? message : null, true);

  if (src.mirror?.neutral) {
    return (
      <div className="px-3 pb-2 pt-1 text-meta" data-testid="mandate-mirror-neutral">
        <p className="text-fg-muted">{t('mandateCard.mirrorNeutral')}</p>
        {mirrorHref && <a className="text-accent underline" href={mirrorHref} data-testid="mandate-mirror-link">{t('mandateCard.openOriginal')}</a>}
      </div>
    );
  }
  const line = src.line;
  const status = typeof src.request?.status === 'string' ? src.request.status : null;
  const onceAvailable = !!line?.limits.approve_once;
  const standing = optionIds.find((id) => STANDING.includes(id)) ?? null;
  // 소유자를 모르면 **소유자가 아니라고 본다** — 버튼 없이 읽기 전용(「소유자만」 줄)으로 그린다.
  const viewerIsOwner = !!ownerOf && !!me && me.id === ownerOf;
  const pending = answeredWith == null && closedReason == null && (status == null || status === 'pending') && !(onceByPanel && once.done);
  const ended = !pending;
  // 끝난 카드는 고른 선택지의 한도만, 열린 카드는 주 버튼(없으면 한 번)의 한도를 보인다.
  const shownLimits = ended
    ? [answeredWith ?? (status === 'approved_once' ? 'approve_once' : '')].filter(Boolean)
    : standing ? [standing] : onceAvailable ? ['approve_once'] : [];
  const answer = (id: string) => { void getController().answerAsk(message.id, id, message.channelId); };

  // 줄 빼기(g1) — 카드가 자기 줄 id(`lineId`, 새 서버만 싣는다)를 가질 때만. 원본 카드에서 소유자에게만(거울에는 없다).
  const lineId = typeof src.request?.lineId === 'string' ? src.request.lineId : null;
  const revokedAt = revokedLocal ?? (typeof src.request?.lineRevokedAt === 'string' ? src.request.lineRevokedAt : null);
  const canRevoke = !!lineId && !!src.mandate?.id && !src.mirror && !!me && me.id === ownerOf;
  const revokedTime = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  };
  // 같은 결정으로 준 7일 허락(account_grant)이 아직 살아 있는가(designer s1, G1-b). 카드 meta 의 `grantExpiresAt` 은
  // 7일 승인이면 그 grant 의 기한이다(줄의 `limits.until` 과 같은 값). 명령 카드의 기한은 command_grant(한 번·한 시간)라 뺀다.
  // 설정에서 따로 거둔 뒤인지는 카드가 모른다 — 기한만 본다.
  const grantExpiresAt = typeof src.request?.grantExpiresAt === 'string' ? src.request.grantExpiresAt : null;
  const grantLive = !!grantExpiresAt && src.request?.kind !== 'command' && status === 'granted'
    && !(answeredWith && !STANDING.includes(answeredWith)) && new Date(grantExpiresAt).getTime() > Date.now();
  const grantAgentId = typeof src.request?.agentId === 'string' ? src.request.agentId : null;
  const grantDate = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const revoke = async () => {
    if (!lineId || !src.mandate?.id) return;
    setRevokeBusy(true); setRevokeError(null);
    try {
      const r = await getController().api.revokeMandateLine(src.mandate.id, lineId);
      setRevokedLocal(r.revokedAt);
      setConfirmingRevoke(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'already_revoked') { setRevokedLocal(new Date().toISOString()); setConfirmingRevoke(false); }
      else setRevokeError(err instanceof ApiError && err.code === 'standing_line' ? t('mandateCard.revokeStanding') : t('mandateCard.revokeFailed'));
    } finally {
      setRevokeBusy(false);
    }
  };

  const endedLine = (() => {
    if (!ended) return null;
    if (closedReason === 'superseded' || status === 'superseded') {
      return (
        <p className="text-fg-subtle" data-testid="mandate-ended" data-state="superseded">
          {t('mandateCard.ended.superseded')}{' '}
          {supersededHref ? <a className="text-accent underline" href={supersededHref} data-testid="mandate-new-card">{t('mandateCard.openNewCard')}</a> : t('mandateCard.askAgain')}
        </p>
      );
    }
    if (closedReason === 'expired' || status === 'expired') {
      return <p className="text-fg-subtle" data-testid="mandate-ended" data-state="expired">{t('mandateCard.ended.expired')} · {t('mandateCard.askAgain')}</p>;
    }
    if (status === 'denied' || answeredWith === 'deny') return headSaysResult ? null : <p className="text-fg-muted" data-testid="mandate-ended" data-state="denied">✕ {t('mandateCard.ended.denied')}</p>;
    if (onceByPanel && (status === 'approved_once' || once.done)) return null; // OnceCardRows 가 계정·기한과 함께 그린다.
    if (status === 'approved_once' || answeredWith === 'approve_once' || answeredWith === 'approve_hour') {
      const used = typeof src.request?.ghUserUsed === 'string' ? src.request.ghUserUsed : typeof src.mirror?.ghUserUsed === 'string' ? src.mirror.ghUserUsed : null;
      if (headSaysResult) return used ? <p className="text-fg" data-testid="mandate-ended" data-state="once">gh {used}</p> : null;
      return <p className="text-fg" data-testid="mandate-ended" data-state="once">✓ {t('mandateCard.ended.once')}{used ? ` · gh ${used}` : ''}</p>;
    }
    if (status === 'obsolete') return null; // PermissionOncePanel 이 머지·닫힘 줄을 그린다.
    if (status === 'granted' || (answeredWith && STANDING.includes(answeredWith))) {
      const mandateEnded = typeof (src.mandate as { endedAt?: unknown } | null)?.endedAt === 'string';
      return mandateEnded
        ? <p className="text-fg-subtle" data-testid="mandate-ended" data-state="mandate-ended">{t('mandateCard.ended.mandateEnded')}</p>
        : revokedAt
          ? <p className="text-fg-subtle" data-testid="mandate-ended" data-state="revoked" data-grant-live={grantLive ? true : undefined}>
              {t(grantLive ? 'mandateCard.ended.revokedGrantLive' : 'mandateCard.ended.revoked', { time: revokedTime(revokedAt) })}
            </p>
          : (
            headSaysResult && !canRevoke ? null : <p className="text-fg" data-testid="mandate-ended" data-state="added">
              {!headSaysResult && <>✓ {t('mandateCard.ended.added')}</>}
              {canRevoke && (
                <>
                  {' '}
                  <button type="button" data-testid="mandate-line-revoke" aria-label={t('mandateCard.revokeAria')}
                    onClick={() => { setRevokeError(null); setConfirmingRevoke(true); }}
                    className="rounded-sm px-1 py-0.5 text-meta text-fg-subtle underline underline-offset-2 hover:bg-surface-hover hover:text-fg-muted">
                    {t('mandateCard.revoke')}
                  </button>
                </>
              )}
            </p>
          );
    }
    return null;
  })();

  return (
    <div className="px-3 pb-2 pt-1" data-testid="mandate-body">
      {src.mirror && (
        <p className="mb-1 text-meta text-fg-subtle" data-testid="mandate-mirror-genuine">
          ↪ {t('mandateCard.mirror')}{' '}
          {mirrorHref && <a className="text-accent underline" href={mirrorHref} data-testid="mandate-mirror-link">{t('mandateCard.openOriginal')}</a>}
        </p>
      )}
      {/* 칩은 소유자에게만 보인다(시안 「남이 볼 때」 — 다른 채널의 위임장이 드러나지 않게). */}
      {viewerIsOwner && <MandateChip mandate={src.mandate} />}
      {line && <LineBox line={line} show={shownLimits} omitPr={onceByPanel && !!once.d} />}
      {onceByPanel && <OnceCardRows s={once} canAct={canChoose && viewerIsOwner && once.isOwner} />}
      {pending && !viewerIsOwner && (
        <p className="mt-1 text-meta text-fg-subtle" data-testid="mandate-owner-only">{ownerHandle ? t('mandateCard.ownerOnly', { owner: ownerHandle }) : t('mandateCard.ownerOnlyUnknown')}</p>
      )}
      {pending && canChoose && viewerIsOwner && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {standing && (
            <button type="button" data-testid={`ask-option-${standing}`} onClick={() => answer(standing)}
              className="rounded bg-accent px-2.5 py-1 text-body font-medium text-fg-on-strong">
              {t(standing === 'approve_new_mandate' ? 'mandateCard.approveNew' : 'mandateCard.approveMandate')}
            </button>
          )}
          {onceAvailable && !onceByPanel && (
            <button type="button" data-testid="ask-option-approve_once" onClick={() => answer('approve_once')}
              className={standing ? SECONDARY : PRIMARY}>
              {line?.limits.approve_once?.ciOverride ? t('mandateCard.onceCi') : t('mandateCard.once')}
            </button>
          )}
          {onceByPanel && once.isOwner && (
            <button type="button" data-testid="ask-option-approve_once" data-once-panel disabled={once.busy} onClick={() => void once.submit()}
              className={`${standing ? SECONDARY : PRIMARY} disabled:opacity-60`}>
              {once.ci || line?.limits.approve_once?.ciOverride ? t('mandateCard.onceCi') : t('mandateCard.once')}
            </button>
          )}
          {optionIds.includes('deny') && (
            <button type="button" data-testid="ask-option-deny" aria-label={t('mandateCard.denyAria')} onClick={() => answer('deny')}
              className="rounded-sm px-1 py-0.5 text-meta text-fg-subtle underline underline-offset-2 hover:bg-surface-hover hover:text-fg-muted">
              {t('mandateCard.deny')}
            </button>
          )}
          {onceByPanel && once.isOwner && !once.open && (
            <button type="button" data-testid="merge-once-change-account" onClick={() => once.setOpen(true)}
              className="ml-auto rounded-sm px-1 py-0.5 text-meta text-fg-subtle underline decoration-dotted underline-offset-2 hover:text-fg-muted">
              {t('mergeOnce.changeAccount')}
            </button>
          )}
        </div>
      )}
      {endedLine && <div className="mt-1.5 text-meta">{endedLine}</div>}
      {confirmingRevoke && (
        <ConfirmDialog
          title={t('mandateCard.revokeTitle')}
          detail={grantLive && grantExpiresAt
            ? (
              <span data-testid="mandate-revoke-grant-live">
                {t('mandateCard.revokeDetailGrantLive', { date: grantDate(grantExpiresAt) })}
                {onOpenSettings && grantAgentId && (
                  <>
                    {' '}
                    <button type="button" data-testid="mandate-revoke-open-grants"
                      onClick={() => { setConfirmingRevoke(false); onOpenSettings('agents', `${grantAgentId}#permissions`); }}
                      className="text-accent underline underline-offset-2">
                      {t('mandateCard.revokeOpenGrants')}
                    </button>
                  </>
                )}
              </span>
            )
            : t('mandateCard.revokeDetail')}
          detailKind="note"
          confirmLabel={t('mandateCard.revokeConfirm')}
          cancelLabel={t('mandateCard.revokeCancel')}
          danger
          busy={revokeBusy}
          error={revokeError}
          onConfirm={() => { void revoke(); }}
          onCancel={() => setConfirmingRevoke(false)}
        />
      )}
    </div>
  );
}
