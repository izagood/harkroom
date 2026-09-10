/**
 * **Agents 관제탑** — 도는 턴을 보고 멈추는 자리(본문).
 *
 * ## 왜 칸이 아니라 본문인가
 *
 * 개편의 컨셉은 세 열이었다: 레일 · 좁은 칸(요약) · **본문 관제탑**(상세와 위험한 동작).
 * 1단계가 그 셋째 열을 만들지 않고 목록 전체를 300px 칸에 접어 넣었고, 그때 폭이 필요한
 * 것이 전부 떨어졌다 — 스레드 이름 · 하네스 · 터미널로 가는 문. 사람이 지적한 어긋남이
 * 그것이고, 이 파일이 그 셋째 열이다.
 *
 * 자리를 `ChannelPane` **대신** 쓴다(`Workspace`). 관제탑은 대화가 아니라 *"지금 우리 팀이
 * 무슨 일을 하고 있고 무엇을 멈출 수 있나"* 에 답하는 화면이고, 그 물음을 보는 동안 채널을
 * 함께 보여 줄 이유가 없다. 스레드 패널·터미널 패널은 형제로 그대로 남으므로, 줄에서 문을
 * 열면 관제탑 **오른쪽**에 열린다 — 목록에서 방금 누른 줄이 밀려나지 않는다.
 *
 * ## 이 파일이 목록을 다시 그리지 않는 이유
 *
 * 목록과 중단은 `AgentTurns` 가 이미 갖고 있다(묶음은 스레드 · 조종 중인 턴은 다른 문 ·
 * `0` 과 `모름`은 다른 모양). 그것을 본문 폭으로 한 벌 더 쓰면 그 판단들이 두 곳에
 * 복사되고, 한쪽만 고쳐지는 것이 바로 이 개편이 고치려는 어긋남이다. 그래서 이 파일이
 * 하는 일은 **스토어와 서버를 목록에 물려 주는 것**뿐이다.
 */
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { AgentTurns } from './AgentTurns';
import { useAgentTurns, useThreadRoots, threadTitle } from '../lib/agentTurns';

export function AgentTower({ onOpenThread }: {
  /**
   * 스레드로 이동. **부르는 쪽이 칸까지 되돌린다**(`Workspace`) — 관제탑이 본문을 쓰는
   * 동안 스레드를 열면 스레드 패널만 서고 정작 그 대화가 있는 채널은 관제탑에 가려진다.
   * 이동의 뜻은 "그 대화를 보겠다"이므로 화면이 그 자리까지 데려다 놓는다.
   */
  onOpenThread: (threadRootId: string) => void;
}) {
  const snapshot = useAgentTurns(true);
  const accounts = useActiveStore((s) => s.accounts);
  const channels = useActiveStore((s) => s.channels);
  const set = useActiveStore((s) => s.set);
  // 묶음 머리에 세울 스레드 이름. 목록이 5초마다 새로 와도 루트는 캐시에서 온다.
  const roots = useThreadRoots(
    snapshot.kind === 'known' ? snapshot.turns.map((turn) => turn.threadRootId) : [],
  );

  return (
    /* `data-testid` 는 **자리를 재는 손잡이**다 — `ChannelPane` 이 같은 이유로 갖고 있고,
       "관제탑이 채널 자리에 선다"는 이 판의 요지를 회귀선이 그 둘로 잰다. */
    <main data-testid="agent-tower" className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-surface-raised">
      <AgentTurns
        variant="tower"
        snapshot={snapshot}
        handleOf={(id) => accounts[id]?.handle ?? id}
        channelLabel={(id) => {
          const channel = channels.find((c) => c.id === id);
          return channel ? `${channel.visibility === 'private' ? '🔒' : '#'}${channel.name}` : id;
        }}
        threadTitleOf={(rootId) => {
          const row = roots.get(rootId);
          return row ? threadTitle(row, accounts) : null;
        }}
        onOpenThread={onOpenThread}
        onCancelTurns={(turns) => {
          void getController().cancelAgentTurns(turns.map((turn) => turn.sessionId));
        }}
        /* `TerminalChip` 과 **같은 길**로 연다. 새 경로를 만들면 같은 문에 손잡이가 둘이
           되고, 앵커식(`threadRootId ?? id`)이 두 곳에서 갈리는 순간 패널은 세션을 못
           찾는다 — 여기서는 러너가 말한 `threadRootId` 를 그대로 쓴다(그 값이 곧 세션의
           스레드 키다). 없는 턴에는 목록이 버튼을 내지 않는다(`AgentTurns` 주석). */
        onOpenTerminal={(turn) => {
          if (!turn.threadRootId) return;
          set({
            terminalTarget: {
              agentAccountId: turn.agentAccountId,
              channelId: turn.channelId,
              threadRootId: turn.threadRootId,
            },
          });
        }}
      />
    </main>
  );
}
