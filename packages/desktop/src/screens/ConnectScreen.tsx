import { useState, useEffect } from 'react';
import { ApiClient, ApiError } from '../lib/api';
import { Logo } from '../components/Logo';

export function ConnectScreen({ onConnected, initialError = null }: { onConnected: (baseUrl: string, token: string, accountId: string, handle: string) => void; initialError?: string | null }) {
  const [baseUrl, setBaseUrl] = useState('http://localhost:3400');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  /**
   * 이 화면이 다루는 세 경우(#120). 불리언 하나로는 표현되지 않는다:
   * - `signin`: 이미 계정이 있다
   * - `bootstrap`: **첫 사람**. 사람 계정이 이미 있으면 서버가 409 로 막는다
   * - `register`: **초대받은 사람**. admin 이 발급한 토큰이 필요하다
   *
   * 서버에 "지금 부트스트랩이 가능한가"를 묻는 표면이 없어서(`POST /bootstrap` 을 실제로
   * 불러 봐야 409 를 안다) 사용자가 고르게 둔다 — 추측해서 잘못된 폼을 보여주면 그게 더 나쁘다.
   */
  const [mode, setMode] = useState<'signin' | 'bootstrap' | 'register'>('signin');
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialError) setError(initialError);
  }, [initialError]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const api = new ApiClient(baseUrl);
      if (mode === 'bootstrap') await api.bootstrap(handle, displayName || handle, password);
      if (mode === 'register') await api.register(handle, displayName || handle, password, inviteToken.trim());
      // 계정 생성 라우트는 둘 다 세션을 주지 않는다(`{ id }` 만) — 만든 자격증명으로 이어서
      // 로그인한다. 그래서 가입 성공이 곧 로그인 상태가 된다.
      const { token } = await api.login(handle, password);
      // 토큰을 **여기서** 클라이언트에 싣는다. `login()` 은 토큰을 돌려주기만 하므로,
      // 싣지 않고 `me()` 를 부르면 authorization 헤더가 없어 401 이 된다(#246 — login 은
      // 200 인데 그 직후 /auth/me 가 401 이라 아무도 앱에 들어갈 수 없었다).
      api.setToken(token);
      const me = await api.me();
      onConnected(api.baseUrl, token, me.id, me.handle);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded border border-border bg-field px-3 py-2 text-fg placeholder-fg-subtle';
  return (
    <div className="flex h-screen items-center justify-center bg-surface-sunken">
      <form
        className="w-80 space-y-3 rounded-lg bg-surface-raised p-6 shadow"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <div className="flex flex-col items-center gap-1 text-fg">
          <Logo size={48} decorative />
          <h1 className="text-lg font-bold">murmur</h1>
        </div>
        <label className="block text-xs font-medium">
          Server URL
          <input className={field} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label className="block text-xs font-medium">
          Handle
          <input className={field} value={handle} onChange={(e) => setHandle(e.target.value)} />
        </label>
        {mode !== 'signin' && (
          <label className="block text-xs font-medium">
            Display name
            <input className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        )}
        {mode === 'register' && (
          <label className="block text-xs font-medium">
            Invite token
            <input
              className={field}
              value={inviteToken}
              onChange={(e) => setInviteToken(e.target.value)}
              placeholder="muri_…"
            />
          </label>
        )}
        <label className="block text-xs font-medium">
          Password
          <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="text-xs text-danger">{error}</p>}
        <button
          type="submit"
          // 초대 가입은 토큰 없이 보내면 서버가 400 을 낸다 — 보내기 전에 막는다.
          disabled={busy || (mode === 'register' && inviteToken.trim() === '')}
          className="w-full rounded bg-accent py-2 font-medium text-fg-on-strong disabled:opacity-50"
        >
          {mode === 'signin' ? 'Sign in' : mode === 'bootstrap' ? 'Create account' : 'Join with invite'}
        </button>
        {mode === 'signin' ? (
          <div className="space-y-1">
            <button
              type="button"
              className="w-full text-xs text-fg-subtle underline"
              onClick={() => setMode('register')}
            >
              Have an invite token? Join this workspace
            </button>
            <button
              type="button"
              className="w-full text-xs text-fg-subtle underline"
              onClick={() => setMode('bootstrap')}
            >
              First run? Create the admin account
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="w-full text-xs text-fg-subtle underline"
            onClick={() => { setMode('signin'); setError(null); }}
          >
            Back to sign in
          </button>
        )}
      </form>
    </div>
  );
}
