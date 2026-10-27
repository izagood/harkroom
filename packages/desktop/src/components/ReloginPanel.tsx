import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useStore } from 'zustand';
import { ApiClient, ApiError } from '../lib/api';
import { communityLabel, useCommunityRegistry, type CommunityEntry } from '../state/communities';
import { switchCommunity } from '../state/controller';
import { useT } from '../i18n/useT';
import { initialOf } from './CommunitySwitcher';
import { ForgotPasswordGuide, ResetWithCodeForm } from './PasswordReset';

/**
 * 다시 로그인에 성공했다 — 보관본에 적고 세션을 다시 세우는 일은 App 몫이다. `entryId` 는 **패널이 서 있던 칸**이다:
 * 기다리는 사이 사람이 다른 커뮤니티로 옮겨도 App 은 그 칸에만 세운다(security F1).
 */
export type ReloginDone = (input: {
  entryId: string; baseUrl: string; token: string; accountId: string; handle: string; loginId: string;
}) => Promise<void>;

/**
 * 세션이 끝난 커뮤니티를 보고 있을 때 사이드바+본문 자리에 서는 「다시 로그인」 패널(designer 시안 ④ B-2).
 *
 * 왜 전체 로그인 화면이 아닌가(2026-10-27): 한 커뮤니티가 만료되자 앱 전체가 첫 실행 로그인 화면으로 바뀌어
 * 레일이 사라졌고, 살아 있던 다른 커뮤니티로 갈 길이 없어 "둘 다 못 들어간다"로 읽혔다. 레일을 남기고 그 자리에서
 * 비밀번호 한 칸만 받는다. 서버·로그인 ID 는 그 커뮤니티의 것으로 고정한다 — 바꾸고 싶으면 커뮤니티 추가로 간다.
 *
 * 오류색은 로그인이 **실패했을 때만** 쓴다. 만료는 사람의 실수가 아니므로 안내는 중립이다.
 */
export function ReloginPanel({ entry, onDone }: { entry: CommunityEntry; onDone: ReloginDone }) {
  const t = useT();
  const name = communityLabel(entry);
  const host = hostOf(entry.baseUrl);
  // 단축키 번호는 레지스트리 순서다(전환기 ⌥⌘1~9 와 같은 번호) — 여기서 다시 세지 않는다.
  const entries = useCommunityRegistry((r) => r.entries);
  const others = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.id !== entry.id);
  // 옛 보관본에서 되살린 커뮤니티는 로그인 ID 를 모른다 — 그때만 칸을 연다.
  const [loginId, setLoginId] = useState(entry.loginId ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 비밀번호 되찾기 — 로그인 화면과 같은 두 단계(안내 → 코드). 이 커뮤니티 서버로만 보낸다(designer 1). */
  const [recover, setRecover] = useState<null | 'guide' | 'code'>(null);
  // 기다리는 사이 패널이 내려갔으면(다른 커뮤니티로 옮김) 상태를 만지지 않는다(security n2).
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  /**
   * 토큰을 받은 뒤의 공통 길(비밀번호 로그인·코드 재설정). **같은 계정인지 먼저 본다**(security n1): 로그인 ID 칸이
   * 열려 있으면 같은 서버의 다른 계정으로도 들어갈 수 있는데, 그 계정이 이 칸과 이름표를 차지하면 안 된다.
   * 다른 계정은 커뮤니티 추가로 붙이라고 말하고 세우지 않는다.
   */
  const finish = async (api: ApiClient, token: string, usedLoginId: string) => {
    api.setToken(token);
    const me = await api.me();
    if (entry.accountId && me.id !== entry.accountId) {
      if (mounted.current) { setError(t('relogin.otherAccount')); setBusy(false); }
      return;
    }
    await onDone({ entryId: entry.id, baseUrl: api.baseUrl, token, accountId: me.id, handle: me.handle, loginId: usedLoginId });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password || !loginId) return;
    setBusy(true);
    setError(null);
    try {
      // 서버는 이 칸의 것으로 고정이다 — 다른 커뮤니티의 주소로 비밀번호가 가는 길이 없다.
      const api = new ApiClient(entry.baseUrl);
      const { token } = await api.login(loginId, password);
      await finish(api, token, loginId);
    } catch (err) {
      if (!mounted.current) return;
      // 서버가 거절한 것(비밀번호 틀림 등)은 서버 문구를, 닿지 못한 것은 기존 연결 문구를 쓴다 — 로그인 화면과 같다.
      setError(err instanceof ApiError ? err.message : t('connect.serverUnreachable'));
      setBusy(false);
    }
  };

  const field = 'w-full rounded-row border border-border bg-field px-3 py-2 text-fg placeholder-fg-subtle';
  // 고정 칸은 입력칸처럼 보이지 않게 테두리·면 없이 글자만(designer n6 — 다크에서 비밀번호 칸보다 더 칸처럼 보였다).
  const fixed = 'w-full truncate py-2 text-fg-muted';
  if (recover) {
    return (
      <div data-testid="relogin-panel" className="flex min-w-0 flex-1 justify-center overflow-y-auto bg-surface px-4 pb-4 pt-12">
        <div data-testid="relogin-recover" className="w-full max-w-sm rounded-card border border-border bg-surface-raised p-4">
          {recover === 'guide'
            ? <ForgotPasswordGuide onHaveCode={() => setRecover('code')} onBack={() => setRecover(null)} />
            : (
              <ResetWithCodeForm
                baseUrl={entry.baseUrl}
                initialLoginId={loginId}
                onSignedIn={async (api, token) => { await finish(api, token, loginId); }}
                onBack={() => setRecover('guide')}
              />
            )}
        </div>
      </div>
    );
  }
  return (
    <div data-testid="relogin-panel" className="flex min-w-0 flex-1 justify-center overflow-y-auto bg-surface px-4 pb-4 pt-12">
      <div className="w-full max-w-sm">
        <div aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-compose border border-border-strong bg-surface-sunken text-name font-semibold text-fg-muted">
          {initialOf(name)}
        </div>
        <h1 className="mt-3 truncate text-title font-semibold text-fg">{t('relogin.title', { name })}</h1>
        <p className="mt-1 text-body text-fg-muted">
          {t('relogin.body')}
          {others.some(({ e }) => !e.signedOut) && <> {t('relogin.othersFine')}</>}
        </p>
        <form onSubmit={(e) => { void submit(e); }} className="mt-3 rounded-card border border-border bg-surface-raised p-3">
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-meta font-semibold text-fg">{t('relogin.server')}</div>
              <div data-testid="relogin-server" className={fixed}>{host}</div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-meta font-semibold text-fg">{t('connect.field.loginId')}</div>
              {entry.loginId
                ? <div data-testid="relogin-login-id" className={fixed}>{entry.loginId}</div>
                : (
                  <input
                    aria-label={t('connect.field.loginId')}
                    data-testid="relogin-login-id-input"
                    className={field}
                    value={loginId}
                    onChange={(e) => setLoginId(e.target.value)}
                  />
                )}
            </div>
          </div>
          {/* 되찾기 링크는 비밀번호 라벨 줄 오른쪽 — 로그인 화면과 같은 자리·같은 이유로 label **밖**에 둔다
              (label 안에 버튼이 있으면 「비밀번호」를 눌렀을 때 되찾기가 열린다). Tab 은 칸 → 링크 → 버튼 순이다. */}
          <div className="relative mt-2">
            <label className="block text-meta font-semibold text-fg">
              {t('connect.field.password')}
              <input
                data-testid="relogin-password"
                type="password"
                autoFocus
                autoComplete="current-password"
                className={`${field} mt-1 font-normal`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button
              type="button"
              data-testid="relogin-forgot"
              className="absolute right-0 top-0 text-meta font-normal text-accent hover:underline"
              onClick={() => { setError(null); setRecover('guide'); }}
            >
              {t('connect.alt.forgot')}
            </button>
          </div>
          {error && <p role="alert" data-testid="relogin-error" className="mt-2 text-meta text-danger">{error}</p>}
          <button
            type="submit"
            data-testid="relogin-submit"
            disabled={busy || !password || !loginId}
            className={`mt-3 w-full rounded-row bg-accent px-3 py-2 font-semibold text-fg-on-strong disabled:opacity-60 ${FOCUS_RING}`}
          >
            {t('relogin.submit')}
          </button>
        </form>
        {others.length > 0 && (
          <div className="mt-4">
            <div className="text-meta text-fg-muted">{t('relogin.others')}</div>
            {others.map(({ e, i }) => <OtherRow key={e.id} entry={e} shortcut={entries.length > 1 && i < 9 ? `⌥⌘${i + 1}` : null} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/** 다른 커뮤니티 한 줄 — 누르면 그리로 간다. 끝난 것도 보이되 「로그인 필요」 칩을 단다. */
function OtherRow({ entry, shortcut }: { entry: CommunityEntry; shortcut: string | null }) {
  const t = useT();
  const connected = useStore(entry.store, (s) => s.connected);
  const name = communityLabel(entry);
  const state = entry.signedOut
    ? t('rail.community.signedOut')
    : t(connected ? 'rail.community.connected' : 'rail.community.disconnected');
  return (
    <button
      type="button"
      data-testid={`relogin-other-${entry.id}`}
      aria-label={t('rail.community.tile', { name, state })}
      onClick={() => { void switchCommunity(entry.id); }}
      className={`mt-1 flex w-full items-center gap-2 rounded-row border border-border bg-surface-raised px-2 py-1.5 text-left hover:bg-surface-hover ${FOCUS_RING}`}
    >
      <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-card bg-surface-sunken text-meta font-semibold text-fg-muted">
        {initialOf(name)}
      </span>
      <span className="min-w-0 truncate font-semibold text-fg">{name}</span>
      {/* 상태는 이름 바로 뒤에 붙인다 — 오른쪽 끝에 「· 연결됨」이 홀로 떨어져 서지 않게(designer n1). */}
      {entry.signedOut
        ? <span className="shrink-0 rounded-card border border-warning-border bg-warning-surface px-1.5 text-meta font-semibold text-warning">{state}</span>
        : <span className="shrink-0 text-meta text-fg-subtle">{state}</span>}
      {shortcut && <span aria-hidden="true" className="ml-auto shrink-0 font-mono text-meta text-fg-subtle">{shortcut}</span>}
    </button>
  );
}

const FOCUS_RING = 'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2';

function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).host || baseUrl; } catch { return baseUrl; }
}
