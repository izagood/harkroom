/**
 * 「머지에 쓸 GitHub 계정」 줄 — PR 머지 절 머리(스레드 febe9ff8 P2).
 *
 * 값은 이 기기 오퍼레이터의 `operator.json` 의 `merge.ghUser` 에 있다. 비어 있으면 래퍼는 머지를 전부 거절한다
 * (`no_gh_user`) — 권한을 줘도 머지가 안 되는 까닭을 여기서 미리 보인다. 고르는 것은 사람이다: 처음 값은 비어 있고
 * 목록에서 미리 골라 두지 않는다(활성 계정이 회사 계정이라 fail-closed 로 둔 칸, security P1). 고를 수 있는 이름이
 * 맞는지는 오퍼레이터가 그 순간의 `gh auth status` 로 다시 잰다(C7) — 이 화면은 목록을 보여 주고 고른 이름을 넘길
 * 뿐이다. 어느 기기의 값인지(호스트 이름)를 함께 보인다(C8).
 */
import { useCallback, useEffect, useState } from 'react';
import type { OperatorMergeState } from '@harkroom/shared/daemonProtocol';
import { getLocalMerge, setLocalMergeGhUser } from '../../lib/operatorLocal';
import { useT } from '../../i18n/useT';

const rawReason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 오퍼레이터 거절·gh 실패를 사람 말로(#1140 designer n3). 흔한 둘만 키로 옮기고 나머지 원문은 200자로 자른다
 * (security: 지금 원문은 `gh auth status` stderr 라 토큰이 가려져 나온다 — 다른 gh 명령의 stderr 를 여기 싣게 되면
 * 그때 다시 본다).
 */
type T = ReturnType<typeof useT>;
export function mergeReasonText(t: T, raw: string): string {
  if (/is not logged in to gh on this machine/.test(raw)) return t('agents.grants.ghUser.errNotLoggedIn');
  if (/ENOENT|no such file/i.test(raw)) return t('agents.grants.ghUser.errNoGh');
  return raw.slice(0, 200);
}

export function MergeGhUserRow({ disabled, hasGrants }: {
  disabled?: boolean;
  /**
   * 이 에이전트에 머지 권한이 하나라도 있나(#1140 designer n2). 없으면 비어 있어도 경고 상자 대신 조용한 한 줄이다 —
   * 이 기기의 내 에이전트를 열 때마다 노란 상자를 보면 신호가 닳는다. 막는 힘은 그대로다: 래퍼가 `no_gh_user` 로 막는다.
   */
  hasGrants: boolean;
}) {
  const t = useT();
  const [state, setState] = useState<OperatorMergeState | 'loading' | 'error'>('loading');
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setState(await getLocalMerge()); } catch { setState('error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (ghUser: string | null) => {
    setBusy(true); setError(null);
    try {
      setState(await setLocalMergeGhUser(ghUser));
      setEditing(false); setChoice('');
    } catch (e) {
      setError(t('agents.grants.ghUser.saveFailed', { reason: mergeReasonText(t, rawReason(e)) }));
    } finally { setBusy(false); }
  };

  // 자리를 먼저 잡아 둔다(#1140 designer n5) — 줄이 늦게 끼어들며 아래 목록을 밀지 않게.
  if (state === 'loading') return <p className="mt-2 text-meta text-fg-subtle" data-testid="merge-gh-user-loading">{t('agents.grants.ghUser.loading')}</p>;
  if (state === 'error') {
    return <p role="alert" className="mt-2 text-meta text-danger" data-testid="merge-gh-user-error">{t('agents.grants.ghUser.loadFailed')}</p>;
  }

  const off = busy || disabled;
  const { ghUser, accounts, host } = state;
  const missing = ghUser !== null && accounts !== null && !accounts.some((a) => a.login === ghUser);
  const openEditor = () => { setEditing(true); setChoice(''); setError(null); };
  const chosenActive = accounts?.find((a) => a.login === choice)?.active === true;

  return (
    <div className="mt-2" data-testid="merge-gh-user">
      {ghUser === null && !hasGrants ? (
        <div className="flex flex-wrap items-center gap-2 text-meta text-fg-subtle" data-testid="merge-gh-user-unset-quiet">
          <span>{t('agents.grants.ghUser.unsetQuiet')}</span>
          {!editing && (
            <button className="ml-auto rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50" disabled={off} onClick={openEditor}>
              {t('agents.grants.ghUser.choose')}
            </button>
          )}
        </div>
      ) : ghUser === null ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-row border border-warning-border bg-warning-surface px-2 py-1 text-meta text-warning" data-testid="merge-gh-user-unset">
          <span>{t('agents.grants.ghUser.unset', { host })}</span>
          {!editing && (
            <button className="ml-auto rounded-row border border-border bg-surface px-2 py-0.5 text-meta font-medium text-fg disabled:opacity-50" disabled={off} onClick={openEditor}>
              {t('agents.grants.ghUser.choose')}
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-fg">
          <span className="text-fg-muted">{t('agents.grants.ghUser.label')}</span>
          <span className="font-mono font-medium" data-testid="merge-gh-user-value">{ghUser}</span>
          <span className="text-fg-subtle">· {t('agents.grants.ghUser.device', { host })}</span>
          {!editing && (
            <button className="ml-auto rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50" disabled={off} onClick={openEditor}>
              {t('agents.grants.ghUser.change')}
            </button>
          )}
        </div>
      )}
      {missing && <p role="alert" className="mt-1 text-meta text-danger">{t('agents.grants.ghUser.notLoggedIn', { login: ghUser })}</p>}

      {editing && (
        <div className="mt-2 rounded-row border border-border bg-surface-sunken p-2" data-testid="merge-gh-user-editor">
          {accounts === null ? (
            <p role="alert" className="text-meta text-danger">{t('agents.grants.ghUser.ghFailed', { reason: mergeReasonText(t, state.accountsError ?? '') })}</p>
          ) : accounts.length === 0 ? (
            <p className="text-meta text-fg-subtle">{t('agents.grants.ghUser.noAccounts')}</p>
          ) : (
            <label className="flex items-center gap-2 text-meta text-fg">
              {t('agents.grants.ghUser.select')}
              <select
                aria-label={t('agents.grants.ghUser.select')}
                className="rounded-row border border-border bg-surface px-2 py-1 font-mono text-meta text-fg"
                disabled={off}
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="" disabled>{t('agents.grants.ghUser.placeholder')}</option>
                {accounts.map((a) => (
                  <option key={a.login} value={a.login}>{a.active ? t('agents.grants.ghUser.activeTag', { login: a.login }) : a.login}</option>
                ))}
              </select>
            </label>
          )}
          {/* 회사(활성) 계정을 고를 때 한 번 더 묻는다(security n2) — 자동으로 고르지 않은 이유(P1)를 화면에도 남긴다. */}
          {chosenActive && <p role="status" className="mt-1 text-meta text-warning" data-testid="merge-gh-user-active-warn">{t('agents.grants.ghUser.activeWarn', { login: choice })}</p>}
          <p className="mt-1 text-meta text-fg-subtle">{t('agents.grants.ghUser.hint')}</p>
          {/* 이 값은 에이전트가 아니라 기기의 것이다(security n2) — 바꾸면 이 기기의 다른 에이전트도 같이 바뀐다. */}
          <p className="mt-1 text-meta text-fg-subtle" data-testid="merge-gh-user-device-wide">{t('agents.grants.ghUser.deviceWide')}</p>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded-row border border-border bg-accent px-2 py-1 text-meta font-medium text-accent-fg disabled:opacity-50"
              disabled={off || !choice || choice === ghUser}
              onClick={() => void save(choice)}
            >
              {t('agents.grants.ghUser.save')}
            </button>
            {ghUser !== null && (
              <button className="rounded-row border border-border px-2 py-1 text-meta text-fg hover:text-danger disabled:opacity-50" disabled={off} onClick={() => void save(null)}>
                {t('agents.grants.ghUser.clear')}
              </button>
            )}
            <button className="rounded-row border border-border px-2 py-1 text-meta text-fg hover:bg-surface disabled:opacity-50" disabled={off} onClick={() => { setEditing(false); setError(null); }}>
              {t('agents.grants.cancel')}
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-meta text-danger" data-testid="merge-gh-user-save-error">{error}</p>}
    </div>
  );
}
