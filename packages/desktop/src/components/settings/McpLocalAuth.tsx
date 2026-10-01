/**
 * 원격 MCP 한 줄의 **이 머신** 인증 상태와 버튼(2026-09-30, #959).
 *
 * 토큰은 오퍼레이터가 든다 — 한 번 인증하면 이 머신의 모든 에이전트가, 계정 풀의 어느 계정으로
 * 돌든 같은 토큰을 쓴다. 인가 url 은 오퍼레이터가 만들고(PKCE·state), 여기서는 브라우저로 열고
 * 끝날 때까지 상태를 물을 뿐이다.
 *
 * 두 화면이 같이 쓴다: 워크스페이스 설정 › MCP servers(사람이 인증하러 먼저 찾는 곳)와
 * 에이전트 상세의 MCP 절. 처음에는 에이전트 상세에만 두었다가 "인증이 없는데?"를 들었다(09-30).
 *
 * `rejected`(2026-10-01) 는 오퍼레이터의 판정이다: 하네스가 MCP 서버에 이 토큰을 거절당했고, 그 보고로
 * 곧바로 받은 새 토큰도 다시 거절됐다. 전에는 같은 일이 일어나도 저장된 토큰만 보고 "인증됨"을
 * 띄웠다(10-01 slack). 언제·어느 에이전트에서 거절됐는지를 빨갛게 보이고, `ok` 에도 [다시 인증]을
 * 둔다 — 화면이 맞다고 해도 사람이 실제 실패를 보고 곧바로 다시 인증할 수 있게.
 *
 * `none` 이 곧 "인증 필요"는 아니다 — 요구 여부는 서버가 안다. 정의에 `oauth` 가 적혀 있으면
 * (slack 프리셋) 요구한다고 보고, `warn`(에이전트에 켠 줄)이면 빨갛게 보인다.
 */
import { useEffect, useState } from 'react';
import type { OperatorMcpEntry } from '@harkroom/shared/daemonProtocol';
import { forgetLocalMcpAuth, localMcpAuthStatus, startLocalMcpAuth } from '../../lib/operatorLocal';
import { getExternalOpener } from '../../lib/openExternal';
import { selectAccountNames } from '../../lib/accountNames';
import { stampLabel } from '../../lib/day';
import { useActiveStore } from '../../state/communities';
import { useLocale, useT } from '../../i18n/useT';

/** 흐름의 수명과 같다(오퍼레이터가 5분에 닫는다). */
const WAIT_MS = 5 * 60_000;
const POLL_MS = 1500;

export function McpLocalAuth({ entry, warn, disabled, onChanged, onError }: {
  entry: OperatorMcpEntry;
  warn?: boolean;
  disabled?: boolean;
  /** 상태가 바뀌었다 — 목록을 다시 읽는다. */
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const names = useActiveStore(selectAccountNames);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!waiting) return;
    const until = Date.now() + WAIT_MS;
    const timer = setInterval(() => {
      void localMcpAuthStatus(entry.name).then((st) => {
        if (st.state === 'pending' && Date.now() < until) return;
        setWaiting(false);
        onChanged();
      }).catch(() => { setWaiting(false); onChanged(); });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, entry.name, onChanged]);

  if (entry.transport === 'stdio' || !entry.auth) return null;

  const fail = (e: unknown) => onError(t('agents.mcp.auth.failed', { reason: e instanceof Error ? e.message : String(e) }));
  const signIn = () => void (async () => {
    try {
      const { authUrl } = await startLocalMcpAuth(entry.name);
      setWaiting(true);
      await getExternalOpener().open(authUrl);
    } catch (e) {
      setWaiting(false);
      fail(e);
    }
  })();
  const signOut = () => void forgetLocalMcpAuth(entry.name).then(onChanged, fail);

  const id = entry.name;
  const st = waiting ? { state: 'pending' as const } : entry.auth;
  const button = (label: string, action: () => void, testid: string) => (
    <button className="rounded border border-border px-1.5 py-0.5 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
      data-testid={testid} disabled={disabled} onClick={action}>{label}</button>
  );
  if (st.state === 'ok') {
    return (
      <span className="flex items-center gap-1" data-testid={`agent-mcp-auth-${id}`}>
        <span className="text-fg-subtle">{t('agents.mcp.auth.ok')}</span>
        {button(t('agents.mcp.auth.again'), signIn, `agent-mcp-auth-start-${id}`)}
        {button(t('agents.mcp.auth.forget'), signOut, `agent-mcp-auth-forget-${id}`)}
      </span>
    );
  }
  if (st.state === 'pending') {
    return <span className="text-fg-subtle" data-testid={`agent-mcp-auth-${id}`}>{t('agents.mcp.auth.pending')}</span>;
  }
  if (st.state === 'rejected') {
    // 이름은 표시용이다 — 오퍼레이터는 id 로 남긴다. 모르는 id(다른 워크스페이스의 에이전트)는 이름 없이.
    const agent = st.agentId ? names[st.agentId] : undefined;
    const time = stampLabel(new Date(st.at).toISOString(), locale);
    return (
      <span className="flex items-center gap-1" data-testid={`agent-mcp-auth-${id}`} title={t('agents.mcp.auth.rejectedNote')}>
        <span className="text-danger">
          {agent
            ? t('agents.mcp.auth.rejected', { time, agent: agent.displayName || agent.handle })
            : t('agents.mcp.auth.rejectedNoAgent', { time })}
        </span>
        {button(t('agents.mcp.auth.again'), signIn, `agent-mcp-auth-start-${id}`)}
      </span>
    );
  }
  const text = st.state === 'expired'
    ? t('agents.mcp.auth.expired')
    : st.state === 'error'
      ? t('agents.mcp.auth.error', { reason: st.reason })
      : entry.oauth ? t('agents.mcp.auth.needed') : null;
  const red = warn && (st.state !== 'none' || entry.oauth);
  return (
    <span className="flex items-center gap-1" data-testid={`agent-mcp-auth-${id}`} title={t('agents.mcp.auth.note')}>
      {text && <span className={red ? 'text-danger' : 'text-fg-subtle'}>{text}</span>}
      {button(st.state === 'none' ? t('agents.mcp.auth.start') : t('agents.mcp.auth.again'), signIn, `agent-mcp-auth-start-${id}`)}
    </span>
  );
}
