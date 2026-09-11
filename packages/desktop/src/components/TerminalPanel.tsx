import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentSessionState, WriterDeniedReason } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { connectAgentAttach, type AttachHandle } from '../lib/agentTerminal';
import { getTerminalSinkFactory, type TerminalSink } from '../lib/terminalSink';
import { PaneResizer } from './PaneResizer';
import { paneStorage, paneMaxWidth, MIN_TERMINAL_WIDTH, MAX_TERMINAL_WIDTH, MIN_CHANNEL_WIDTH, MIN_THREAD_WIDTH } from '../lib/prefs';
import { useT } from '../i18n/useT';
import type { MessageKey, Translate } from '../i18n';

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
 *
 * **관찰 전용 배지는 남는다.** 그 사유(`'observe-only'`)는 codex 가 아직 `exec` + stdin
 * 파일로 돌아 그 세션에 사람이 칠 수 없다는 사실이다 — P5 가 끝나면 그때 지운다. claude
 * 멘션 턴은 TUI 라 사람이 그대로 칠 수 있고, 그래서 이어받기라는 우회로가 없어졌다
 * (2026-09-08 철거).
 *
 * 이 패널이 `TurnMode` 를 읽지 않는다는 위 문장은 **여전히 참이다**: 입력이 열리는 근거는
 * 서버의 `writer` 프레임 하나다(#369 의 판정) — 화면은 그것을 다시 재지 않는다.
 *
 * **문이 하나 줄었다**(2026-09-09). 진행 중인 세션이 없을 때 이 패널은 「진행 중인 턴이
 * 없다」를 적고 [터미널 열기] 를 한 번 더 눌리게 했다. 그 버튼은 *묻는* 문이었고, 물어야
 * 했던 이유는 인터랙티브가 예외였기 때문이다 — 멘션 턴이 TUI 로 돌게 된 뒤로 그 전제가
 * 없어졌다. 그래서 조회에서 세션을 못 찾으면 같은 자리에서 바로 인터랙티브 턴을 연다.
 * 러너 쪽이 이미 멱등해서(`interactiveTurn.ts` 의 3분기) 자동으로 타도 PTY 가 늘지 않고,
 * 두 경로가 같은 attach 흐름으로 수렴하므로 사람에게는 턴이 돌고 있었는지가 화면 차이로
 * 보이지 않는다. [터미널 열기] 는 **실패 화면에만** 남는다(러너를 올린 뒤 다시 누를 자리).
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
  /**
   * 스레드 패널이 **함께 떠 있는가**(`Workspace` 가 `threadRootId` 로 판정해 그린다).
   * `terminalTarget.threadRootId` 와 다른 물음이다 — 그것은 "이 터미널이 어느 스레드의
   * 것인가"이고, 패널이 닫힌 채로도 값이 남는다.
   */
  const threadOpen = useActiveStore((s) => s.threadRootId !== null);
  const set = useActiveStore((s) => s.set);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /**
   * 네 가지를 갈라 말한다(docs/design.md §4). 'loading' 은 "진행 중인 세션이 있는지 아직
   * 모른다"이고, 'opening' 은 "없어서 지금 띄우는 중"이며, 'error' 는 "못 물어봤다"다.
   * 하나로 뭉치면 러너가 죽은 것과 한가한 것이 같은 화면이 된다.
   *
   * **'no-session' 은 없어졌다**(2026-09-09). 진행 중인 턴이 없다는 사실이 화면의 종점이
   * 아니게 됐기 때문이다 — 아래 조회 경로가 그 자리에서 바로 인터랙티브 턴을 연다.
   */
  const [phase, setPhase] = useState<'loading' | 'opening' | 'attached' | 'error'>('loading');
  const [state, setState] = useState<AgentSessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 지금 이 창이 **writer 인가**(스펙 §5-2 결정 2). 서버가 `writer` 프레임으로 알려 준
   * 값을 그대로 들고 있는다 — 화면이 차례 판정을 다시 하지 않는다. `null` 은 "아직 통지가
   * 없다"이고(구 서버에서는 영원히 null = 읽기 전용), `false` 는 "다른 창이 차례다"다.
   */
  const [writer, setWriter] = useState<boolean | null>(null);
  /**
   * **왜** 못 치는가(#369). 서버가 준 이유를 그대로 들고 있는다 — 화면이 지어내지 않는다.
   * 진행 중인 멘션 턴은 프롬프트를 파일로 받아 PTY 입력이 자식에게 닿지 않으므로,
   * "다른 창이 입력 중"과 같은 문장으로 뭉치면 없는 사람을 만들어 낸다.
   */
  const [writerReason, setWriterReason] = useState<WriterDeniedReason | null>(null);
  /**
   * `onInput` 콜백이 읽는 최신 writer 값. state 만 쓰면 sink 생성 시점의 클로저에 옛
   * 값이 얼어붙어, 승격·강등이 입력 가드에 반영되지 않는다.
   */
  const writerRef = useRef(false);
  /**
   * 최신 **폭 주인** 여부(#369). `writerRef` 와 갈라 둔다: 관찰 전용 세션은 못 치지만
   * 폭은 정한다 — 여기서 둘을 한 값으로 뭉치면 진행 중인 멘션 턴을 보는 창이 러너의
   * spawn 기본값(120x40)에 영원히 갇혀 화면이 접힌 채로 남는다(#335 회귀).
   */
  const resizeRef = useRef(false);
  /**
   * 인터랙티브 열기(#337)의 손잡이. effect 안의 attach 경로를 **조회 경로와 실패 뒤의
   * 다시 열기가 함께** 재사용해야 해서(인터랙티브 open 도 결국 티켓 하나로 수렴한다 —
   * 서버가 그렇게 설계됐다) effect 가 자기 클로저를 여기 걸어 둔다. 열기 경로를 밖에
   * 따로 만들면 소켓·sink 정리가 두 벌이 된다.
   */
  const openRef = useRef<(() => void) | null>(null);

  /** 패널 폭. 스레드 패널과 같은 규약이다 — 바꿀 때마다 기기 로컬에 적는다. */
  const [terminalWidth, setWidth] = useState(() => paneStorage.loadTerminalWidth());
  const setTerminalWidth = useCallback((next: number) => {
    setWidth(next);
    paneStorage.saveTerminalWidth(next);
  }, []);
  // 훅은 아래 `if (!target) return null` 보다 먼저여야 한다.
  const t = useT();

  useEffect(() => {
    if (!target) return;
    let disposed = false;
    let attach: AttachHandle | null = null;
    let sink: TerminalSink | null = null;
    const api = getController().api;

    /**
     * xterm 배선 → attach 소켓. attach 와 [터미널 열기]가 이 하나로 수렴한다 —
     * 갈라 두면 소켓·sink 정리가 여러 벌이 되고, 한 벌만 고치는 사고가 난다.
     */
    const attachTo = (ticket: string): void => {
      // **다시** 붙을 수 있다([터미널 열기]가 같은 자리에서 새 세션을 연다) — 앞의 소켓과
      // 화면을 먼저 놓는다. 남겨 두면 끝난 세션의 바이트가 계속 흘러들고, sink 가 둘이면
      // 같은 host 에 xterm 이 두 번 붙어 화면이 겹친다.
      attach?.close();
      attach = null;
      sink?.dispose();
      sink = null;
      const host = hostRef.current;
      if (!host) { setPhase('error'); setError(t('terminal.session.noHost')); return; }
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
        // 크기는 **입력과 다른 가드를 탄다**(#369). `#335`+`#346` 은 둘을 한 가드에 묶었고
        // 그 근거는 "읽기 전용 창의 크기가 흘러가면 그 창은 더 이상 읽기 전용이 아니다"
        // 였다 — 그 문장은 *다른 창이 치고 있을 때* 참이다. 관찰 전용 세션(#369)에는 칠
        // 사람이 아예 없어 침범할 작업 환경이 없고, 폭은 stdin 과 무관하게 ioctl 로 자식에
        // 그대로 닿는다. 그래서 여기만 `resizeRef` 를 읽는다.
        onResize: (cols, rows) => {
          if (!resizeRef.current) return;
          attach?.sendResize(cols, rows);
        },
      });
      // **차례를 받기 전에는 접어 둔다**(#369). sink 는 `onInput` 이 배선돼 있어 xterm 의
      // stdin 이 켜진 채로 뜨는데, 서버의 첫 `writer` 프레임은 소켓이 붙은 **뒤에** 온다 —
      // 그 사이 커서가 깜빡여 "칠 수 있다"고 말한다. 이 결함이 정확히 그 거짓말이다.
      // 프레임이 영영 안 와도(구 서버) 읽기 전용으로 남는 규칙과도 같은 방향이다.
      sink.setReadOnly?.(true);
      setPhase('attached');
      attach = connectAgentAttach(api.baseUrl, ticket, {
        onOutput: (bytes) => sink?.write(bytes),
        onStatus: (next) => {
          setState(next);
          // 갈아탄다. 러너는 이미 예약대로 그 턴을 띄웠거나 띄우는 중이고, 이 요청이
          // 그 세션의 티켓을 받아 온다. **끝났다는 사실은 이미 오는 프레임이 알려 준다** —
          // 폴링을 새로 만들지 않는다.
        },
        onWriter: (turn) => {
          writerRef.current = turn.writer;
          resizeRef.current = turn.resize;
          setWriter(turn.writer);
          setWriterReason(turn.reason);
          // 화면도 함께 접는다(#369): 가드가 바이트를 버리는 것만으로는 커서가 계속
          // 깜빡여 "칠 수 있다"로 보인다. xterm 의 stdin 자체를 끄면 화면이 스스로
          // 읽기 전용임을 말하고, **왜**는 아래 배지가 글로 적는다.
          sink?.setReadOnly?.(!turn.writer);
          // 폭 주인이 된 직후 자기 크기를 한 번 보고한다(스펙 §5 "attach 시 writer 의
          // 크기로 resize"). 그 전의 fit 은 위 가드가 버렸으므로, 여기서 다시 재지 않으면
          // PTY 가 이전 주인(또는 spawn 기본값)의 크기로 남는다. **`writer` 가 아니라
          // `resize` 를 본다**(#369) — 관찰 전용 창도 폭의 주인이다.
          if (turn.resize) sink?.refit?.();
        },
        // 재접속하지 않는다(agentTerminal.ts 머리 주석) — 끊긴 사실만 그린다.
        onClosed: () => setState('runner-offline'),
      });
    };

    /** 티켓 획득 → 배선. 실패는 서버가 쓴 문구를 그대로 올린다. */
    const begin = async (issueTicket: () => Promise<{ ticket: string }>): Promise<void> => {
      try {
        const { ticket } = await issueTicket();
        // 티켓을 받은 사이에 패널이 닫혔을 수 있다. 여기서 안 막으면 닫은 뒤에 소켓이
        // 열리고, 그 소켓은 아무도 닫지 않는다(`ws.ts` 의 같은 가드와 같은 이유다).
        if (disposed) return;
        attachTo(ticket);
      } catch (err) {
        if (disposed) return;
        // 러너 오프라인(404)·구버전(409)·codex 거절(409)·타임아웃(504)의 서버 문구가
        // 그대로 온다(api.ts) — 화면이 다시 쓰지 않는다: 서버가 원인을 정확히 안다.
        setPhase('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    // 인터랙티브 열기(#337) — 진행 중인 턴이 없어도 러너가 세션을 확보해 인터랙티브 PTY 를
    // 띄우고, 그 티켓으로 위와 같은 attach 흐름에 합류한다.
    //
    // **러너 쪽이 이미 멱등하다**(`interactiveTurn.ts` 3분기): 그 스레드에 멘션 턴이나
    // 인터랙티브 턴이 돌고 있으면 기존 세션을 그대로 돌려주고, 아무 턴도 없을 때만 새
    // PTY 를 띄운다. 그래서 이 경로를 조회 실패 직후에 자동으로 타도 PTY 가 둘로 늘지 않는다.
    const openInteractive = () => {
      setPhase('opening');
      void begin(() => api.openInteractiveSession(target.agentAccountId, target.channelId, target.threadRootId));
    };
    openRef.current = openInteractive;

    void (async () => {
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
        // **진행 중인 턴이 없으면 바로 연다**(2026-09-09). 예전에는 여기서 멈춰
        // "진행 중인 턴이 없다"를 적고 [터미널 열기] 버튼을 하나 더 눌리게 했다. 그
        // 버튼은 *묻는* 문이었는데, 멘션 턴이 TUI 로 돌게 된 뒤로는 물을 것이 없다 —
        // 「터미널 보기」를 누른 사람이 원하는 것은 예외 없이 그 터미널이다. 진행 중인
        // 세션에 붙는 위 경로와 여기가 **같은 attach 흐름**으로 수렴하므로, 사람에게는
        // 턴이 돌고 있었는지 여부가 화면 차이로 보이지 않는다(그것이 이 변경의 요점이다).
        if (!session) { openInteractive(); return; }
        await begin(() => api.attachAgentSession(session.sessionId));
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
      openRef.current = null;
      attach?.close();
      sink?.dispose();
    };
    // 객체가 아니라 필드 셋을 의존성으로 둔다 — 칩을 누를 때마다 target 은 새 객체인데,
    // 같은 대상을 다시 눌렀다는 이유로 attach 를 끊고 다시 여는 것은 낭비이자 화면 깜빡임이다.
  }, [target?.agentAccountId, target?.channelId, target?.threadRootId]);

  /**
   * 이 패널 **왼쪽에 반드시 남길 폭**. `PaneResizer` 에 넘기는 것과 같은 값이고, 아래
   * `maxWidth` 도 같은 값을 쓴다 — 끌 때만 지키고 창 크기에는 안 지키면 그 약속은 절반만
   * 참이다(그 절반이 이 결함이었다).
   */
  const roomLeftReserve = MIN_CHANNEL_WIDTH + (threadOpen ? MIN_THREAD_WIDTH : 0);

  if (!target) return null;

  return (
    <aside
      /* `shrink-0` 은 남긴다: 터미널은 줄어들면 줄이 접히거나 잘려서 읽던 출력이 망가진다
         — 스레드처럼 창 사정에 맞춰 양보할 대상이 아니다. 폭은 사람이 고른 값 그대로다.
         xterm 은 `terminalSink` 의 `ResizeObserver` 가 스스로 다시 맞추고 새 크기를
         PTY 에 알리므로, 여기서 refit 을 따로 부르지 않는다. */
      className="relative flex shrink-0 flex-col border-l border-border bg-surface-sunken"
      style={{ width: terminalWidth, maxWidth: paneMaxWidth(MIN_TERMINAL_WIDTH, roomLeftReserve) }}
      aria-label={t('terminal.header.panel')}
    >
      <PaneResizer
        label={t('terminal.header.resize')}
        width={terminalWidth}
        min={MIN_TERMINAL_WIDTH}
        max={MAX_TERMINAL_WIDTH}
        /* 이 구분선 왼쪽에는 대화**와 스레드**가 있다. 스레드는 `min-width` 아래로는
           줄지 않으므로 그 몫까지 남겨야 한다 — 대화 몫만 남기면 요구한 폭이 실제로
           안 나오고, 줄이 넘쳐 `overflow-hidden` 에 조용히 잘린다. */
        minRoomLeft={roomLeftReserve}
        onWidth={setTerminalWidth}
      />
      {/* 머리띠는 **아랫단 11px** — 여기 있는 것은 전부 꼬리표다(에이전트 핸들·어느 스레드·
          상태 칩·닫기). 아래 문구들은 반대로 본문단이다: 세션이 없거나 실패했을 때 사람이
          다음에 무엇을 할 수 있는지가 그 문장에만 적혀 있다. */}
      {/* **줄이 넘치면 잘린다**(`min-w-0` + `overflow-hidden`). 이 줄에는 길이를 우리가
          모르는 것이 둘 있다 — 에이전트 핸들과 스레드 표기다. 넘치는 것을 그냥 두면 flex
          가 줄을 늘려 오른쪽 끝의 닫기가 패널 밖으로 밀려나고, 부모가 잘라 내므로 **닫을
          손잡이가 화면에서 사라진다.** 좁은 창에서 실제로 그렇게 됐다. */}
      <div className="flex min-w-0 items-center gap-2 overflow-hidden border-b border-border px-3 py-2 text-meta text-fg-muted">
        <span className="shrink-0 font-semibold">{t('terminal.header.title')}</span>
        <span className="min-w-0 truncate text-fg-subtle">@{agent?.handle ?? target.agentAccountId}</span>
        {/* 어느 채널·스레드의 터미널인지 항상 적는다(#339). 같은 에이전트의 세션이 여럿일
            수 있는데 이 표기가 없으면 사람은 지금 보는 화면이 어느 스레드의 것인지 알 길이
            없다 — 스코프를 고치고도 화면이 침묵하면 결함이 반쯤 남는 셈이다. */}
        <span className="min-w-0 truncate text-fg-subtle" data-testid="terminal-scope">
          {channel?.name ? `#${channel.name}` : 'DM'}
          {' · '}
          {threadRoot ? threadExcerpt(threadRoot.body) : t('terminal.header.thread')}
        </span>
        {state && <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5">{t(STATE_LABEL[state])}</span>}
        {/* **닫기는 줄지 않는다**(`shrink-0`). 이 줄에서 마지막까지 남아야 하는 것은 이
            버튼 하나다 — 꼬리표(핸들·스코프)는 줄어들거나 말줄임표가 되면 그만이지만,
            이것이 사라지면 패널을 닫을 길이 없어진다. */}
        <button
          onClick={() => set({ terminalTarget: null })}
          className="ml-auto shrink-0 rounded px-2 py-0.5 text-fg-muted hover:bg-surface-raised"
          aria-label={t('terminal.header.closeAction')}
        >
          {t('terminal.header.close')}
        </button>
      </div>
      {phase === 'loading' && <p className="px-3 py-2 text-fg-subtle">{t('terminal.session.checking')}</p>}
      {/* 조회와 열기를 **갈라 적는다.** 둘 다 "기다려라"이지만 기다리는 대상이 다르다 —
          앞은 서버의 세션 목록이고 뒤는 러너가 띄우는 PTY 다(뒤가 몇 초 더 걸린다).
          한 문구로 뭉치면 러너가 늦을 때 "확인 중"이 몇 초 멈춰 있는 화면이 된다. */}
      {phase === 'opening' && <p className="px-3 py-2 text-fg-subtle">{t('terminal.session.opening')}</p>}
      {phase === 'error' && (
        <div className="px-3 py-2">
          <p className="text-warning">{t('terminal.session.openFailed', { reason: error ?? '' })}</p>
          {/* **실패에만 남는 버튼이다.** 자동 열기가 지운 것은 "턴이 없다"는 막다른 길
              하나이고, 실패는 다르다 — 러너를 올린 뒤 다시 누를 자리가 없으면 사람은
              패널을 닫고 다시 여는 우회로를 알아내야 한다. */}
          <button
            onClick={() => openRef.current?.()}
            className="mt-2 rounded bg-surface-raised px-2 py-1 text-fg hover:bg-surface-hover"
          >
            {t('terminal.session.open')}
          </button>
        </div>
      )}
      {/* **차례를 항상 적는다.** writer 통지가 온 뒤에만 그린다(null 이면 아직 모르거나
          구 서버다 — 그때 "다른 창이 입력 중"이라 적으면 없는 사람을 만들어 낸다).
          강등(false)만 적고 승격을 침묵하면, 두 창을 쓰는 사람이 어느 쪽이 살아 있는지
          화면에서 알 수 없다. */}
      {phase === 'attached' && writer === true && (
        <p className="px-3 py-2 text-fg-subtle" role="note" data-testid="writer-note">
          {t('terminal.writer.can')}
        </p>
      )}
      {phase === 'attached' && writer === false && (
        <div className="px-3 py-2 text-fg-subtle">
          <p role="note" data-testid="writer-note" data-writer-reason={writerReason ?? 'unknown'}>
            {writerDeniedText(writerReason, t)}
          </p>
        </div>
      )}
      {/* 이 자리는 항상 렌더한다 — 조건부로 만들면 세션을 찾은 순간 ref 가 아직 null 이라
          xterm 을 붙일 곳이 없다. */}
      <div ref={hostRef} data-testid="terminal-host" className="min-h-0 flex-1 overflow-hidden" />
    </aside>
  );
}

/**
 * 읽기 전용의 **이유**를 사람 문장으로(#369).
 *
 * **원인마다 다음 행동이 다르다** — 그래서 한 문장으로 뭉치지 않는다. 다른 창이 가져간
 * 것이면 그 창을 닫으면 되고, 진행 중인 멘션 턴이면 기다리거나 따로 터미널을 열어야
 * 하며, 구 러너면 러너를 올려야 한다. "읽기 전용이다"만 적으면 셋 다 막다른 길로 보인다.
 *
 * 멘션 턴 문구가 **원인을 그대로 말하는** 이유: "관찰 전용"만 적으면 임의의 제약으로
 * 읽혀 "왜 안 되냐"가 결함으로 다시 올라온다. 프롬프트를 파일로 받는다는 사실이 이
 * 제약의 전부이고, 그 사실을 아는 사람은 다른 길(터미널 열기)을 스스로 찾는다.
 *
 * ## `if` 사슬을 **표로 바꿨다** (`Sidebar::NOTIFY_LEVEL_KEY` 판례)
 *
 * 사전을 지나면서 넷이 전부 자리표시자 없는 상수 문구가 되어 표가 성립했고, 표가
 * 사슬보다 낫다: **서버가 다섯 번째 사유를 만들면 여기서 컴파일이 막힌다.** `if` 사슬은
 * 그것을 조용히 마지막 `return`(= "모른다")으로 흘려보내고, 그러면 이 함수가 지키려던
 * *"원인마다 다음 행동이 다르다"* 가 그 사유 하나에 대해 거짓이 된다.
 *
 * `null` 은 표 밖에 남는다 — 구 서버가 이유를 **안 실은 것**이지 `WriterDeniedReason` 의
 * 값이 아니다. 그 둘을 표 안에서 합치면 "서버가 모른다고 했다"와 "서버가 말을 안 했다"가
 * 같은 칸이 된다.
 */
const WRITER_DENIED_KEY: Record<WriterDeniedReason, MessageKey> = {
  'observe-only': 'terminal.writer.observeOnly',
  'other-writer': 'terminal.writer.otherWriter',
  'runner-outdated': 'terminal.writer.runnerOutdated',
};

// **회귀선이 부를 수 있게 내보낸다.** 사전만 읽는 축은 이 표가 잘못 배선돼도(두 사유가
// 같은 키를 가리켜도) 초록으로 남는다 — 실제로 RED 프로브에서 그것을 확인했다.
// 지키려는 것은 사전에 문장 넷이 있다가 아니라 **네 사유가 서로 다른 말에 닿는다**이다.
export function writerDeniedText(reason: WriterDeniedReason | null, t: Translate): string {
  // 구 서버는 이유를 안 싣는다 — 그때 원인을 지어내지 않고 "모른다"를 그대로 적는다.
  return t(reason === null ? 'terminal.writer.unknown' : WRITER_DENIED_KEY[reason]);
}

/**
 * 헤더에 넣을 스레드 루트 본문 한 줄(#339). 줄바꿈을 접고 앞머리만 남긴다 —
 * 헤더는 방향 표지판이라, 긴 본문이 그대로 오면 상태 배지와 닫기 버튼을 밀어낸다.
 */
function threadExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
}

/**
 * 상태 문구. 'runner-offline' 을 '끝났다'로 쓰지 않는다 — 다른 사실이다.
 *
 * **값이 아니라 키를 든다**(위 `WRITER_DENIED_KEY` 와 같은 판례). 문구를 들면 모듈
 * 로드 시점 언어로 굳어 `t()` 를 지나도 안 바뀐다 — 키는 언어를 안 지니므로 상수여도
 * 안전하다. `AgentSessionState` 로 색인된 채로 두는 이유는 **네 번째 상태가 생기면
 * 여기서 컴파일이 막히기** 때문이다.
 */
const STATE_LABEL: Record<AgentSessionState, MessageKey> = {
  running: 'terminal.state.running',
  ended: 'terminal.state.ended',
  'runner-offline': 'terminal.state.runnerOffline',
};
