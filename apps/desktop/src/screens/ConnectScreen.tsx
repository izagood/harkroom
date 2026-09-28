import { useState, useEffect, useRef } from 'react';
import { ApiClient, ApiError } from '../lib/api';
import { GateClient, gateErrorText, gateProgressText, pendingWorkspace,
  type PendingWorkspace } from '../lib/gate';
import { Logo } from '../components/Logo';
import { ConnectUpdateBanner } from '../components/ConnectUpdateBanner';

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
  const [authMode, setAuthMode] = useState<'signin' | 'bootstrap' | 'register' | 'create'>('signin');
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);

  /**
   * `create` 가 쓰는 것들. gate 주소는 **사용자가 적는다** — 이 저장소는 self-host 제품이고
   * 호스팅 서비스의 주소는 그 배포 하나의 사정이라 제품 코드가 알 이유가 없다.
   */
  const [gateUrl, setGateUrl] = useState('');
  const [wsName, setWsName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [email, setEmail] = useState('');
  /** 만들어지는 중인 것. 이 값이 있으면 화면은 진행/클레임 쪽으로 넘어간다. */
  const [pending, setPending] = useState<PendingWorkspace | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  /** 클레임할 수 있게 됐는가. 폴링이 `ready` 를 본 뒤에만 참이다. */
  const [claimable, setClaimable] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (initialError) setError(initialError);
  }, [initialError]);

  /**
   * 앱을 닫았다 열어도 **만들다 만 것을 이어받는다**(`add` 겹창에서는 하지 않는다 —
   * 거기서 새 워크스페이스를 만드는 것은 이 화면의 일이 아니다).
   *
   * 이것이 없으면 기다리는 동안 앱을 닫은 사람은 `claimToken` 을 잃고, 그 토큰은 다시 볼
   * 수 없으므로 워크스페이스가 **만들어졌는데 아무도 가져갈 수 없는** 상태가 된다.
   */
  useEffect(() => {
    if (adding) return;
    const saved = pendingWorkspace.read();
    if (saved) { setPending(saved); setAuthMode('create'); }
  }, [adding]);

  /** 화면이 사라질 때 폴링을 멈춘다 — 안 멈추면 언마운트 뒤에도 setState 가 돈다. */
  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

  /**
   * 작업이 끝날 때까지 물어본다.
   *
   * **`waiting_ready` 가 오래 가는 것은 정상이다** — 만들어지기까지 사람이 한 번 승인해야
   * 하기 때문이다. 그래서 여기서 스스로 타임아웃을 두지 않는다: 화면이 먼저 포기하면
   * 아직 살아 있는 작업을 실패로 보여 주게 되고, 그 판정은 gate 쪽에 이미 있다.
   */
  const poll = async (p: PendingWorkspace) => {
    try {
      const job = await new GateClient(p.gateUrl).job(p.jobId);
      setProgress(gateProgressText(job));
      if (job.status === 'ready') { setClaimable(true); return; }
      if (job.status === 'failed') {
        // **진행 줄은 비운다.** 같은 문장을 진행과 오류 두 자리에 두면 화면에 두 번 뜨고,
        // 읽는 사람은 서로 다른 두 사실이라고 읽는다.
        setProgress(null);
        setError(gateProgressText(job));
        return;
      }
      pollTimer.current = setTimeout(() => { void poll(p); }, 5000);
    } catch (err) {
      // 폴링 실패로 **보관본을 지우지 않는다.** 네트워크가 잠깐 끊긴 것과 작업이 죽은 것을
      // 여기서 구분할 수 없고, 지우면 클레임 토큰이 함께 사라진다.
      setProgress(err instanceof ApiError ? err.message : 'Could not reach the workspace service');
      pollTimer.current = setTimeout(() => { void poll(p); }, 15000);
    }
  };

  useEffect(() => {
    if (pending && !claimable) void poll(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.jobId]);

  /** 워크스페이스를 만들어 달라고 한다. 성공하면 **곧바로 보관**한다. */
  const createWorkspace = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await new GateClient(gateUrl).create({
        name: wsName.trim(), inviteCode: inviteCode.trim(), email: email.trim(),
      });
      const p: PendingWorkspace = {
        gateUrl: gateUrl.replace(/\/$/, ''), jobId: res.jobId,
        claimToken: res.claimToken, url: res.url, name: res.name,
      };
      // **응답을 화면에 그리기 전에 적는다.** 클레임 토큰은 이 응답에만 있고, 여기서
      // 앱이 죽으면 그 워크스페이스는 영영 가져갈 수 없다.
      pendingWorkspace.write(p);
      setPending(p);
      setProgress('Submitted — waiting for approval…');
    } catch (err) {
      setError(gateErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 받아 둔 토큰으로 첫 관리자를 만든다. **사용자는 토큰을 보지도 옮겨 적지도 않는다** —
   * 손으로 옮기게 하면 그 한 번의 실수가 워크스페이스를 못 쓰게 만든다.
   */
  const claimWorkspace = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const api = new ApiClient(pending.url);
      await api.claim(pending.claimToken, loginId, handle, displayName || handle, password);
      const { token } = await api.login(loginId, password);
      api.setToken(token);
      const me = await api.me();
      // 클레임이 끝나야 지운다 — 실패하면 토큰이 남아 있어야 다시 시도할 수 있다.
      pendingWorkspace.clear();
      if (props.mode === 'add') await props.onAdded(api.baseUrl, token, me.id, me.handle);
      else await props.onConnected(api.baseUrl, token, me.id, me.handle);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  /** 만들던 것을 버린다. 보관본까지 지워야 다음 기동에 되살아나지 않는다. */
  const discardPending = () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pendingWorkspace.clear();
    setPending(null); setClaimable(false); setProgress(null); setError(null);
  };

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
  // 여기서 창 높이(`h-full`)를 또 두면 모달 안에 빈 화면 하나가 더 생긴다.
  //
  // #342: `initial` 쪽도 창 높이를 스스로 잡지 않고 `h-full` 이다. 이제 `App` 이 창 손잡이 띠와
  // 함께 감싸므로, 여기서 화면 **전체** 높이를 다시 잡으면 띠 높이만큼 넘쳐 세로 스크롤이
  // 생긴다. 남은 높이를 채우는 것으로 충분하다.
  const shell = adding
    ? 'flex items-center justify-center'
    : 'flex h-full items-center justify-center bg-surface-sunken';
  return (
    <div className={shell}>
      <form
        className="w-80 space-y-3 rounded-lg bg-surface-raised p-6 shadow"
        onSubmit={(e) => {
          e.preventDefault();
          // `create` 는 두 단계다 — 만들기, 그리고 준비되면 클레임.
          if (authMode === 'create') { void (pending ? claimWorkspace() : createWorkspace()); return; }
          void submit();
        }}
      >
        <div className="flex flex-col items-center gap-1 text-fg">
          <Logo size={48} decorative />
          {/* 제목이 이 화면이 무엇을 하는 중인지 말한다. `add` 에서 'murmur' 라고만 적으면
              이미 harkroom 안에 있는 사람에게 아무것도 알려 주지 않는다. */}
          {/* **화면 제목단 17px.** 18px(`text-lg`)이었고 4단 중 아무것도 아니었다. 이 자리는
              화면 하나가 무엇을 하는 중인지 말하는 유일한 줄이라 맨 윗단이 맞다 —
              `SettingsPage` 의 제목과 같은 단이다(그 파일에 근거를 적어 뒀다). */}
          <h1 className="text-title font-bold">
            {authMode === 'create' ? 'Create a workspace' : adding ? 'Sign in to another community' : 'Harkroom'}
          </h1>
        </div>
        {/* 로그인 **전**에도 업데이트할 수 있어야 한다(실측 2026-09-07): 서버에 못 붙는
            버전이면 업데이트가 필요한데, 업데이트가 로그인 뒤에만 있으면 빠져나갈 길이 없다.

            `add` 는 겹창이고 그 사람은 이미 들어와 있다 — Settings 가 열려 있으므로 이
            배너가 푸는 고리가 없다. 겹창에 업데이트 안내를 겹쳐 놓지 않는다. */}
        {!adding && <ConnectUpdateBanner />}
        {/* 입력 라벨은 **아랫단 11px**, 입력칸 자체는 본문단 13px(`field` 에 크기가 없어
            앱 기본값을 물려받는다). 라벨이 값보다 작은 것이 이 저장소의 라벨·값 짝이다
            (`settings/primitives.tsx` 의 `FIELD_LABEL`·`FIELD_BOX` 가 같은 짝이다).
            아래 '초대 토큰 있나' 같은 곁길 버튼도 같은 아랫단이다 — 폼을 채우는 사람이
            읽는 것은 라벨과 오류 한 줄이고, 그 오류만 본문단으로 올렸다. */}
        {/* `create` 는 **서버 주소를 묻지 않는다** — 그 주소는 아직 존재하지 않고, gate 가
            만들어 준 뒤에야 정해진다. 대신 만들어 달라고 할 곳(gate)을 묻는다. */}
        {authMode === 'create' ? (
          pending ? (
            <>
              {/* 만들어지는 중이거나, 준비돼 클레임을 기다리는 자리. */}
              <div className="rounded border border-border bg-field px-3 py-2">
                <p className="text-meta text-fg-subtle">Workspace</p>
                <p className="text-fg">{pending.url}</p>
              </div>
              {progress && <p className="text-meta text-fg-subtle">{progress}</p>}
              {claimable ? (
                <>
                  {/* 준비됐다. 이제 첫 관리자를 만든다 — **토큰은 화면이 들고 있다.** */}
                  <p className="text-meta text-fg-subtle">
                    Ready. Create the first admin account for this workspace.
                  </p>
                  <label className="block text-meta font-medium">
                    Login ID
                    <input className={field} value={loginId} onChange={(e) => setLoginId(e.target.value)} />
                  </label>
                  <label className="block text-meta font-medium">
                    Handle (@)
                    <input className={field} value={handle} onChange={(e) => setHandle(e.target.value)} />
                  </label>
                  <label className="block text-meta font-medium">
                    Display name
                    <input className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                  </label>
                  <label className="block text-meta font-medium">
                    Password
                    <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </label>
                </>
              ) : (
                /* **기다림이 길 수 있다**(승인이 필요하다). 그래서 "닫아도 된다"를 말해 준다 —
                   말하지 않으면 사람은 창을 붙잡고 있거나, 닫고 나서 잃었다고 생각한다. */
                <p className="text-meta text-fg-subtle">
                  This can take a while. You can close the app — we saved this, and it will be here when you return.
                </p>
              )}
            </>
          ) : (
            <>
              <label className="block text-meta font-medium">
                Workspace service URL
                <input className={field} value={gateUrl} onChange={(e) => setGateUrl(e.target.value)} placeholder="https://…" />
              </label>
              <label className="block text-meta font-medium">
                Workspace name
                <input className={field} value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="my-team" />
              </label>
              <label className="block text-meta font-medium">
                Invite code
                <input className={field} value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} />
              </label>
              {/* 이메일은 **복구 경로**다. 계정에는 이메일이 없으므로(설계상) 비밀번호를
                  잃었을 때 본인 확인에 쓸 것이 이것뿐이다. */}
              <label className="block text-meta font-medium">
                Email
                <input className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
            </>
          )
        ) : (
        <>
        <label className="block text-meta font-medium">
          Server URL
          <input className={field} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        {authMode === 'signin' ? (
          <label className="block text-meta font-medium">
            Login ID
            <input className={field} value={loginId} onChange={(e) => setLoginId(e.target.value)} />
          </label>
        ) : (
          <>
            <label className="block text-meta font-medium">
              Login ID
              <input className={field} value={loginId} onChange={(e) => setLoginId(e.target.value)} />
            </label>
            <label className="block text-meta font-medium">
              Handle (@)
              <input className={field} value={handle} onChange={(e) => setHandle(e.target.value)} />
            </label>
            <label className="block text-meta font-medium">
              Display name
              <input className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
          </>
        )}
        {authMode === 'register' && (
          <label className="block text-meta font-medium">
            Invite token
            <input
              className={field}
              value={inviteToken}
              onChange={(e) => setInviteToken(e.target.value)}
              placeholder="muri_…"
            />
          </label>
        )}
        <label className="block text-meta font-medium">
          Password
          <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        </>
        )}
        {/* 오류는 본문단이다 — 로그인이 막힌 사람에게 이 한 줄이 유일한 단서다. */}
        {error && <p className="text-danger">{error}</p>}
        <button
          type="submit"
          disabled={
            busy
            // 초대 가입은 토큰 없이 보내면 서버가 400 을낸다 — 보내기 전에 막는다.
            || (authMode === 'register' && inviteToken.trim() === '')
            // 만들기도 같다: 네 칸이 다 있어야 gate 가 받는다.
            || (authMode === 'create' && !pending
              && (gateUrl.trim() === '' || wsName.trim() === '' || inviteCode.trim() === '' || email.trim() === ''))
            // 준비되기 전에는 누를 것이 없다 — 기다리는 중에 버튼만 살아 있으면 눌러 보게 된다.
            || (authMode === 'create' && pending !== null && !claimable)
          }
          className="w-full rounded bg-accent py-2 font-medium text-fg-on-strong disabled:opacity-50"
        >
          {authMode === 'create'
            ? (pending ? (claimable ? 'Create admin account' : 'Waiting…') : 'Create workspace')
            : authMode === 'signin' ? 'Sign in' : authMode === 'bootstrap' ? 'Create account' : 'Join with invite'}
        </button>
        {authMode === 'signin' ? (
          <div className="space-y-1">
            <button
              type="button"
              className="w-full text-meta text-fg-subtle underline"
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
                className="w-full text-meta text-fg-subtle underline"
                onClick={() => setAuthMode('bootstrap')}
              >
                First run? Create the admin account
              </button>
            )}
            {/* 부트스트랩과 **다른 일**이다: 저쪽은 이미 있는 서버의 첫 계정이고, 이쪽은
                서버 자체를 만들어 달라고 하는 것이다. `add` 에서 감추는 이유는 부트스트랩과
                같다(#165 결정 3) — 커뮤니티를 하나 더 붙이는 자리에서 권할 일이 아니다. */}
            {!adding && (
              <button
                type="button"
                className="w-full text-meta text-fg-subtle underline"
                onClick={() => setAuthMode('create')}
              >
                Have an invite code? Create a hosted workspace
              </button>
            )}
          </div>
        ) : authMode === 'create' ? (
          <button
            type="button"
            className="w-full text-meta text-fg-subtle underline"
            onClick={() => {
              // 만들던 것이 있으면 **그것까지 버린다.** 보관본만 남겨 두고 화면을 벗어나면
              // 다음 기동에 되살아나 사용자가 버린 것이 돌아온다.
              if (pending) discardPending();
              setAuthMode('signin'); setError(null);
            }}
          >
            {pending ? 'Discard and go back to sign in' : 'Back to sign in'}
          </button>
        ) : (
          <button
            type="button"
            className="w-full text-meta text-fg-subtle underline"
            onClick={() => { setAuthMode('signin'); setError(null); }}
          >
            Back to sign in
          </button>
        )}
        {props.mode === 'add' && (
          <button
            type="button"
            className="w-full rounded border border-border py-1.5 text-meta font-medium hover:bg-surface"
            onClick={props.onCancel}
          >
            Cancel
          </button>
        )}
      </form>
    </div>
  );
}
