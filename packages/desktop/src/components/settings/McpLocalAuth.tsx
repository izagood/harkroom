/**
 * 원격 MCP 한 줄의 **이 머신** 인증 상태와 버튼(2026-09-30, #959).
 *
 * 토큰은 오퍼레이터가 든다 — 한 번 인증하면 이 머신의 모든 에이전트가, 계정 풀의 어느 계정으로
 * 돌든 같은 토큰을 쓴다. 인가 url 은 오퍼레이터가 만들고(PKCE·state), 여기서는 브라우저로 열고
 * 끝날 때까지 상태를 물을 뿐이다.
 *
 * 인증은 설정 › 연동 › MCP 서버의 operator 칸에서만 한다(MCP 설정 시안 v2, 2026-10-21) — 에이전트 상세의 MCP 절은
 * 상태 한 줄과 「연동에서 … →」 링크만 둔다. 처음에는 에이전트 상세에만 두었다가 "인증이 없는데?"를 들었고(09-30),
 * 두 화면에 같은 버튼을 두다가 v2 에서 연동 하나로 모았다.
 *
 * `rejected`(2026-10-01) 는 오퍼레이터의 판정이다: 하네스가 MCP 서버에 이 토큰을 거절당했고, 그 보고로
 * 곧바로 받은 새 토큰도 다시 거절됐다. 전에는 같은 일이 일어나도 저장된 토큰만 보고 "인증됨"을
 * 띄웠다(10-01 slack). 언제·어느 에이전트에서 거절됐는지를 빨갛게 보이고, `ok` 에도 [다시 인증]을
 * 둔다 — 화면이 맞다고 해도 사람이 실제 실패를 보고 곧바로 다시 인증할 수 있게.
 *
 * `none` 이 곧 "인증 필요"는 아니다 — 요구 여부는 서버가 안다. 정의에 `oauth` 가 적혀 있으면
 * (slack 프리셋) 요구한다고 보고, `warn`(에이전트에 켠 줄)이면 빨갛게 보인다.
 */
import { useEffect, useRef, useState } from 'react';
import { getController } from '../../state/controller';
import { forgetLocalMcpAuth, localMcpAuthStatus, startLocalMcpAuth } from '../../lib/operatorLocal';
import { getExternalOpener } from '../../lib/openExternal';
import { useT } from '../../i18n/useT';
import { errorText } from '../../lib/errorText';

/** 흐름의 수명과 같다(오퍼레이터가 5분에 닫는다). */
const WAIT_MS = 5 * 60_000;
const POLL_MS = 1500;

/**
 * 인증 흐름(브라우저 열기 → 끝날 때까지 상태 묻기)과 해제. 버튼 모양은 부르는 쪽이 정한다 — 연동 화면의
 * operator 칸(`McpServersSettings`)이 쓴다.
 */
export function useMcpSignIn(name: string, onChanged: () => void, onError: (message: string) => void) {
  const t = useT();
  const [waiting, setWaiting] = useState(false);
  // 흐름을 **시작한** 커뮤니티. 로그인 중에 다른 커뮤니티로 옮겨도 상태는 그 커뮤니티의 오퍼레이터에 묻는다(security #1640 n1).
  const flowCommunity = useRef<string | null>(null);

  useEffect(() => {
    if (!waiting) return;
    const until = Date.now() + WAIT_MS;
    const timer = setInterval(() => {
      void localMcpAuthStatus(name, flowCommunity.current).then((st) => {
        if (st.state === 'pending' && Date.now() < until) return;
        setWaiting(false);
        onChanged();
      }).catch(() => { setWaiting(false); onChanged(); });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, name, onChanged]);

  const fail = (e: unknown) => onError(t('agents.mcp.auth.failed', { reason: errorText(e, t) }));
  const signIn = () => void (async () => {
    try {
      flowCommunity.current = getController().api?.baseUrl ?? null;
      const { authUrl } = await startLocalMcpAuth(name, flowCommunity.current);
      setWaiting(true);
      await getExternalOpener().open(authUrl);
    } catch (e) {
      setWaiting(false);
      fail(e);
    }
  })();
  const signOut = () => void forgetLocalMcpAuth(name, getController().api?.baseUrl ?? null).then(onChanged, fail);
  return { waiting, signIn, signOut };
}
