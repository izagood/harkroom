/**
 * 제공업체 계정 화면의 **Codex 카드**(2026-09-28).
 *
 * 모양: 맨 위에 **시스템 기본값** 줄이 항상 선다(관리 계정이 없어도 러너는 그것으로 돈다),
 * 그 아래 관리 계정들. 줄마다 `이 기기`·`활성` 배지, 둘째 줄에 플랜·로그인 시각, 오른쪽에
 * `사용`·`재인증`·`제거`. 관리 계정이 없으면 점선 칸에 "시스템 기본을 쓴다"를 말한다 —
 * 빈 목록을 그대로 두면 사람은 codex 가 로그인 없이 도는 줄 안다.
 *
 * claude 카드와 다른 점: **풀이 없다.** codex 는 한 번에 한 계정(활성)으로 돌고, 러너가 턴마다
 * 활성 표식을 다시 읽는다(`agent/src/codexHome.ts::syncCodexAuth`) — 그래서 "러너를 다시
 * 시작하라"는 안내가 없다. 로그인은 브라우저가 localhost 로 돌아오므로 코드 입력란도 없다.
 */
import { useCallback, useEffect, useState } from 'react';

import { CODEX_ACCOUNT_NAME_PATTERN } from '@harkroom/shared/codexAccounts';

import { useLocale, useT } from '../../i18n/useT';
import {
  activateCodexAccount,
  cancelCodexLogin,
  hasCodexAccountsSurface,
  listCodexAccounts,
  listenCodexLogin,
  removeCodexAccount,
  startCodexLogin,
  type CodexAccountsSnapshot,
  type CodexAuthStatus,
} from '../../lib/codexAccounts';
import { getExternalOpener } from '../../lib/openExternal';
import { Button, TextInput } from './primitives';
import { ProviderSection } from './ProviderSection';
import { ProviderUsageBars } from './ProviderUsageBars';
import { usageFor, useProviderUsage, useProviderUsageEnabled } from '../../lib/providerUsage';

interface LoginState {
  account: string;
  loginId: string;
  url: string | null;
}

function Badge({ children, tone = 'muted' }: { children: string; tone?: 'muted' | 'strong' }) {
  return (
    <span
      className={`rounded-md border px-1.5 py-px text-caption ${
        tone === 'strong' ? 'border-border-strong text-fg' : 'border-border text-fg-muted'
      }`}
    >
      {children}
    </span>
  );
}

export function CodexAccountsSettings() {
  const t = useT();
  const locale = useLocale();
  const available = hasCodexAccountsSurface();
  const [snap, setSnap] = useState<CodexAccountsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [login, setLogin] = useState<LoginState | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [providerUsageOn] = useProviderUsageEnabled();
  const { snap: providerSnap } = useProviderUsage('codex', providerUsageOn && available);
  const bars = (account: string) => {
    const u = providerSnap ? usageFor(providerSnap, account) : null;
    return u ? <div className="mt-2"><ProviderUsageBars usage={u} nowMs={providerSnap!.measuredAtMs} /></div> : null;
  };

  const refresh = useCallback(async () => {
    try {
      setSnap(await listCodexAccounts());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!available) return;
    void refresh();
    let off: (() => void) | undefined;
    let dead = false;
    void listenCodexLogin((e) => {
      setLogin((cur) => {
        if (!cur || cur.loginId !== e.loginId) return cur;
        if (e.url) return { ...cur, url: e.url };
        if (e.done) {
          if (e.error) setError(e.error);
          void refresh();
          return null;
        }
        return cur;
      });
    }).then((fn) => { if (dead) fn(); else off = fn; });
    return () => { dead = true; off?.(); };
  }, [available, refresh]);

  const when = (ms: number | undefined): string | null =>
    ms === undefined
      ? null
      : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        .format(new Date(ms));

  const detail = (s: CodexAuthStatus): string =>
    [s.authMode === 'apikey' ? t('providerAccounts.apiKey') : s.plan, when(s.signedInAtMs)]
      .filter(Boolean).join(' · ');

  const begin = async (account: string): Promise<void> => {
    try {
      const { loginId } = await startCodexLogin(account);
      setLogin({ account, loginId, url: null });
      setAdding(false);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const act = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const nameOk = CODEX_ACCOUNT_NAME_PATTERN.test(name) && !snap?.accounts.some((a) => a.name === name);

  return (
    <ProviderSection
      icon="codex"
      title="Codex"
      description={t('providerAccounts.codex.description')}
      testId="provider-codex"
    >
      {!available ? (
        <p className="text-fg-subtle">{t('providerAccounts.unavailable')}</p>
      ) : (
        <>
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <div className="font-medium text-fg">{t('providerAccounts.accounts.title')}</div>
              <div className="text-fg-subtle">{t('providerAccounts.accounts.hint')}</div>
            </div>
            <Button onClick={() => setAdding((v) => !v)} disabled={login !== null}>
              + {t('providerAccounts.addAccount')}
            </Button>
          </div>

          {error && <div className="mb-3 rounded-lg border border-danger-border px-4 py-2 text-danger">{error}</div>}

          {adding && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-border px-4 py-3" data-testid="codex-add-form">
              <div className="min-w-0 flex-1">
                <TextInput
                  value={name}
                  onChange={setName}
                  placeholder="work"
                  ariaLabel={t('providerAccounts.nameLabel')}
                />
                <div className="mt-1 text-caption text-fg-subtle">{t('providerAccounts.nameHint')}</div>
              </div>
              <Button variant="primary" disabled={!nameOk} onClick={() => void begin(name)}>
                {t('providerAccounts.signIn')}
              </Button>
            </div>
          )}

          {login && (
            <div className="mb-3 flex items-center gap-3 rounded-lg border border-border px-4 py-3" data-testid="codex-login">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-fg">{login.account}</div>
                <div className="text-fg-subtle">{t('providerAccounts.codex.loginWaiting')}</div>
              </div>
              {login.url && (
                <Button onClick={() => void getExternalOpener().open(login.url!)}>
                  {t('providerAccounts.codex.openLogin')}
                </Button>
              )}
              <Button onClick={() => { void cancelCodexLogin(login.loginId); }}>
                {t('providerAccounts.cancel')}
              </Button>
            </div>
          )}

          <div className="space-y-2">
            {/* 시스템 기본값 — 언제나 맨 위. 활성 계정이 없으면 이것이 활성이다. */}
            <div
              className={`flex items-center gap-4 rounded-lg border px-4 py-3 ${
                snap?.active === null ? 'border-border-strong bg-surface-hover' : 'border-border'
              }`}
              data-testid="codex-account-system"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-fg">{t('providerAccounts.systemDefault')}</span>
                  {snap?.active === null && <Badge tone="strong">{t('providerAccounts.badge.active')}</Badge>}
                </div>
                <div className="truncate text-fg-subtle">
                  {snap?.system.loggedIn
                    ? (snap.system.email ?? detail(snap.system))
                    : t('providerAccounts.codex.systemSignedOut')}
                </div>
                {snap?.system.loggedIn && bars('')}
              </div>
              {snap && snap.active !== null && (
                <Button onClick={() => void act(() => activateCodexAccount(null))}>{t('providerAccounts.use')}</Button>
              )}
            </div>

            {snap && snap.accounts.length === 0 && (
              <div className="rounded-lg border border-dashed border-border px-4 py-3 text-fg-subtle" data-testid="codex-accounts-empty">
                {t('providerAccounts.codex.empty')}
              </div>
            )}

            {snap?.accounts.map((a) => {
              const active = snap.active === a.name;
              return (
                <div
                  key={a.name}
                  className={`flex items-center gap-4 rounded-lg border px-4 py-3 ${
                    active ? 'border-border-strong bg-surface-hover' : 'border-border'
                  }`}
                  data-testid={`codex-account-${a.name}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-fg">{a.status.email ?? a.name}</span>
                      <Badge>{t('providerAccounts.badge.thisDevice')}</Badge>
                      {active && <Badge tone="strong">{t('providerAccounts.badge.active')}</Badge>}
                    </div>
                    <div className="truncate text-fg-subtle">
                      {[a.status.email ? a.name : null, a.status.loggedIn ? detail(a.status) : t('providerAccounts.notSignedIn')]
                        .filter(Boolean).join(' · ')}
                    </div>
                    {a.status.loggedIn && bars(a.name)}
                  </div>
                  {pendingRemove === a.name ? (
                    <div className="flex items-center gap-2">
                      <span className="text-fg-muted">{t('providerAccounts.confirmRemove', { name: a.name })}</span>
                      <Button variant="danger" onClick={() => { setPendingRemove(null); void act(() => removeCodexAccount(a.name)); }}>
                        {t('providerAccounts.remove')}
                      </Button>
                      <Button onClick={() => setPendingRemove(null)}>{t('providerAccounts.cancel')}</Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      {!active && a.status.loggedIn && (
                        <Button onClick={() => void act(() => activateCodexAccount(a.name))}>{t('providerAccounts.use')}</Button>
                      )}
                      <Button disabled={login !== null} onClick={() => void begin(a.name)}>↻ {t('providerAccounts.reauth')}</Button>
                      <Button variant="danger" onClick={() => setPendingRemove(a.name)}>{t('providerAccounts.remove')}</Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-caption text-fg-subtle">{t('providerAccounts.codex.switchNote')}</p>
        </>
      )}
    </ProviderSection>
  );
}
