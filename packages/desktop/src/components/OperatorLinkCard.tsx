/**
 * 이 맥 오퍼레이터가 서버와 끊겼을 때의 경고 카드(안 A, designer 시안 v1, 소유자 승인 2026-11-26). 판정은 `lib/operatorLink.ts`.
 *
 * 로그인 끊김 카드와 **같은 자리·같은 틀**이다(`AttentionStack` 이 쌓는다). 재시도 중은 노랑 `role=status`(닫기 없음),
 * 오래 끊김은 빨강 `role=alert`(OS 알림 1회, [지금 다시 시도][자세히][나중에]), 다시 붙음은 초록 `role=status`(저절로 걷힘).
 * 원문 오류는 오지 않는다 — 까닭 낱말과 시각·횟수만 그린다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ServerLinkState } from '@harkroom/shared/daemonProtocol';
import { useActiveStore, useCommunityRegistry } from '../state/communities';
import { useLocale, useT } from '../i18n/useT';
import type { MessageKey } from '../i18n';
import {
  getOperatorLink, hasOperatorLinkSurface, hostOfBaseUrl, LINK_BACK_HOLD_MS, linkActionKey, linkDismissKey, linkPhase,
  listenOperatorLink, retryOperatorLinkNow, retryUnlockDelayMs, type LinkPhase,
} from '../lib/operatorLink';
import { hasOperatorLocalSurface, listLocalAgents } from '../lib/operatorLocal';
import { createNotifier } from '../lib/notify';
import { useOperatorLinkStore } from '../state/operatorLinkStore';
import type { SectionId } from './settings/sections';

const NOTIFIED_KEY = 'harkroom.opLink.notified';
/** 「다시 붙음」 카드를 아무리 길어도 이만큼만 둔다(러너가 끝내 안 뜨면 그 일은 러너 칩이 말한다). */
const BACK_MAX_MS = 3 * 60_000;

const REASON_KEY: Record<string, MessageKey> = {
  dns: 'opLink.reason.dns',
  offline: 'opLink.reason.offline',
  closed: 'opLink.reason.closed',
  refused: 'opLink.reason.refused',
  tls: 'opLink.reason.tls',
  auth: 'opLink.reason.auth',
  other: 'opLink.reason.other',
};

export interface OperatorLinkView {
  link: ServerLinkState | null;
  phase: LinkPhase;
  /** 카드가 섰던 끊김 뒤 다시 붙었다 — 끊김 시작·끝 시각. */
  back: { downSinceMs: number; upAtMs: number } | null;
  localAgentIds: readonly string[];
  community: string | null;
  /** 초록 카드가 걷혔다 — back 을 비워 타이머를 멈춘다. */
  clearBack: () => void;
}

/** 지금 커뮤니티의 링크 상태를 듣고 단계를 가린다. 표면이 없으면(웹·테스트) 아무것도 안 한다. */
export function useOperatorLinkWatch(): OperatorLinkView {
  const available = hasOperatorLinkSurface();
  const community = useCommunityRegistry((r) => r.entries.find((e) => e.id === r.activeId)?.baseUrl || null);
  const host = hostOfBaseUrl(community);
  const [link, setLink] = useState<ServerLinkState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [back, setBack] = useState<{ downSinceMs: number; upAtMs: number } | null>(null);
  const [localAgentIds, setLocalAgentIds] = useState<readonly string[]>([]);
  const shownDown = useRef<number | null>(null);

  useEffect(() => {
    setLink(null);
    setBack(null);
    shownDown.current = null;
    if (!available || !host) return undefined;
    let alive = true;
    const take = (l: ServerLinkState | null): void => {
      if (!alive || !l || l.host.toLowerCase() !== host) return;
      setLink(l);
    };
    void getOperatorLink(community).then(take);
    const off = listenOperatorLink(take);
    return () => { alive = false; void off.then((f) => f()); };
  }, [available, host, community]);

  // 이 맥 오퍼레이터가 맡은 에이전트 — 링크가 나빠질 때 다시 읽는다.
  const down = link?.state === 'down';
  useEffect(() => {
    if (!available || !hasOperatorLocalSurface() || !host) return;
    let alive = true;
    void listLocalAgents(community).then((r) => {
      const c = r.communities.find((x) => hostOfBaseUrl(x.baseUrl) === host);
      if (alive) setLocalAgentIds(c ? Object.keys(c.agents) : []);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [available, host, community, down]);

  // 시각이 흐르며 단계가 바뀐다(60초·5분 문턱) — 끊겨 있거나 다시 붙음을 보일 때만 깨어난다.
  useEffect(() => {
    if (!down && !back) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [down, back]);

  const phase = linkPhase(link, now);
  // 카드가 섰던 끊김을 기억해 두었다가 다시 붙으면 초록 카드로 잇는다.
  useEffect(() => {
    if (phase !== 'ok' && link?.downSinceMs != null) shownDown.current = link.downSinceMs;
    if (link?.state === 'up' && shownDown.current !== null) {
      setBack({ downSinceMs: shownDown.current, upAtMs: link.lastUpMs ?? Date.now() });
      shownDown.current = null;
    }
    if (link?.state === 'down') setBack(null);
  }, [phase, link]);

  useEffect(() => { useOperatorLinkStore.setState({ phase, localAgentIds }); }, [phase, localAgentIds]);
  const clearBack = useCallback(() => setBack(null), []);
  return { link, phase, back, localAgentIds, community, clearBack };
}

function useDuration(): (ms: number) => string {
  const t = useT();
  return (ms) => {
    const min = Math.max(0, Math.floor(ms / 60_000));
    const h = Math.floor(min / 60);
    if (h > 0) return min % 60 === 0 ? t('opLink.dur.h', { h }) : t('opLink.dur.hm', { h, m: min % 60 });
    return t('opLink.dur.m', { m: Math.max(1, min) });
  };
}

function readSet(key: string): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}
function writeSet(key: string, set: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...set].slice(-50))); } catch { /* 저장 못 해도 화면은 돈다 */ }
}

/** 카드 한 장 — 그릴 것이 없으면 null. `AttentionStack` 이 자리를 잡는다. */
export function useOperatorLinkCard(view: OperatorLinkView, onOpenSettings: (section?: SectionId) => void): ReactElement | null {
  const t = useT();
  const locale = useLocale();
  const dur = useDuration();
  const online = useActiveStore((s) => s.online);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [backDoneAt, setBackDoneAt] = useState<number | null>(null);
  const notified = useRef<Set<string>>(readSet(NOTIFIED_KEY));
  const notifier = useMemo(() => createNotifier(), []);
  const focusSeq = useOperatorLinkStore((s) => s.focusSeq);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const { link, phase, back, localAgentIds, community, clearBack } = view;
  // [지금 다시 시도] 누른 뒤 잠금 — 다음 serverLinkState(최소 1.5초 표시, 다시 붙음이면 곧바로)·5초·retried:false 중 먼저 오는 것에 푼다.
  const [retrying, setRetrying] = useState(false);
  const pressed = useRef<{ atMs: number; link: ServerLinkState | null } | null>(null);
  useEffect(() => {
    const p = pressed.current;
    if (!retrying || !p || link === p.link) return undefined;
    const wait = retryUnlockDelayMs(p.atMs, Date.now(), link);
    if (wait === 0) { setRetrying(false); return undefined; }
    const timer = setTimeout(() => setRetrying(false), wait);
    return () => clearTimeout(timer);
  }, [link, retrying]);
  useEffect(() => {
    if (!retrying) return undefined;
    const timer = setTimeout(() => setRetrying(false), 5_000);
    return () => clearTimeout(timer);
  }, [retrying]);
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  const at = (ms: number | null): string | null => {
    if (ms === null) return null;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : time.format(d);
  };

  // 칩을 눌렀다 — 접어 둔 카드를 다시 펴고 초점을 준다.
  useEffect(() => {
    if (focusSeq === 0) return;
    setDismissed(null);
    requestAnimationFrame(() => cardRef.current?.focus());
  }, [focusSeq]);

  const running = localAgentIds.filter((id) => online.includes(id)).length;
  const total = localAgentIds.length;
  useEffect(() => {
    if (!back) { setBackDoneAt(null); return undefined; }
    if (backDoneAt === null && (total === 0 || running >= total)) setBackDoneAt(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [back, backDoneAt, running, total]);

  const backGone = back !== null && phase === 'ok'
    && ((backDoneAt !== null && now - backDoneAt >= LINK_BACK_HOLD_MS) || now - back.upAtMs >= BACK_MAX_MS);
  useEffect(() => { if (backGone) clearBack(); }, [backGone, clearBack]);

  const key = link ? linkDismissKey(link) : null;
  // 오래 끊김은 OS 알림 1회(같은 열쇠로는 다시 안 보낸다).
  useEffect(() => {
    if (phase !== 'long' || !link || !key || notified.current.has(key)) return;
    notified.current.add(key);
    writeSet(NOTIFIED_KEY, notified.current);
    void notifier.notify({
      title: total > 0 ? t('opLink.long.titleMany', { count: total, reason: t(REASON_KEY[link.reason ?? 'other']!) }) : t('opLink.long.title', { reason: t(REASON_KEY[link.reason ?? 'other']!) }),
      body: t(linkActionKey(link.reason)),
    });
  });

  if (back && phase === 'ok') {
    if (backGone) return null;
    const from = at(back.downSinceMs);
    const to = at(back.upAtMs);
    const line = from && to
      ? t('opLink.back.line', { dur: dur(back.upAtMs - back.downSinceMs), from, to })
      : t('opLink.back.lineNoTime', { dur: dur(back.upAtMs - back.downSinceMs) });
    return (
      <div key="op-link" role="status" aria-atomic="false" data-testid="op-link-back"
        className="pointer-events-auto rounded-card border border-border border-l-4 border-l-success bg-surface-raised px-3 py-2.5 shadow-float">
        <p className="text-body font-semibold text-fg"><span className="text-success">✓</span> {t('opLink.back.title')}</p>
        <p className="mt-0.5 line-clamp-2 break-words text-meta text-fg-muted" title={line}>
          {line}{total > 0 ? ` · ${t('opLink.back.runners', { n: Math.min(running, total), total })}` : ''}
        </p>
        {total > 0 && (
          <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-surface-hover">
            <span className="block h-full bg-success" style={{ width: `${Math.round((Math.min(running, total) / total) * 100)}%` }} />
          </div>
        )}
      </div>
    );
  }
  if (!link || phase === 'ok' || !key) return null;
  const reason = t(REASON_KEY[link.reason ?? 'other']!);
  const since = at(link.downSinceMs);
  const forDur = link.downSinceMs !== null ? dur(Date.now() - link.downSinceMs) : null;

  if (phase === 'retry') {
    const line = since ? t('opLink.retry.line', { reason, since }) : t('opLink.retry.lineNoSince', { reason });
    return (
      <div key="op-link" ref={cardRef} tabIndex={-1} role="status" data-testid="op-link-retry"
        className="pointer-events-auto rounded-card border border-border border-l-4 border-l-warning bg-surface-raised px-3 py-2.5 shadow-float outline-none">
        <p className="text-body font-semibold text-fg"><span className="text-warning">⚠</span> {t('opLink.retry.title')}</p>
        <p className="mt-0.5 line-clamp-2 break-words text-meta text-fg-muted" title={line}>{line}</p>
        <p className="text-meta text-fg-subtle">{t('opLink.retry.hint')}</p>
      </div>
    );
  }
  if (dismissed === key) return null;
  const title = total > 0 ? t('opLink.long.titleMany', { count: total, reason }) : t('opLink.long.title', { reason });
  const what = link.reason === 'dns' ? t('opLink.long.whatDns', { host: link.host }) : reason;
  const line = since && forDur
    ? t('opLink.long.line', { what, since, dur: forDur, attempts: link.attempts })
    : t('opLink.long.lineNoSince', { what, attempts: link.attempts });
  return (
    <div key="op-link" ref={cardRef} tabIndex={-1} data-testid="op-link-long"
      className="pointer-events-auto rounded-card border border-border border-l-4 border-l-danger bg-surface-raised px-3 py-2.5 shadow-float outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <p role="alert" className="text-body font-semibold text-fg"><span className="text-danger">⛔</span> {title}</p>
      <p className="mt-0.5 line-clamp-2 break-words text-meta text-fg-muted" title={line}>{line}</p>
      <p className="mt-1 text-meta text-fg"><span className="font-semibold">{t('opLink.do.label')}</span> {t(linkActionKey(link.reason))}</p>
      <div className="mt-2 flex items-center gap-1.5">
        <button type="button" data-testid="op-link-retry-now" disabled={retrying} aria-busy={retrying}
          className="rounded-row bg-accent px-2 py-1 text-meta font-medium text-fg-on-strong hover:bg-accent-hover disabled:cursor-default disabled:opacity-60"
          onClick={() => {
            pressed.current = { atMs: Date.now(), link };
            setRetrying(true);
            void retryOperatorLinkNow(community).then((retried) => { if (!retried) setRetrying(false); });
          }}>
          {retrying ? t('opLink.retrying') : t('opLink.retryNow')}
        </button>
        <button type="button" data-testid="op-link-details"
          className="rounded-row px-2 py-1 text-meta text-fg-muted hover:bg-surface-hover"
          onClick={() => onOpenSettings('this-operator')}>
          {t('opLink.details')}
        </button>
        <button type="button" data-testid="op-link-later"
          className="rounded-row px-2 py-1 text-meta text-fg-muted hover:bg-surface-hover"
          onClick={() => setDismissed(key)}>
          {t('gate.later')}
        </button>
      </div>
    </div>
  );
}
