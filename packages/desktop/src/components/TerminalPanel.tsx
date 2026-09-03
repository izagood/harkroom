import { useEffect, useRef, useState } from 'react';
import type { AgentSessionState } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { connectAgentAttach, type AttachHandle } from '../lib/agentTerminal';
import { getTerminalSinkFactory, type TerminalSink } from '../lib/terminalSink';

/**
 * 진행 중인 에이전트 터미널 패널(#141 Phase 2, 스펙 §5).
 *
 * **채널 레이아웃에 심지 않았다.** `#189`(앱 안 터미널 패널이 어디서 도는가)가 아직 열려
 * 있어서, 지금 채널 안에 터미널을 넣으면 그 결정이 코드로 먼저 굳는다. 오른쪽에서 열리는
 * 별도 패널은 스레드 패널과 같은 자리를 쓰므로 레이아웃 결정을 선점하지 않는다.
 *
 * **Phase 2 는 읽기만이다.** 입력창이 없는 것은 미완성이 아니라 범위다 — 사람이 그
 * 터미널에 타이핑해 개입하는 것은 권한 프리셋과 턴 종류의 상호작용이 스펙 §6 결정을
 * 건드리므로 별도 후속이다. 그래서 이 패널은 `TurnMode` 도 `mentionPermission` 도
 * 읽지 않는다(그것을 바꿀 표면이 없다는 뜻이다).
 */
export function TerminalPanel() {
  const agentId = useAppStore((s) => s.terminalAgentId);
  const agent = useAppStore((s) => (s.terminalAgentId ? s.accounts[s.terminalAgentId] : undefined));
  const set = useAppStore((s) => s.set);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /**
   * 세 가지를 갈라 말한다(docs/design.md §4). 'loading' 은 "아직 모른다"이고,
   * 'no-session' 은 "물어봤고 진행 중인 턴이 없다"이며, 'error' 는 "못 물어봤다"다.
   * 하나로 뭉치면 러너가 죽은 것과 한가한 것이 같은 화면이 된다.
   */
  const [phase, setPhase] = useState<'loading' | 'no-session' | 'attached' | 'error'>('loading');
  const [state, setState] = useState<AgentSessionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let disposed = false;
    let attach: AttachHandle | null = null;
    let sink: TerminalSink | null = null;

    void (async () => {
      const api = getController().api;
      try {
        const sessions = await api.agentSessions();
        const session = sessions.find((s) => s.agentAccountId === agentId);
        if (disposed) return;
        if (!session) { setPhase('no-session'); return; }

        const { ticket } = await api.attachAgentSession(session.sessionId);
        // 티켓을 받은 사이에 패널이 닫혔을 수 있다. 여기서 안 막으면 닫은 뒤에 소켓이
        // 열리고, 그 소켓은 아무도 닫지 않는다(`ws.ts` 의 같은 가드와 같은 이유다).
        if (disposed) return;

        const host = hostRef.current;
        if (!host) { setPhase('error'); setError('터미널을 붙일 자리가 없다'); return; }
        sink = getTerminalSinkFactory()(host);
        setPhase('attached');
        attach = connectAgentAttach(api.baseUrl, ticket, {
          onOutput: (bytes) => sink?.write(bytes),
          onStatus: setState,
          // 재접속하지 않는다(agentTerminal.ts 머리 주석) — 끊긴 사실만 그린다.
          onClosed: () => setState('runner-offline'),
        });
      } catch (err) {
        if (disposed) return;
        setPhase('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      // 패널을 닫으면 **구독을 끊는다.** 소켓을 열어 둔 채 두면 PTY 바이트가 계속
      // 흘러들고, 그것은 사람이 보지 않는 화면으로 비밀이 계속 오간다는 뜻이다.
      disposed = true;
      attach?.close();
      sink?.dispose();
    };
  }, [agentId]);

  if (!agentId) return null;

  return (
    <aside
      className="flex w-[38rem] shrink-0 flex-col border-l border-border bg-surface-sunken"
      aria-label="에이전트 터미널"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-fg-muted">
        <span className="font-semibold">터미널</span>
        <span className="text-fg-subtle">@{agent?.handle ?? agentId}</span>
        {state && <span className="rounded bg-surface-raised px-1.5 py-0.5">{STATE_LABEL[state]}</span>}
        <button
          onClick={() => set({ terminalAgentId: null })}
          className="ml-auto rounded px-2 py-0.5 text-fg-muted hover:bg-surface-raised"
          aria-label="터미널 닫기"
        >
          닫기
        </button>
      </div>
      {phase === 'loading' && <p className="px-3 py-2 text-xs text-fg-subtle">세션을 확인하는 중…</p>}
      {phase === 'no-session' && (
        <p className="px-3 py-2 text-xs text-fg-subtle">
          진행 중인 턴이 없다 — 이 에이전트를 부르면 그 턴에 붙을 수 있다.
        </p>
      )}
      {phase === 'error' && (
        <p className="px-3 py-2 text-xs text-warning">터미널을 열지 못했다: {error}</p>
      )}
      {/* 이 자리는 항상 렌더한다 — 조건부로 만들면 세션을 찾은 순간 ref 가 아직 null 이라
          xterm 을 붙일 곳이 없다. */}
      <div ref={hostRef} data-testid="terminal-host" className="min-h-0 flex-1 overflow-hidden" />
    </aside>
  );
}

/** 상태 문구. 'runner-offline' 을 '끝났다'로 쓰지 않는다 — 다른 사실이다. */
const STATE_LABEL: Record<AgentSessionState, string> = {
  running: '진행 중',
  ended: '턴 종료',
  'runner-offline': '러너 연결 끊김',
};
