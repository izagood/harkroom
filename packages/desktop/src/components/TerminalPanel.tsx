import { useEffect, useRef, useState } from 'react';
import type { AgentSessionState } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
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
 * **입력은 #315 에서 열렸다.** 위 문단은 Phase 2 당시 "입력창이 없는 것은 범위다"였고,
 * 그 범위가 닫혔으므로 여기 적어 둔다: 소유자는 이 패널의 터미널에 직접 타이핑해 개입한다.
 * 멘션 턴이어도 마찬가지다 — `mention_permission` 은 에이전트가 스스로 넘지 못하는
 * 선이지 사람이 넘지 못하는 선이 아니다(운영자 결정).
 *
 * **그래도 이 패널은 `TurnMode` 도 `mentionPermission` 도 읽지 않는다.** 그 문장은 여전히
 * 참이어야 한다: 입력을 여는 것은 턴 모드를 바꾸는 것이 아니고, 바뀌는 것은 그 PTY 에
 * 바이트를 넣을 수 있는 주체뿐이다. 이 패널이 그 값을 읽기 시작하면 그때부터 화면이
 * 모드에 관여할 길이 생긴다.
 *
 * **쓰기는 소유자만이다.** admin 은 보이되 칠 수 없고, 화면은 그 사실을 글로 적는다 —
 * 눌러도 아무 일이 없는 입력창이 최악이다.
 */
export function TerminalPanel() {
  const agentId = useActiveStore((s) => s.terminalAgentId);
  const agent = useActiveStore((s) => (s.terminalAgentId ? s.accounts[s.terminalAgentId] : undefined));
  const set = useActiveStore((s) => s.set);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /**
   * 세 가지를 갈라 말한다(docs/design.md §4). 'loading' 은 "아직 모른다"이고,
   * 'no-session' 은 "물어봤고 진행 중인 턴이 없다"이며, 'error' 는 "못 물어봤다"다.
   * 하나로 뭉치면 러너가 죽은 것과 한가한 것이 같은 화면이 된다.
   */
  const [phase, setPhase] = useState<'loading' | 'no-session' | 'attached' | 'error'>('loading');
  const [state, setState] = useState<AgentSessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 이 터미널에 **쓸 수 있는가**(#315). 서버가 attach 인가 때 정해 준 값을 그대로 들고
   * 있는다 — 화면이 소유자 판정을 다시 하지 않는다(`api.ts::attachAgentSession` 주석).
   * `null` 은 "아직 모른다"이고, `false` 는 "물어봤고 읽기 전용이다"다.
   */
  const [canInput, setCanInput] = useState<boolean | null>(null);

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

        const { ticket, canInput: writable } = await api.attachAgentSession(session.sessionId);
        // 티켓을 받은 사이에 패널이 닫혔을 수 있다. 여기서 안 막으면 닫은 뒤에 소켓이
        // 열리고, 그 소켓은 아무도 닫지 않는다(`ws.ts` 의 같은 가드와 같은 이유다).
        if (disposed) return;

        const host = hostRef.current;
        if (!host) { setPhase('error'); setError('터미널을 붙일 자리가 없다'); return; }
        setCanInput(writable);
        // 쓸 수 없으면 `onInput` 을 **넘기지 않는다** — sink 가 xterm 의 stdin 자체를 끈다
        // (terminalSink.ts). 받아 놓고 버리면 사람은 글자가 찍히는 것을 보고 쳤다고 믿는데
        // 러너에는 아무것도 닿지 않는다.
        //
        // **크기도 같은 판정을 탄다**(#335). 소유자의 폭이 PTY 폭이 되고, admin 은 그
        // 폭을 받아 자기 패널에서 축소·스크롤해 본다 — 읽기 전용은 아무것도 바꾸지
        // 않는다는 #315 의 결정과 같은 결이다. admin 이 좁은 창에서 접힌 줄을 보는 것은
        // 받아들이기로 한 비용이지, 폭 협상으로 고칠 것이 아니다.
        sink = getTerminalSinkFactory()(host, writable
          ? {
              onInput: (data) => attach?.sendInput(new TextEncoder().encode(data)),
              onResize: (cols, rows) => attach?.sendResize(cols, rows),
            }
          : undefined);
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
      {/* **왜 못 치는지를 적는다.** 비활성만 하고 이유를 안 적으면 사람은 고장으로 읽고,
          입력이 되는 줄 알고 계속 친다. `canInput === false` 일 때만 그린다 — 아직
          모르는 동안(null) 미리 적으면 소유자에게도 잠깐 스쳐 지나간다. */}
      {phase === 'attached' && canInput === false && (
        <p className="px-3 py-2 text-xs text-fg-subtle" role="note">
          읽기 전용 — 이 터미널에 칠 수 있는 사람은 이 에이전트의 소유자뿐이다.
        </p>
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
