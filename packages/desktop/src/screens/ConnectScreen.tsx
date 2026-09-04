import { useState, useEffect } from 'react';
import { ApiClient, ApiError } from '../lib/api';
import { Logo } from '../components/Logo';

/** 로그인이 성공했을 때 위로 올려 보내는 것. 두 모드가 같은 값을 다른 곳으로 보낸다. */
type Credentials = (baseUrl: string, token: string, accountId: string, handle: string) => void | Promise<void>;

/**
 * 이 화면이 서는 두 자리(#165).
 *
 * - `initial`: 세션이 없다. 성공하면 `App` 이 `phase` 를 `ready` 로 옮긴다(오늘의 동작).
 * - `add`: **이미 다른 커뮤니티에 들어와 있다.** 성공은 레지스트리 등록이고, `phase` 는
 *   손대지 않는다 — `phase` 를 `connect` 로 되돌리면 다른 커뮤니티들의 라이브 연결이 화면과
 *   함께 사라진다(이 이슈가 푸는 문제 그 자체다).
 *
 * 판별 유니온으로 둔 이유: 콜백 둘을 옵셔널로 두면 배선을 잊은 자리에서도 폼이 그려지고
 * 로그인이 성공한 뒤 **아무 일도 일어나지 않는다**(docs/design.md §4 의 '눌러도 아무 일이
 * 없는 버튼'). 타입이 그 조합을 아예 만들지 못하게 한다.
 */
export type ConnectScreenProps =
  | { mode?: 'initial'; onConnected: Credentials; initialError?: string | null }
  | { mode: 'add'; onAdded: Credentials; onCancel(): void; initialError?: string | null };

export function ConnectScreen(props: ConnectScreenProps) {
  const { initialError = null } = props;
  const adding = props.mode === 'add';
  const [baseUrl, setBaseUrl] = useState('http://localhost:3400');
  const [loginId, setLoginId] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  /**
   * 이 화면이 다루는 세 경우(#120). 불리언 하나로는 표현되지 않는다:
   * - `signin`: 이미 계정이 있다 (`add` 모드에서 기본이자 사실상 유일한 시작점이다)
   * - `bootstrap`: **첫 사람**. 사람 계정이 이미 있으면 서버가 409 로 막는다
   * - `register`: **초대받은 사람**. admin 이 발급한 토큰이 필요하다
   *
   * 서버에 "지금 부트스트랩이 가능한가"를 묻는 표면이 없어서(`POST /bootstrap` 을 실제로
   * 불러 봐야 409 를 안다) 사용자가 고르게 둔다 — 추측해서 잘못된 폼을 보여주면 그게 더 나쁘다.
   */
  const [authMode, setAuthMode] = useState<'signin' | 'bootstrap' | 'register'>('signin');
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
      if (authMode === 'bootstrap') await api.bootstrap(loginId, handle, displayName || handle, password);
      if (authMode === 'register') await api.register(loginId, handle, displayName || handle, password, inviteToken.trim());
      // 계정 생성 라우트는 둘 다 세션을 주지 않는다(`{ id }` 만) — 만든 자격증명으로 이어서
      // 로그인한다. 그래서 가입 성공이 곧 로그인 상태가 된다.
      const { token } = await api.login(loginId, password);
      // 토큰을 **여기서** 클라이언트에 싣는다. `login()` 은 토큰을 돌려주기만 하므로,
      // 싣지 않고 `me()` 를 부르면 authorization 헤더가 없어 401 이 된다(#246 — login 은
      // 200 인데 그 직후 /auth/me 가 401 이라 아무도 앱에 들어갈 수 없었다).
      api.setToken(token);
      const me = await api.me();
      // 성공을 **어디로** 올려 보내는가가 두 모드의 유일한 차이다. `add` 는 `onAdded` 로
      // 가고 `onConnected`(= `phase` 를 옮기는 초기 흐름)를 부르지 않는다.
      if (props.mode === 'add') await props.onAdded(api.baseUrl, token, me.id, me.handle);
      else await props.onConnected(api.baseUrl, token, me.id, me.handle);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded border border-border bg-field px-3 py-2 text-fg placeholder-fg-subtle';
  // `add` 는 겹창 안에서 그려진다 — 화면 전체를 차지하는 껍데기는 겹창이 이미 갖고 있고,
  // 여기서 `h-screen` 을 또 두면 모달 안에 빈 화면 하나가 더 생긴다.
  //
  // #342: `initial` 쪽도 `h-screen` 이 아니라 `h-full` 이다. 이제 `App` 이 창 손잡이 띠와
  // 함께 감싸므로, 여기서 화면 **전체** 높이를 다시 잡으면 띠 높이만큼 넘쳐 세로 스크롤이
  // 생긴다. 남은 높이를 채우는 것으로 충분하다.
  const shell = adding
    ? 'flex items-center justify-center'
    : 'flex h-full items-center justify-center bg-surface-sunken';
  return (
    <div className={shell}>
      <form
        className="w-80 space-y-3 rounded-lg bg-surface-raised p-6 shadow"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <div className="flex flex-col items-center gap-1 text-fg">
          <Logo size={48} decorative />
          {/* 제목이 이 화면이 무엇을 하는 중인지 말한다. `add` 에서 'murmur' 라고만 적으면
              이미 murmur 안에 있는 사람에게 아무것도 알려 주지 않는다. */}
          <h1 className="text-lg font-bold">{adding ? 'Sign in to another community' : 'murmur'}</h1>
        </div>
        <label className="block text-xs font-medium">
          Server URL
          <input className={field} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        {authMode === 'signin' ? (
          <label className="block text-xs font-medium">
            Login ID
            <input className={field} value={loginId} onChange={(e) => setLoginId(e.target.value)} />
          </label>
        ) : (
          <>
            <label className="block text-xs font-medium">
              Login ID
              <input className={field} value={loginId} onChange={(e) => setLoginId(e.target.value)} />
            </label>
            <label className="block text-xs font-medium">
              Handle (@)
              <input className={field} value={handle} onChange={(e) => setHandle(e.target.value)} />
            </label>
            <label className="block text-xs font-medium">
              Display name
              <input className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
          </>
        )}
        {authMode === 'register' && (
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
          // 초대 가입은 토큰 없이 보내면 서버가 400 을낸다 — 보내기 전에 막는다.
          disabled={busy || (authMode === 'register' && inviteToken.trim() === '')}
          className="w-full rounded bg-accent py-2 font-medium text-fg-on-strong disabled:opacity-50"
        >
          {authMode === 'signin' ? 'Sign in' : authMode === 'bootstrap' ? 'Create account' : 'Join with invite'}
        </button>
        {authMode === 'signin' ? (
          <div className="space-y-1">
            <button
              type="button"
              className="w-full text-xs text-fg-subtle underline"
              onClick={() => setAuthMode('register')}
            >
              Have an invite token? Join this workspace
            </button>
            {/* 부트스트랩은 `add` 에서 **감춘다**(#165 결정 3). 이미 서버가 있는 사람이 새
                서버의 첫 관리자 계정을 만드는 것은 "커뮤니티를 하나 더 붙인다" 와 다른 일이고,
                여기서 내주면 그 일을 이 폼 안에서 하도록 권하는 셈이 된다. */}
            {!adding && (
              <button
                type="button"
                className="w-full text-xs text-fg-subtle underline"
                onClick={() => setAuthMode('bootstrap')}
              >
                First run? Create the admin account
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="w-full text-xs text-fg-subtle underline"
            onClick={() => { setAuthMode('signin'); setError(null); }}
          >
            Back to sign in
          </button>
        )}
        {props.mode === 'add' && (
          <button
            type="button"
            className="w-full rounded border border-border py-1.5 text-xs font-medium hover:bg-surface"
            onClick={props.onCancel}
          >
            Cancel
          </button>
        )}
      </form>
    </div>
  );
}
