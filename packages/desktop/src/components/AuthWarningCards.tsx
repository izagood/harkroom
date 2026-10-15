/**
 * 로그인이 풀린 Claude 계정의 **전역 경고 카드**(2026-10-15, 시안 auth-warning-mock, jaebin 「추천대로」).
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
import { useActiveStore } from '../state/communities';
import { useT } from '../i18n/useT';
import { authWarningKey, authWarnings, type AuthWarning } from '../lib/authWarnings';
import {
  hasClaudeAccountsSurface,
  listClaudeAccounts,
  listenClaudeLogin,
  listenRunnerExit,
  requestClaudeReauth,
  type ClaudeAccountsSnapshot,
} from '../lib/claudeAccounts';
import { createNotifier } from '../lib/notify';
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
      // 다시 로그인을 마쳤다 — 표식은 오퍼레이터가 지웠다. 멈춤 기억도 내린다(살아난 계정 하나면 돈다).
      listenClaudeLogin((e) => {
        if ((e as { done?: unknown }).done === true) setStopped(new Map());
        void refresh();
      }),
    ];
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      for (const off of offs) void off.then((f) => f());
    };
  }, [available, refresh]);
  return useMemo(() => authWarnings(snap, stopped), [snap, stopped]);
}

/** 관문 카드와 로그인 경고 카드를 한 자리에 쌓는다. `Workspace` 의 본문 칸에 둔다. */
export function AttentionStack({ onOpenSettings }: { onOpenSettings: (section?: SectionId, targetId?: string) => void }) {
  const t = useT();
  const warnings = useAuthWarnings();
  const accounts = useActiveStore((s) => s.accounts);
  const gateOpen = useActiveStore((s) => s.gates.some((g) => !g.dismissed));
  const [dismissed, setDismissed] = useState<Set<string>>(() => readSet(DISMISSED_KEY));
  const notified = useRef<Set<string>>(readSet(NOTIFIED_KEY));
  const notifier = useMemo(() => createNotifier(), []);

  // 지금 커뮤니티에 없는 에이전트는 지운다 — 이름이 없는 id 를 그리지 않고, 다른 커뮤니티를 섞지 않는다.
  const shown = warnings
    .map((w) => (w.kind === 's2' ? { ...w, agentIds: w.agentIds.filter((id) => accounts[id]) } : w))
    .filter((w) => !(w.kind === 's2' && w.pool === null && w.agentIds.length === 0))
    .filter((w) => !dismissed.has(authWarningKey(w)));

  const handles = (ids: string[]): string[] => ids.map((id) => `@${accounts[id]!.handle}`);

  // S2 는 상태 전이마다 OS 알림 1회(같은 열쇠로는 다시 안 보낸다).
  useEffect(() => {
    for (const w of shown) {
      if (w.kind !== 's2') continue;
      const key = authWarningKey(w);
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

  const s2 = shown.filter((w) => w.kind === 's2');
  const s1 = shown.filter((w) => w.kind === 's1');
  type Slot = { kind: 'gate' } | AuthWarning;
  const slots: Slot[] = [...s2, ...(gateOpen ? [{ kind: 'gate' as const }] : []), ...s1];
  const visible = slots.slice(0, 2);
  const hidden = slots.length - visible.length;
  if (!visible.length) return null;

  const dismiss = (w: AuthWarning): void => {
    const next = new Set(dismissed).add(authWarningKey(w));
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
        if (slot.kind === 'gate') return <GateCard key="gate" />;
        const w = slot;
        const names = w.kind === 's2' ? handles(w.agentIds) : [];
        const title = w.kind === 's1'
          ? t('authWarn.s1.title', { account: w.account })
          : names.length === 1
            ? t('authWarn.s2.titleOne', { handle: names[0]! })
            : names.length > 1
              ? t('authWarn.s2.titleMany', { count: names.length })
              : t('authWarn.s2.titlePool', { pool: w.pool ?? '' });
        const line = w.kind === 's1'
          ? t('authWarn.s1.line', { pool: w.pool || t('authWarn.defaultPool'), left: w.left, total: w.total })
          : w.pool !== null
            ? t('authWarn.s2.line', { pool: w.pool || t('authWarn.defaultPool'), total: w.total, since: new Date(w.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
            : t('authWarn.s2.lineUnknown');
        return (
          <div
            key={authWarningKey(w)}
            role={w.kind === 's2' ? 'alert' : 'status'}
            data-testid={`auth-warn-${w.kind}`}
            className={`pointer-events-auto rounded-card border border-border border-l-4 bg-surface-raised px-3 py-2.5 shadow-float ${w.kind === 's2' ? 'border-l-danger' : 'border-l-warning'}`}
          >
            <p className="text-body font-semibold text-fg">
              <span className={w.kind === 's2' ? 'text-danger' : 'text-warning'}>{w.kind === 's2' ? '⛔' : '⚠'}</span> {title}
            </p>
            <p className="mt-0.5 truncate text-meta text-fg-muted" title={line}>{line}</p>
            {names.length > 1 && <p className="truncate text-meta text-fg-muted">{names.join(' · ')}</p>}
            <p className="text-meta text-fg-subtle">{t('authWarn.hint')}</p>
            <div className="mt-2 flex items-center gap-1.5">
              {w.account && (
                <button
                  type="button"
                  data-testid="auth-warn-reauth"
                  className="rounded-row bg-accent px-2 py-1 text-meta font-medium text-fg-on-strong hover:bg-accent-hover"
                  onClick={() => reauth(w)}
                >
                  {t('authWarn.reauth')}
                </button>
              )}
              <button
                type="button"
                data-testid="auth-warn-later"
                className="rounded-row px-2 py-1 text-meta text-fg-muted hover:bg-surface-hover"
                onClick={() => dismiss(w)}
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
