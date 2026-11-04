import { orderToolRuleWarnings, type MessageRow, type PermissionCardLine, type PermissionCardLineLimits, type PermissionCardMandate, type PermissionMirrorMeta, type ToolRuleWarning } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useState, type ReactNode } from 'react';
import { useLocale, useT } from '../i18n/useT';
import { ApiError } from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import type { Translate } from '../i18n';
import { messageLinkFromMeta } from '../lib/link';
import { OnceCardRows, useOnceApproval } from './PermissionOncePanel';
import { CardMessageLink } from './CardMessageLink';
import { useDecideCheck } from './useDecideCheck';
import type { DecideCheck } from '../lib/api';
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
 * - 다른 스레드에서 정하는 자리(묶음 줄 `decideHere`) — 같은 몸을 그대로 끼운다. 판정은 서버가 하고 여기는 버튼을 보일지만 정한다.
 *   「이 위임장」이 보고 있는 스레드로 읽히지 않게 버튼 문구는 「원 스레드…」로 쓴다.
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
  // 중립 거울의 본문은 「원래 카드에서 확인」 안내와 링크뿐이다 — 카드 몸이 말하고, 볼 수 있는 사람에게는 원본 내용이 선다.
  if (src?.mirror?.neutral) return '';
  if (!src?.line) return body;
  const lines = body.split('\n');
  // H4: 서버가 쓴 경고 줄(meta `bodyWarningLine`)도 하나만 뺀다 — 줄 상자 안에 문장으로 그린다.
  const hidden = src.mirror ? [src.mirror.bodyTargetLine, src.mirror.bodyWarningLine] : [src.request?.bodyTargetLine, src.request?.bodyWarningLine];
  for (const raw of hidden) {
    if (typeof raw !== 'string' || !raw) continue;
    const i = lines.indexOf(raw);
    if (i >= 0) lines.splice(i, 1);
  }
  return lines.join('\n');
}

/** 원본 권한 카드 본문에서 카드 몸이 말하지 않는 줄(이유·실패 체크 등) — 다른 스레드에서 원본을 펼칠 때 쓴다. 평문이다. */
export function cardContextText(root: MessageRow): string {
  const lines = bodyForLineCard(root.body, root.meta).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines[0]?.startsWith('권한 요청 ·')) lines.shift();
  return lines.join('\n');
}

/** 원본 권한 카드 → 다른 자리에서 그릴 재료. 줄이 없는 옛 카드는 null(옛 카드는 하루 안에 끝나고 원 스레드에서 정한다). */
export function readRootSource(root: MessageRow): CardSource | null {
  return readCardSource(root.meta);
}

/** 원본 권한 카드의 (에이전트, 채널) — 결정권은 **요청 채널**로 묻는다(거울·묶음 채널이 아니다). */
export function requestTargetOf(root: MessageRow): { agentId: string; channelId: string } | null {
  const pr = root.meta?.permissionRequest as { agentId?: unknown; channelId?: unknown } | undefined;
  if (typeof pr?.agentId !== 'string') return null;
  return { agentId: pr.agentId, channelId: typeof pr.channelId === 'string' ? pr.channelId : root.channelId };
}

/** 카드가 그릴 경고 — 원본 요청(거울이면 거울에 옮긴 값)의 코드를 그리는 순서대로. 모르는 코드는 버린다. */
export function cardWarnings(src: CardSource): ToolRuleWarning[] {
  const raw = src.mirror ? src.mirror.warnings : src.request?.warnings;
  return Array.isArray(raw) ? orderToolRuleWarnings(raw) : [];
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
  if (l.turn) out.push(t('mandateCard.limit.turn'));
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

export function LineBox({ line, show, omitPr = false, warnings = [] }: { line: PermissionCardLine; show: string[]; omitPr?: boolean; warnings?: readonly ToolRuleWarning[] }) {
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
      {/* H4(designer 시안 v1): 한계 칩 아래 점선 뒤, 「⚠ 머리 — 까닭」 문장 목록. 위험한 것부터, 색은 경고색 하나. */}
      {warnings.length > 0 && (
        <ul className="mt-1.5 border-t border-dashed border-border pt-1.5" data-testid="mandate-line-warnings">
          {warnings.map((w) => (
            <li key={w} className="mt-0.5 flex gap-1.5 text-meta text-warning" data-warning={w}>
              <span aria-hidden>⚠</span>
              <span><b className="font-semibold">{t(`mandateCard.warn.${w}.head`)}</b> — {t(`mandateCard.warn.${w}.why`)}</span>
            </li>
          ))}
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
export function MandateLineBody({ message, src, canChoose, optionIds, answeredWith, closedReason, supersededBy, onOpenSettings, headSaysResult = false, decideHere, decideTarget, contextText }: {
  message: MessageRow; src: CardSource; canChoose: boolean; optionIds: string[];
  answeredWith: string | null; closedReason: string | null; supersededBy: string | null;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
  /** r5: 머리가 이미 결과(「거절함 · X」 등)를 말한다 — 같은 말만 하는 상태 줄은 뺀다(시각·계정·줄 끝·[줄 빼기] 같은 덧말은 남긴다). */
  headSaysResult?: boolean;
  /** 묶음 줄 — 답·[이번 한 번]을 묶음 길로 보내고, 버튼 줄 끝에 원 스레드 링크를 둔다. */
  decideHere?: {
    answer: (optionId: string) => Promise<{ status: number; code: string; message: string } | null>;
    once: (body: { ghUser?: string; relaxChecks: boolean; number: number; headSha: string; failedChecks?: string[] }) => Promise<{ approvalExpiresAt?: string }>;
    trailing?: ReactNode;
  };
  /** 거울 — 원본을 읽을 수 있으면 그 요청의 (에이전트, 채널). 받으면 소유자 아닌 결정권자에게도 버튼이 선다. */
  decideTarget?: { agentId: string; channelId: string } | null;
  /** 본문이 따로 서지 않는 자리(묶음 줄·중립 거울)에서 줄 상자 밑에 그릴 원본 본문. 평문이다. */
  contextText?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const me = useActiveStore((s) => s.me);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokedLocal, setRevokedLocal] = useState<string | null>(null);
  // 정할 사람: 원본 카드는 요청의 소유자, 거울은 서버가 원본 요청 행에서 채운 소유자(위임장 없는 카드도 서도록), 그다음 위임장 칩.
  const ownerOf = src.request && typeof src.request.ownerAccountId === 'string' ? src.request.ownerAccountId
    : typeof src.mirror?.ownerAccountId === 'string' ? src.mirror.ownerAccountId
      : src.mandate?.ownerId ?? null;
  const mirrorHref = messageLinkFromMeta(src.mirror?.rootId);
  const supersededHref = messageLinkFromMeta(supersededBy);
  const ownerHandle = useActiveStore((s) => (ownerOf ? s.accounts[ownerOf]?.handle ?? null : null));
  const onceByPanel = !!src.request && src.request.kind === 'merge' && !!src.request.once;
  const once = useOnceApproval(onceByPanel ? message : null, true, decideHere?.once);
  // P3: 정할 수 있는 사람(그 채널에서 이 에이전트를 부를 수 있는 사람)에게도 버튼을 그린다. 언제나 **요청 채널**로 묻는다 — 거울·묶음 채널로
  // 물으면 범위가 channel 인 에이전트에서 버튼과 서버 판정이 어긋난다. 거울은 원본을 읽었을 때만 안다. 받기 전·옛 서버·실패면 null → 소유자만 꼴.
  const reqAgentId = src.request && typeof src.request.agentId === 'string' ? src.request.agentId : null;
  const reqChannelId = src.request && typeof src.request.channelId === 'string' ? src.request.channelId : message.channelId;
  const check = useDecideCheck(src.mirror ? decideTarget?.agentId ?? null : reqAgentId, src.mirror ? decideTarget?.channelId ?? null : reqChannelId);
  const [answerError, setAnswerError] = useState<string | null>(null);

  if (src.mirror?.neutral) {
    return (
      <div className="px-3 pb-2 pt-1 text-meta" data-testid="mandate-mirror-neutral">
        <p className="text-fg-muted">{t('mandateCard.mirrorNeutral')}</p>
      </div>
    );
  }
  const line = src.line;
  const status = typeof src.request?.status === 'string' ? src.request.status : null;
  const onceAvailable = !!line?.limits.approve_once;
  // t1(designer A안): 서버가 선택지를 실을 때만 [이번 턴만]을 그린다 — 흐린 버튼은 두지 않는다.
  const turnAvailable = optionIds.includes('approve_turn');
  const standing = optionIds.find((id) => STANDING.includes(id)) ?? null;
  // 소유자를 모르면 **소유자가 아니라고 본다** — 버튼 없이 읽기 전용(「소유자만」 줄)으로 그린다.
  const viewerIsOwner = !!ownerOf && !!me && me.id === ownerOf;
  // 버튼을 그릴 사람. 위임장 칩·줄 빼기·[계정 바꾸기]는 이 값이 아니라 소유자만이다.
  const canDecide = viewerIsOwner || check?.viewerCanDecide === true;
  const pending = answeredWith == null && closedReason == null && (status == null || status === 'pending') && !(onceByPanel && once.done);
  const ended = !pending;
  // 끝난 카드는 고른 선택지의 한도만, 열린 카드는 주 버튼(없으면 한 번)의 한도를 보인다.
  const shownLimits = ended
    ? [answeredWith ?? (status === 'approved_once' ? 'approve_once' : '')].filter(Boolean)
    : standing ? [standing] : onceAvailable ? ['approve_once'] : [];
  const elsewhere = !!decideHere || !!src.mirror;
  // 계정 고르기는 소유자만이다(서버도 소유자가 아니면 계정을 비운다). 소유자 아닌 결정권자에게는 누가 고르는지만 말한다.
  const canPickAccount = check ? check.asOwner : viewerIsOwner;
  const answer = (id: string) => {
    setAnswerError(null);
    const sent = decideHere ? decideHere.answer(id) : getController().answerAsk(message.id, id, message.channelId);
    void sent.then((err) => {
      if (err) setAnswerError(answerErrorText(err, t));
    });
  };

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
          {supersededHref ? <CardMessageLink messageId={supersededBy} className="text-accent underline" testId="mandate-new-card">{t('mandateCard.openNewCard')}</CardMessageLink> : t('mandateCard.askAgain')}
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
    // t1: 「이번 턴만」은 그 턴이 끝나면 저절로 빠진다 — [줄 빼기]를 두지 않는다.
    if (answeredWith === 'approve_turn') return headSaysResult ? null : <p className="text-fg" data-testid="mandate-ended" data-state="turn">✓ {t('mandateCard.ended.turn')}</p>;
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
              {!headSaysResult && <>✓ {t(elsewhere ? 'mandateCard.ended.addedElsewhere' : 'mandateCard.ended.added')}</>}
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
          {mirrorHref && <CardMessageLink messageId={src.mirror?.rootId} className="text-accent underline" testId="mandate-mirror-link">{t('mandateCard.openOriginal')}</CardMessageLink>}
        </p>
      )}
      {/* 칩은 소유자에게만 보인다(시안 「남이 볼 때」 — 다른 채널의 위임장이 드러나지 않게). */}
      {viewerIsOwner && <MandateChip mandate={src.mandate} />}
      {line && <LineBox line={line} show={shownLimits} omitPr={onceByPanel && !!once.d} warnings={cardWarnings(src)} />}
      {contextText && <p className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-meta text-fg-muted" data-testid="mandate-context">{contextText}</p>}
      {onceByPanel && <OnceCardRows s={once} canAct={canChoose && canPickAccount && once.isOwner} />}
      {onceByPanel && pending && canChoose && canDecide && !canPickAccount && <p className="mt-1 text-meta text-fg-subtle" data-testid="merge-once-operator-picks">{t('mergeOnce.rowAccount')}: {t('mergeOnce.pick')}</p>}
      {pending && !canDecide && (
        <p className="mt-1 text-meta text-fg-subtle" data-testid="mandate-owner-only" data-scope={check?.decideScope ?? undefined}>{waitingText(check, ownerHandle, t)}</p>
      )}
      {pending && canChoose && canDecide && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {standing && (
            <button type="button" data-testid={`ask-option-${standing}`} onClick={() => answer(standing)}
              className="rounded bg-accent px-2.5 py-1 text-body font-medium text-fg-on-strong">
              {t(standing === 'approve_new_mandate'
                ? (elsewhere ? 'mandateCard.approveNewElsewhere' : 'mandateCard.approveNew')
                : (elsewhere ? 'mandateCard.approveMandateElsewhere' : 'mandateCard.approveMandate'))}
            </button>
          )}
          {turnAvailable && (
            <button type="button" data-testid="ask-option-approve_turn" onClick={() => answer('approve_turn')}
              title={t('mandateCard.turnTitle')} aria-label={`${t('mandateCard.turn')} — ${t('mandateCard.turnTitle')}`}
              className={standing ? SECONDARY : PRIMARY}>
              {t('mandateCard.turn')}
            </button>
          )}
          {onceAvailable && !onceByPanel && (
            <button type="button" data-testid="ask-option-approve_once" onClick={() => answer('approve_once')}
              className={standing ? SECONDARY : PRIMARY}>
              {line?.limits.approve_once?.ciOverride ? t('mandateCard.onceCi') : t('mandateCard.once')}
            </button>
          )}
          {onceByPanel && (
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
          {onceByPanel && once.isOwner && canPickAccount && !once.open && (
            <button type="button" data-testid="merge-once-change-account" onClick={() => once.setOpen(true)}
              className="ml-auto rounded-sm px-1 py-0.5 text-meta text-fg-subtle underline decoration-dotted underline-offset-2 hover:text-fg-muted">
              {t('mergeOnce.changeAccount')}
            </button>
          )}
          {decideHere?.trailing && <span className="ml-auto">{decideHere.trailing}</span>}
        </div>
      )}
      {pending && answerError && <p className="mt-1 text-meta text-danger" role="alert" data-testid="mandate-answer-error">{answerError}</p>}
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

/**
 * 정할 수 없는 사람에게 보이는 「누가 정하나」 줄(designer 시안 v2 ③). 서버 값(`decideScope`)이 없으면(받기 전·옛 서버) 전처럼 소유자 줄.
 */
function waitingText(check: DecideCheck | null, owner: string | null, t: Translate): string {
  const scope = check?.decideScope ?? null;
  // n1(designer): 소유자 이름을 모르면 범위를 아는 만큼만 말한다 — 「부를 수 있는 사람」은 owner·switchOff 범위면 사실이 아니다.
  if (!owner) {
    switch (scope) {
      case 'owner': return t('decideBy.unnamed.owner');
      case 'switchOff': return t('decideBy.unnamed.switchOff');
      case 'list': return t('decideBy.unnamed.list');
      case 'channel': return t('decideBy.unnamed.channel');
      case 'community': return t('decideBy.unnamed.community');
      default: return t('mandateCard.ownerOnlyUnknown');
    }
  }
  switch (scope) {
    case 'list': return t('decideBy.list', { owner });
    case 'channel': return t('decideBy.channel', { owner });
    case 'community': return t('decideBy.community', { owner });
    case 'switchOff': return t('decideBy.switchOff', { owner });
    case 'owner': return t('decideBy.owner', { owner });
    default: return t('mandateCard.ownerOnly', { owner });
  }
}

/** 카드 답이 거절됐을 때 사람이 읽을 이유 — 이미 정해진 카드(409 경합)는 다시 받은 카드가 말하므로 줄을 달지 않는다. */
export function answerErrorText(err: { status: number; code: string; message: string }, t: Translate): string | null {
  if (err.code === 'already_answered' || err.code === 'already_decided' || err.code === 'superseded') return null;
  if (err.code === 'mandate_unavailable') return t('mandateCard.errMandateUnavailable');
  if (err.code === 'forbidden') return t('mandateCard.errForbidden');
  return t('mandateCard.errFailed', { reason: err.message || err.code });
}
