/**
 * 머지 권한 줄마다 고르는 gh 계정(스레드 e085b6a7, designer 시안 v1 · 앞선 P2 스레드 febe9ff8).
 *
 * 값은 이 기기 오퍼레이터의 `operator.json` 의 `merge.byScope`(`owner/name`·`owner/*` → 로그인 이름)에 있다. 래퍼는 머지할
 * 저장소에 맞는 줄의 계정만 쓴다 — 정확한 저장소 줄이 조직 줄보다 이기고, 맞는 줄이 없으면 거절한다(`no_gh_user`). 기기 하나에
 * 기본값 하나를 두던 줄은 없앴다: 맞지 않는 계정이 말없이 쓰인 것이 이번 일의 원인이다.
 *
 * 고르는 것은 사람이다(security P1): 목록에서 미리 골라 두지 않는다. 예외 둘만 화면이 대신 적는다 —
 * ① 처음 열 때 옛 기기 값(`merge.ghUser`)을 한 번 복사한다(`migrate`, 오퍼레이터가 한 번만 한다). `byScope` 는 **기기 전체**
 *    값이므로 지금 연 에이전트 줄만이 아니라 이 기기에 배정된 내 에이전트 전부의 머지 줄로 옮긴다 — 첫 에이전트만 옮기고
 *    옛 값을 지우면 나머지 에이전트가 화면을 열 때까지 `no_gh_user` 로 막혔다(#1265 security n1).
 * ② 같은 owner 의 다른 줄이 계정을 갖고 있으면 계정 없는 줄이 그것을 이어받는다(같은 조직이면 같은 계정, 시안 §4). 이것도
 *    기기의 모든 에이전트 줄에 한다 — 이미 첫 에이전트로만 옮겨진 기기가 여기서 메워진다.
 * 고를 수 있는 이름이 맞는지는 오퍼레이터가 그 순간의 `gh auth status` 로 다시 잰다(C7). 어느 기기의 값인지 절 머리에 보인다(C8).
 */
import { useCallback, useEffect, useState } from 'react';
import type { OperatorMergeCheckResult, OperatorMergeState } from '@harkroom/shared/daemonProtocol';
import { checkLocalMerge, getLocalMerge, migrateLocalMerge, setLocalMergeScopeUser } from '../../lib/operatorLocal';
import { useLocale, useT } from '../../i18n/useT';

const rawReason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 오퍼레이터 거절·gh 실패를 사람 말로(#1140 designer n3). 흔한 둘만 키로 옮기고 나머지 원문은 200자로 자른다
 * (security: 지금 원문은 `gh auth status` stderr 라 토큰이 가려져 나온다 — 다른 gh 명령의 stderr 를 여기 싣게 되면
 * 그때 다시 본다).
 */
type T = ReturnType<typeof useT>;
export function mergeReasonText(t: T, raw: string): string {
  if (/is not logged in to gh on this machine/.test(raw)) return t('agents.grants.ghUser.errNotLoggedIn');
  // gh 실행 파일 자체를 못 찾은 경우만(`spawn <path> ENOENT`) — gh 가 다른 파일을 못 찾은 것까지 "gh 없음"으로 바꾸지 않는다(#1146 security n1).
  if (/spawn \S+ ENOENT/.test(raw)) return t('agents.grants.ghUser.errNoGh');
  return raw.slice(0, 200);
}

const ownerOf = (scope: string): string => scope.split('/')[0]!;

export type LocalMerge = OperatorMergeState | 'loading' | 'error' | null;

/**
 * 이 기기 오퍼레이터의 머지 계정 상태. `scopes` 는 이 에이전트의 머지 권한 줄(`owner/name`·`owner/*`, 소문자)이고, null 이면
 * 묻지 않는다(다른 기기·소유자 아님·권한 없음). `deviceScopes` 는 같은 기기에 배정된 내 다른 에이전트들의 머지 줄이다 —
 * 옮기기(①)·이어받기(②)는 둘을 합친 줄에 하고, 닿음 확인은 이 에이전트 줄만 한다.
 */
export type MergeReach = OperatorMergeCheckResult['reach'];

export function useLocalMerge(scopes: string[] | null, deviceScopes: readonly string[] = []): {
  state: LocalMerge;
  /** 범위 × 계정 → 닿음(시안 A·B·E). 재는 동안·실패면 비어 있다 — 그때 칸은 상태 없이 보인다(막지 않는다). */
  reach: MergeReach;
  setScope(scope: string, ghUser: string): Promise<void>;
} {
  const [state, setState] = useState<LocalMerge>(scopes ? 'loading' : null);
  const [reach, setReach] = useState<MergeReach>({});
  const key = scopes ? scopes.join('\n') : null;
  const deviceKey = deviceScopes.join('\n');

  useEffect(() => {
    if (key === null) { setState(null); return; }
    const list = key ? key.split('\n') : [];
    const all = [...new Set([...list, ...(deviceKey ? deviceKey.split('\n') : [])])];
    let alive = true;
    // 줄 목록은 늦게 온다(grant 를 읽은 뒤) — 그때 자리를 먼저 잡는다(#1140 designer n5).
    setState((prev) => (prev === null || prev === 'error' ? 'loading' : prev));
    void (async () => {
      try {
        let s = await getLocalMerge();
        if (s.byScope === null && all.length) s = await migrateLocalMerge(all);
        for (const scope of all) {
          const byScope = s.byScope ?? {};
          if (byScope[scope]) continue;
          const sibling = Object.entries(byScope).find(([k]) => ownerOf(k) === ownerOf(scope))?.[1];
          // 이어받는 것도 오퍼레이터가 그 순간의 gh 목록으로 다시 잰다 — 로그아웃된 계정이면 건너뛰고 「계정 고르기」로 둔다.
          if (sibling && s.accounts?.some((a) => a.login === sibling)) {
            try { s = await setLocalMergeScopeUser(scope, sibling); } catch { /* 고르기 상태로 둔다 */ }
          }
        }
        if (alive) setState(s);
        // 닿음은 그 뒤에 — 느린 GitHub 이 계정 칸을 붙잡지 않게(오퍼레이터가 10분 캐시한다).
        if (list.length && s.accounts?.length) {
          try { const r = await checkLocalMerge(list); if (alive) setReach(r.reach); } catch { /* 확인 없이 둔다 */ }
        }
      } catch { if (alive) setState('error'); }
    })();
    return () => { alive = false; };
  }, [key, deviceKey]);

  const setScope = useCallback(async (scope: string, ghUser: string) => {
    setState(await setLocalMergeScopeUser(scope, ghUser));
  }, []);

  return { state, reach, setScope };
}

/** 절 머리 한 줄 — 어느 기기의 gh 계정으로 머지하는지(C8). 읽는 동안·실패도 같은 자리다(#1140 designer n5). */
export function MergeDeviceNote({ state }: { state: LocalMerge }) {
  const t = useT();
  if (state === null) return null;
  if (state === 'loading') return <p className="mt-2 text-meta text-fg-subtle" data-testid="merge-gh-user-loading">{t('agents.grants.ghUser.loading')}</p>;
  if (state === 'error') return <p role="alert" className="mt-2 text-meta text-danger" data-testid="merge-gh-user-error">{t('agents.grants.ghUser.loadFailed')}</p>;
  return (
    <div className="mt-2 text-meta text-fg-subtle" data-testid="merge-gh-user">
      <span>{t('agents.grants.ghUser.deviceNote', { host: state.host })}</span>
      {state.accounts === null && (
        <p role="alert" className="mt-1 text-danger">{t('agents.grants.ghUser.ghFailed', { reason: mergeReasonText(t, state.accountsError ?? '') })}</p>
      )}
      {state.accounts !== null && state.accounts.length === 0 && <p className="mt-1">{t('agents.grants.ghUser.noAccounts')}</p>}
    </div>
  );
}

/**
 * 권한 줄 안의 「계정 [▾]」 칸과 그 줄의 상태 줄(시안 §1·§3). 고르면 바로 저장한다(저장 버튼 없음) — 실패하면 앞 값을 두고
 * 이유를 줄 아래에. 상태: 닿음(A) · 닿지 않음(B) · 계정 없음(C) · 로그아웃됨(D) · 확인 못 함(E, 경고색 없음).
 * 목록에서는 닿는 계정을 위로 올리고 ✓/✕ 를 붙이되 **미리 골라 두지 않는다**(시안 결정 1, fail-closed).
 */
export function MergeAccountCell({ scope, repoLabel, state, reach, setScope, disabled }: {
  scope: string;
  repoLabel: string;
  state: OperatorMergeState;
  /** 이 범위의 계정별 닿음(`useLocalMerge().reach[scope]`). 없으면 상태 없이. */
  reach?: Record<string, { status: 'ok' | 'no' | 'unknown'; checkedAt: string }>;
  setScope(scope: string, ghUser: string): Promise<void>;
  disabled?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = state.byScope?.[scope] ?? null;
  const rank = (login: string): number => ({ ok: 0, unknown: 1, no: 2 } as const)[reach?.[login]?.status ?? 'unknown'];
  const accounts = [...(state.accounts ?? [])].sort((a, b) => rank(a.login) - rank(b.login));
  const mark = (login: string): string => (reach?.[login]?.status === 'ok' ? ' ✓' : reach?.[login]?.status === 'no' ? ' ✕' : '');
  const loggedOut = current !== null && state.accounts !== null && !accounts.some((a) => a.login === current);
  const mine = current !== null && !loggedOut ? reach?.[current] : undefined;
  const id = scope.replace(/[^a-z0-9._-]/gi, '_');

  const pick = async (login: string) => {
    if (!login || login === current) return;
    setBusy(true); setError(null);
    try { await setScope(scope, login); } catch (e) {
      setError(t('agents.grants.ghUser.saveFailed', { reason: mergeReasonText(t, rawReason(e)) }));
    } finally { setBusy(false); }
  };

  return (
    <>
      <span className="text-fg-muted">{t('agents.grants.ghUser.as')}</span>
      <select
        aria-label={t('agents.grants.ghUser.rowAria', { repo: repoLabel })}
        data-testid={`merge-account-${id}`}
        className={`rounded-row border px-1.5 py-0.5 font-mono text-meta ${current === null
          ? 'border-dashed border-warning-border bg-transparent text-warning'
          : `border-border bg-surface-sunken text-fg${loggedOut ? ' line-through' : ''}`}`}
        disabled={busy || disabled || state.accounts === null}
        value={current ?? ''}
        onChange={(e) => void pick(e.target.value)}
      >
        {current === null && <option value="" disabled>{t('agents.grants.ghUser.pick')}</option>}
        {loggedOut && <option value={current!} disabled>{current}</option>}
        {accounts.map((a) => (
          <option key={a.login} value={a.login}>{(a.active ? t('agents.grants.ghUser.activeTag', { login: a.login }) : a.login) + mark(a.login)}</option>
        ))}
      </select>
      {mine?.status === 'ok' && <span className="text-success" data-testid={`merge-account-reach-${id}`} data-reach="ok">✓ {t('agents.grants.ghUser.reachOk')}</span>}
      {mine?.status === 'no' && <span className="font-medium text-danger" data-testid={`merge-account-reach-${id}`} data-reach="no">✕ {t('agents.grants.ghUser.reachNo')}</span>}
      {mine?.status === 'unknown' && (
        <span className="text-fg-subtle" title={t('agents.grants.ghUser.reachUnknownHint')} data-testid={`merge-account-reach-${id}`} data-reach="unknown">{t('agents.grants.ghUser.reachUnknown')}</span>
      )}
      {mine?.status === 'no' && (
        <p role="alert" className="order-last basis-full rounded-row border border-danger-border bg-danger-surface px-2 py-0.5 text-danger" data-testid={`merge-account-no-reach-${id}`}>
          {t('agents.grants.ghUser.rowNoReach', { login: current!, repo: repoLabel, when: new Date(mine.checkedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })}
        </p>
      )}
      {current === null && (
        <p role="status" className="order-last basis-full rounded-row border border-warning-border bg-warning-surface px-2 py-0.5 text-warning" data-testid={`merge-account-unset-${id}`}>
          {t('agents.grants.ghUser.rowUnset')}
        </p>
      )}
      {loggedOut && (
        <p role="alert" className="order-last basis-full rounded-row border border-danger-border bg-danger-surface px-2 py-0.5 text-danger" data-testid={`merge-account-logged-out-${id}`}>
          {t('agents.grants.ghUser.rowLoggedOut', { login: current! })}
        </p>
      )}
      {error && <p role="alert" className="order-last basis-full text-danger" data-testid={`merge-account-error-${id}`}>{error}</p>}
    </>
  );
}
