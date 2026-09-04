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
 * **쓰기 차례는 서버가 `writer` 프레임으로 알린다**(스펙 §5-2 결정 2 — 마지막 attach 가
 * writer). 이 패널은 그 통지를 그대로 들고만 있는다: writer 가 아니면 입력을 보내지 않고
 * 그 사실을 글로 적는다 — 눌러도 아무 일이 없는 입력창이 최악이다. 프레임이 한 번도
 * 안 오는 구 서버에서는 자연스럽게 읽기 전용으로 남는다.
 */
export function TerminalPanel() {
  const target = useActiveStore((s) => s.terminalTarget);
  const agent = useActiveStore((s) => (s.terminalTarget ? s.accounts[s.terminalTarget.agentAccountId] : undefined));
  const channel = useActiveStore((s) =>
    (s.terminalTarget ? s.channels.find((c) => c.id === s.terminalTarget!.channelId) : undefined));
  /**
   * 스레드 루트 메시지 — 헤더의 스레드 표기에 쓴다(#339). 스토어에 **이미 있으면** 본문
   * 한 줄을 보여 주고, 없으면(스크롤 밖·다른 채널) 스레드라는 사실만 적는다. 이 표기
   * 하나 때문에 메시지를 새로 받아오지는 않는다 — 헤더는 방향 표지판이지 본문이 아니다.
   */
  const threadRoot = useActiveStore((s) => {
    const t = s.terminalTarget;
    if (!t) return undefined;
    return s.messages[t.channelId]?.find((m) => m.id === t.threadRootId);
  });
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
   * 지금 이 창이 **writer 인가**(스펙 §5-2 결정 2). 서버가 `writer` 프레임으로 알려 준
   * 값을 그대로 들고 있는다 — 화면이 차례 판정을 다시 하지 않는다. `null` 은 "아직 통지가
   * 없다"이고(구 서버에서는 영원히 null = 읽기 전용), `false` 는 "다른 창이 차례다"다.
   */
  const [writer, setWriter] = useState<boolean | null>(null);
  /**
   * `onInput` 콜백이 읽는 최신 writer 값. state 만 쓰면 sink 생성 시점의 클로저에 옛
   * 값이 얼어붙어, 승격·강등이 입력 가드에 반영되지 않는다.
   */
  const writerRef = useRef(false);

  useEffect(() => {
    if (!target) return;
    let disposed = false;
    let attach: AttachHandle | null = null;
    let sink: TerminalSink | null = null;

    void (async () => {
      const api = getController().api;
      try {
        const sessions = await api.agentSessions();
        // 세 필드 **전부** 일치해야 한다(#339). 에이전트만 보면 같은 에이전트가 스레드
        // 여럿에서 돌 때 임의의 첫 세션에 붙는다 — A 스레드에서 눌렀는데 B 스레드의
        // PTY 가 열리는 결함이 이것이었다. 세션의 threadRootId 가 null 이면 러너가 어느
        // 스레드의 것인지 말하지 않은 것이므로 붙지 않는다 — target.threadRootId 는
        // 항상 문자열이라(#98 앵커식) 엄격 비교가 그 거절을 그대로 담는다.
        const session = sessions.find((s) =>
          s.agentAccountId === target.agentAccountId
          && s.channelId === target.channelId
          && s.threadRootId === target.threadRootId);
        if (disposed) return;
        if (!session) { setPhase('no-session'); return; }

        const { ticket } = await api.attachAgentSession(session.sessionId);
        // 티켓을 받은 사이에 패널이 닫혔을 수 있다. 여기서 안 막으면 닫은 뒤에 소켓이
        // 열리고, 그 소켓은 아무도 닫지 않는다(`ws.ts` 의 같은 가드와 같은 이유다).
        if (disposed) return;

        const host = hostRef.current;
        if (!host) { setPhase('error'); setError('터미널을 붙일 자리가 없다'); return; }
        // 입력은 항상 배선하되 **writer 일 때만 흘린다.** 차례는 attach 뒤에도 오간다
        // (다른 창이 붙으면 강등, 그 창이 닫히면 승계) — sink 를 그때마다 다시 만들면
        // 화면이 통째로 리셋되므로, 배선은 한 번 하고 가드가 최신 차례(writerRef)를 읽는다.
        // writer 가 아닐 때 친 것은 여기서 버려진다: xterm 은 로컬 에코가 없어 글자도
        // 찍히지 않고, 왜 안 찍히는지는 패널이 배지로 적는다.
        sink = getTerminalSinkFactory()(host, {
          onInput: (data) => {
            if (!writerRef.current) return;
            attach?.sendInput(new TextEncoder().encode(data));
          },
        });
        setPhase('attached');
        attach = connectAgentAttach(api.baseUrl, ticket, {
          onOutput: (bytes) => sink?.write(bytes),
          onStatus: setState,
          onWriter: (w) => { writerRef.current = w; setWriter(w); },
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
    // 객체가 아니라 필드 셋을 의존성으로 둔다 — 칩을 누를 때마다 target 은 새 객체인데,
    // 같은 대상을 다시 눌렀다는 이유로 attach 를 끊고 다시 여는 것은 낭비이자 화면 깜빡임이다.
  }, [target?.agentAccountId, target?.channelId, target?.threadRootId]);

  if (!target) return null;

  return (
    <aside
      className="flex w-[38rem] shrink-0 flex-col border-l border-border bg-surface-sunken"
      aria-label="에이전트 터미널"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-fg-muted">
        <span className="font-semibold">터미널</span>
        <span className="text-fg-subtle">@{agent?.handle ?? target.agentAccountId}</span>
        {/* 어느 채널·스레드의 터미널인지 항상 적는다(#339). 같은 에이전트의 세션이 여럿일
            수 있는데 이 표기가 없으면 사람은 지금 보는 화면이 어느 스레드의 것인지 알 길이
            없다 — 스코프를 고치고도 화면이 침묵하면 결함이 반쯤 남는 셈이다. */}
        <span className="min-w-0 truncate text-fg-subtle" data-testid="terminal-scope">
          {channel?.name ? `#${channel.name}` : 'DM'}
          {' · '}
          {threadRoot ? threadExcerpt(threadRoot.body) : '스레드'}
        </span>
        {state && <span className="rounded bg-surface-raised px-1.5 py-0.5">{STATE_LABEL[state]}</span>}
        <button
          onClick={() => set({ terminalTarget: null })}
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
      {/* **차례를 항상 적는다.** writer 통지가 온 뒤에만 그린다(null 이면 아직 모르거나
          구 서버다 — 그때 "다른 창이 입력 중"이라 적으면 없는 사람을 만들어 낸다).
          강등(false)만 적고 승격을 침묵하면, 두 창을 쓰는 사람이 어느 쪽이 살아 있는지
          화면에서 알 수 없다. */}
      {phase === 'attached' && writer === true && (
        <p className="px-3 py-2 text-xs text-fg-subtle" role="note" data-testid="writer-note">
          입력 가능 — 마지막으로 연 창이 입력을 가진다.
        </p>
      )}
      {phase === 'attached' && writer === false && (
        <p className="px-3 py-2 text-xs text-fg-subtle" role="note" data-testid="writer-note">
          읽기 전용 — 다른 창이 입력 중이다. 이 창에 치면 아무 데도 가지 않는다.
        </p>
      )}
      {/* 이 자리는 항상 렌더한다 — 조건부로 만들면 세션을 찾은 순간 ref 가 아직 null 이라
          xterm 을 붙일 곳이 없다. */}
      <div ref={hostRef} data-testid="terminal-host" className="min-h-0 flex-1 overflow-hidden" />
    </aside>
  );
}

/**
 * 헤더에 넣을 스레드 루트 본문 한 줄(#339). 줄바꿈을 접고 앞머리만 남긴다 —
 * 헤더는 방향 표지판이라, 긴 본문이 그대로 오면 상태 배지와 닫기 버튼을 밀어낸다.
 */
function threadExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
}

/** 상태 문구. 'runner-offline' 을 '끝났다'로 쓰지 않는다 — 다른 사실이다. */
const STATE_LABEL: Record<AgentSessionState, string> = {
  running: '진행 중',
  ended: '턴 종료',
  'runner-offline': '러너 연결 끊김',
};
