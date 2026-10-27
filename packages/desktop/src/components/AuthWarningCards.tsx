/**
 * 로그인이 풀린 Claude 계정의 **전역 경고 카드**(2026-10-15, 시안 auth-warning-mock, 소유자 「추천대로」).
 *
 * 관문 카드(`GateCard`)와 **같은 자리·같은 틀**이다 — 본문 오른쪽 위(`top-14`)에 겹쳐 그리고 밀어내지 않는다.
 * 세로로 쌓는 순서는 **S2 → 관문 → S1**, 한 번에 **두 장까지**(나머지는 「외 n」). 판정은 `lib/authWarnings.ts`.
 *
 * - S1(계정 하나 풀림, 일은 돈다): 노랑 ⚠, `role="status"`.
 * - S2(풀 전부 풀림, 에이전트 멈춤): 빨강 ⛔, `role="alert"`, 상태 전이마다 OS 알림 1회.
 * - [다시 로그인]: 설정 › Claude 계정으로 가서 그 계정의 다시 로그인 확인창을 연다. [나중에]: 그 카드만 접는다 —
 *   상태가 나빠지면 열쇠가 바뀌어 다시 선다(`authWarningKey`). 접힌 열쇠는 이 기기에 남는다.
 *
 * 멈춘 에이전트는 **이 맥 오퍼레이터의 러너 종료**(`listenRunnerExit`, 사유 이름만)와 계정 목록의 풀 배정으로만
 * 안다. 이름은 **지금 커뮤니티의 계정 목록**에서 찾고, 없으면 그리지 않는다 — 커뮤니티를 섞지 않는다(security).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EX_CONFIG } from '@harkroom/shared';
import { communityLabel, useActiveStore, useCommunityRegistry, type CommunityEntry } from '../state/communities';
import { switchCommunity } from '../state/controller';
import { useLocale, useT } from '../i18n/useT';
import { authWarningKey, authWarnings, pruneStopped, type AuthWarning } from '../lib/authWarnings';
import {
  hasClaudeAccountsSurface,
  listClaudeAccounts,
  listenClaudeLogin,
  listenRunnerExit,
  requestClaudeReauth,
  type ClaudeAccountsSnapshot,
} from '../lib/claudeAccounts';
import { createNotifier } from '../lib/notify';
import { useAuthWarningsStore } from '../state/authWarningsStore';
import { GateCard } from './GateCard';
import type { SectionId } from './settings/sections';

/** 계정 목록을 다시 읽는 간격. 러너 종료·로그인 끝·창 포커스 때는 바로 읽는다. */
const POLL_MS = 120_000;
const DISMISSED_KEY = 'harkroom.authWarn.dismissed';
const NOTIFIED_KEY = 'harkroom.authWarn.notified';

function readSet(key: string): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeSet(key: string, set: Set<string>): void {
  // 오래된 열쇠가 끝없이 쌓이지 않게 최근 50개만 둔다.
  try { localStorage.setItem(key, JSON.stringify([...set].slice(-50))); } catch { /* 저장 못 해도 화면은 돈다 */ }
}

/** 계정 목록 + 로그인 사유로 물러난 러너. 표면이 없으면(웹·테스트) 아무것도 안 한다. */
export function useAuthWarnings(): AuthWarning[] {
  const [snap, setSnap] = useState<ClaudeAccountsSnapshot | null>(null);
  const [stopped, setStopped] = useState<ReadonlyMap<string, number>>(new Map());
  const available = hasClaudeAccountsSurface();
  const refresh = useCallback(async () => {
    if (!available) return;
    try { setSnap(await listClaudeAccounts()); } catch { /* 못 읽으면 앞 값을 둔다 — 카드를 지어내지 않는다 */ }
  }, [available]);
  useEffect(() => {
    if (!available) return undefined;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    const onFocus = (): void => { void refresh(); };
    window.addEventListener('focus', onFocus);
    const offs: Promise<() => void>[] = [
      listenRunnerExit((e) => {
        if (e.code === EX_CONFIG && e.reason === 'harness-login-required') {
          setStopped((cur) => new Map(cur).set(e.agentId, cur.get(e.agentId) ?? Date.now()));
        }
        void refresh();
      }),
      // 다시 로그인을 마쳤다 — 표식은 오퍼레이터가 지웠다. 목록을 다시 읽으면 `pruneStopped` 가 그 풀의
      // 멈춤 기억만 내린다(다른 풀 때문에 멈춘 에이전트는 그대로, designer n2).
      listenClaudeLogin(() => { void refresh(); }),
    ];
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      for (const off of offs) void off.then((f) => f());
    };
  }, [available, refresh]);
  // 목록이 회복을 보여 주면 멈춤 기억을 지운다 — 터미널에서 직접 다시 로그인한 경우도(security n2).
  useEffect(() => { setStopped((cur) => pruneStopped(snap, cur)); }, [snap]);
  const warnings = useMemo(() => authWarnings(snap, stopped), [snap, stopped]);
  // 사이드바도 같은 판정을 읽는다(③-3) — 조회·구독을 둘로 만들지 않는다.
  useEffect(() => { useAuthWarningsStore.setState({ warnings }); }, [warnings]);
  return warnings;
}

/** 관문 카드와 로그인 경고 카드를 한 자리에 쌓는다. `Workspace` 의 본문 칸에 둔다. */
export function AttentionStack({ onOpenSettings }: { onOpenSettings: (section?: SectionId, targetId?: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const warnings = useAuthWarnings();
  const accounts = useActiveStore((s) => s.accounts);
  const gateOpen = useActiveStore((s) => s.gates.some((g) => !g.dismissed));
  const [dismissed, setDismissed] = useState<Set<string>>(() => readSet(DISMISSED_KEY));
  const notified = useRef<Set<string>>(readSet(NOTIFIED_KEY));
  const notifier = useMemo(() => createNotifier(), []);
  // 보고 있지 않은 커뮤니티의 세션이 끝났다(designer 시안 ④ B-3). 보고 있는 것은 그 자리 패널이 말한다.
  const registryEntries = useCommunityRegistry((r) => r.entries);
  const activeId = useCommunityRegistry((r) => r.activeId);
  const current = registryEntries.find((e) => e.id === activeId);
  const signedOutOthers = registryEntries.filter((e) => e.id !== activeId && e.signedOut);
  // [나중에]는 이 앱이 떠 있는 동안만 기억한다 — 다시 로그인했다가 또 끝나면 다시 알려야 한다.
  const [laterSignedOut, setLaterSignedOut] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setLaterSignedOut((cur) => {
      const still = new Set([...cur].filter((id) => registryEntries.some((e) => e.id === id && e.signedOut)));
      return still.size === cur.size ? cur : still;
    });
  }, [registryEntries]);

  // 지금 커뮤니티에 없는 에이전트는 지운다 — 이름이 없는 id 를 그리지 않고, 다른 커뮤니티를 섞지 않는다.
  // 열쇠는 **거르기 전** 경고로 짓는다 — 커뮤니티를 바꿔 거른 수가 달라져도 같은 상태면 같은 열쇠다(security n1).
  const shown = warnings
    .map((orig) => ({
      key: authWarningKey(orig),
      w: orig.kind === 's2' ? { ...orig, agentIds: orig.agentIds.filter((id) => accounts[id]) } : orig,
    }))
    .filter(({ w }) => !(w.kind === 's2' && w.pool === null && w.agentIds.length === 0))
    .filter(({ key }) => !dismissed.has(key));

  const handles = (ids: string[]): string[] => ids.map((id) => `@${accounts[id]!.handle}`);
  /** 이름은 두 개까지, 나머지는 「외 n」(designer n4). */
  const shortNames = (names: string[]): string => names.length > 2
    ? `${names.slice(0, 2).join(' · ')} ${t('gate.more', { count: names.length - 2 })}`
    : names.join(' · ');
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  /** 깨진 시각(유한하지만 Date 범위 밖)이면 「?」 — `format` 이 RangeError 로 화면을 깨지 않게(security n2). */
  const sinceText = (atMs: number): string | null => {
    const d = new Date(atMs);
    return Number.isNaN(d.getTime()) ? null : time.format(d);
  };

  // S2 는 상태 전이마다 OS 알림 1회(같은 열쇠로는 다시 안 보낸다).
  useEffect(() => {
    for (const { key, w } of shown) {
      if (w.kind !== 's2') continue;
      if (notified.current.has(key)) continue;
      notified.current.add(key);
      writeSet(NOTIFIED_KEY, notified.current);
      const names = handles(w.agentIds);
      void notifier.notify({
        title: names.length ? t('authWarn.s2.notifyTitle', { who: names.join(', ') }) : t('authWarn.s2.notifyTitlePool'),
        body: t('authWarn.s2.notifyBody'),
      });
    }
  });

  const s2 = shown.filter(({ w }) => w.kind === 's2');
  const s1 = shown.filter(({ w }) => w.kind === 's1');
  type Slot = { kind: 'gate' } | { kind: 'auth'; key: string; w: AuthWarning } | { kind: 'signedOut'; entry: CommunityEntry };
  // 순서: S2(에이전트 멈춤) → 관문 → 다른 커뮤니티 로그아웃 → S1(designer 시안 ④ B-3). 두 장 규칙은 그대로다.
  const slots: Slot[] = [
    ...s2.map((x) => ({ kind: 'auth' as const, ...x })),
    ...(gateOpen ? [{ kind: 'gate' as const }] : []),
    ...signedOutOthers.filter((e) => !laterSignedOut.has(e.id)).map((entry) => ({ kind: 'signedOut' as const, entry })),
    ...s1.map((x) => ({ kind: 'auth' as const, ...x })),
  ];
  const visible = slots.slice(0, 2);
  const hidden = slots.length - visible.length;
  if (!visible.length) return null;

  const dismiss = (key: string): void => {
    const next = new Set(dismissed).add(key);
    setDismissed(next);
    writeSet(DISMISSED_KEY, next);
  };
  const reauth = (w: AuthWarning): void => {
    if (w.account && w.pool !== null) requestClaudeReauth(w.pool, w.account);
    onOpenSettings('claude-accounts');
  };

  return (
    <div className="pointer-events-none absolute right-3 top-14 z-40 flex w-80 max-w-[calc(100%-1.5rem)] flex-col gap-2">
      {visible.map((slot, i) => {
        const more = i === visible.length - 1 && hidden > 0 ? hidden : 0;
        // 마지막 칸이 관문 카드여도 숨은 수를 잃지 않는다(designer s2).
        if (slot.kind === 'gate') return <GateCard key="gate" extraMore={more} />;
        if (slot.kind === 'signedOut') {
          const name = communityLabel(slot.entry);
          return (
            <div
              key={`signed-out-${slot.entry.id}`}
              role="status"
              data-testid="signed-out-card"
              className="pointer-events-auto rounded-card border border-border border-l-4 border-l-warning bg-surface-raised px-3 py-2.5 shadow-float"
            >
              <p className="truncate text-body font-semibold text-fg">
                <span className="text-warning">⚠</span> {t('relogin.card.title', { name })}
              </p>
              <p className="mt-0.5 truncate text-meta text-fg-muted">
                {t('relogin.card.line', { current: current ? communityLabel(current) : '' })}
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="signed-out-card-relogin"
                  className="rounded-row bg-accent px-2 py-1 text-meta font-medium text-fg-on-strong hover:bg-accent-hover"
                  onClick={() => { void switchCommunity(slot.entry.id); }}
                >
                  {t('relogin.submit')}
                </button>
                <button
                  type="button"
                  data-testid="signed-out-card-later"
                  className="rounded-row px-2 py-1 text-meta text-fg-muted hover:bg-surface-hover"
                  onClick={() => setLaterSignedOut((cur) => new Set(cur).add(slot.entry.id))}
                >
                  {t('relogin.card.later')}
                </button>
                {more > 0 && <span className="ml-auto text-meta text-fg-subtle">{t('gate.more', { count: more })}</span>}
              </div>
            </div>
          );
        }
        const { w, key } = slot;
        const names = w.kind === 's2' ? handles(w.agentIds) : [];
        const title = w.kind === 's1'
          ? w.wholePool ? t('authWarn.s1.titlePool', { pool: w.pool || t('authWarn.defaultPool') }) : t('authWarn.s1.title', { account: w.account })
          : names.length === 1
            ? t('authWarn.s2.titleOne', { handle: names[0]! })
            : names.length > 1
              ? t('authWarn.s2.titleMany', { count: names.length })
              : t('authWarn.s2.titlePool', { pool: w.pool ?? '' });
        const line = w.kind === 's1'
          ? w.wholePool
            ? t('authWarn.s1.linePool')
            : t('authWarn.s1.line', { pool: w.pool || t('authWarn.defaultPool'), left: w.left, total: w.total })
          : w.pool !== null
            ? (() => {
              // 깨진 시각이면 「· …부터」 마디를 통째로 뺀다(designer q2) — 「?부터」로 읽히지 않게.
              const since = sinceText(w.atMs);
              const pool = w.pool || t('authWarn.defaultPool');
              return since === null
                ? t('authWarn.s2.lineNoSince', { pool, total: w.total })
                : t('authWarn.s2.line', { pool, total: w.total, since });
            })()
            : t('authWarn.s2.lineUnknown');
        return (
          <div
            key={key}
            role={w.kind === 's2' ? 'alert' : 'status'}
            data-testid={`auth-warn-${w.kind}`}
            className={`pointer-events-auto rounded-card border border-border border-l-4 bg-surface-raised px-3 py-2.5 shadow-float ${w.kind === 's2' ? 'border-l-danger' : 'border-l-warning'}`}
          >
            <p className="text-body font-semibold text-fg">
              <span className={w.kind === 's2' ? 'text-danger' : 'text-warning'}>{w.kind === 's2' ? '⛔' : '⚠'}</span> {title}
            </p>
            <p className="mt-0.5 truncate text-meta text-fg-muted" title={line}>{line}</p>
            {names.length > 1 && <p className="truncate text-meta text-fg-muted">{shortNames(names)}</p>}
            <p className="text-meta text-fg-subtle">{t('authWarn.hint')}</p>
            <div className="mt-2 flex items-center gap-1.5">
              {/* 풀을 모르면 열 계정이 없다 — 설정으로 데려가기만 한다(designer s3). */}
              <button
                type="button"
                data-testid={w.account ? 'auth-warn-reauth' : 'auth-warn-settings'}
                className="rounded-row bg-accent px-2 py-1 text-meta font-medium text-fg-on-strong hover:bg-accent-hover"
                onClick={() => reauth(w)}
              >
                {w.account ? t('authWarn.reauth') : t('authWarn.openSettings')}
              </button>
              <button
                type="button"
                data-testid="auth-warn-later"
                className="rounded-row px-2 py-1 text-meta text-fg-muted hover:bg-surface-hover"
                onClick={() => dismiss(key)}
              >
                {t('gate.later')}
              </button>
              {more > 0 && <span className="ml-auto text-meta text-fg-subtle">{t('gate.more', { count: more })}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
