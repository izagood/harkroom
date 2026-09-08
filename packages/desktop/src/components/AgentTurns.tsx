/**
 * **지금 도는 턴** — Agents 칸의 관제 구획(1단계).
 *
 * ## 왜 이 칸에 이것이 서는가
 *
 * 이 칸이 답해 온 물음은 *"우리 팀에 누가 있고 지금 일할 수 있나"*(인력)였고, 얼굴 격자가
 * 그 답이었다(`AgentGrid`). 여기 한 줄이 더 필요해진 계기는 실제 사고다: 팀으로 부른
 * 답변을 복사해 붙여넣자 본문에 남아 있던 `@handle` 이 **다시 호출**로 읽혀 같은 스레드에
 * 턴이 연달아 떴는데, 사람에게는 **몇 개가 돌고 있는지 볼 자리가 없었다**. 인력 옆에
 * "그 인력이 지금 무슨 일을 하고 있나"가 서야 이 칸이 관리하는 자리가 된다.
 *
 * ## 묶음은 에이전트가 아니라 **스레드**다
 *
 * 폭주는 스레드 단위로 일어난다 — 한 스레드에서 여럿이 서로를 부른다. 에이전트로 묶으면
 * 그 사실이 목록 전체에 흩어져, 사람은 여러 줄을 읽고 머릿속에서 다시 묶어야 한다.
 * 스레드로 묶으면 `4개 도는 중` 이 한 줄에 서고, 다음 단계에서 **중단 버튼이 붙을 자리**도
 * 그 줄이다(중단의 단위가 곧 묶음의 단위다).
 *
 * ## 이 구획은 아무것도 멈추지 않는다
 *
 * 1단계는 읽기 전용이다. 턴 하나를 끊는 길이 아직 없기 때문이다 — 지금 있는 것은 러너
 * 프로세스를 통째로 죽이는 `killRunner` 뿐이고, 그것은 "이 일을 그만둬라"가 아니라 "이
 * 에이전트는 당분간 아무 말도 못 한다"는 뜻이다. 두 층을 한 버튼으로 뭉치면 사람은 폭주를
 * 멈추려고 팀원을 해고한다. 중단은 릴레이에 `cancelSession` 이 생긴 뒤에 붙는다.
 *
 * ## 목록의 범위를 화면이 적는다
 *
 * 보이는 것은 **러너가 릴레이로 알려 준 턴**이고, 내가 볼 수 있는 에이전트(소유자·admin)에
 * 한한다. 그래서 빈 목록은 "이 워크스페이스에 도는 턴이 없다"가 아니라 "내가 보는 범위에
 * 없다"다 — 그 한 줄을 안 적으면 화면이 아는 것보다 많이 말한다(design.md §4).
 * 물어서 답을 못 받은 경우는 아예 다른 상태로 그린다(`unknown`): **0 과 모름을 같은 모양으로
 * 그리면** 사람은 폭주가 멈춘 줄 안다.
 */
import type { AgentTurnsSnapshot } from '../lib/agentTurns';
import { groupTurnsByThread } from '../lib/agentTurns';
import { runningLabel } from '../lib/time';
import { useLocale, useT } from '../i18n/useT';

export function AgentTurns({ snapshot, handleOf, channelLabel, onOpenThread, now = Date.now() }: {
  snapshot: AgentTurnsSnapshot;
  /** 계정 id → `@handle`. 스토어 모양을 이 컴포넌트가 알지 않게 함수로 받는다. */
  handleOf: (accountId: string) => string;
  channelLabel: (channelId: string) => string;
  /**
   * 스레드로 이동. 부르는 쪽이 `controller.openMessage` 를 태우므로 **채널 전환·스레드
   * 패널·실패 통지**가 퍼머링크와 같은 경로로 처리된다 — 여기서 다시 조립하지 않는다.
   */
  onOpenThread: (threadRootId: string) => void;
  /** 회귀선이 시각을 고정할 수 있어야 한다(`lib/time.ts::agoLabel` 이 `now` 를 받는 이유와 같다). */
  now?: number;
}) {
  const t = useT();
  const locale = useLocale();

  const frame = (children: React.ReactNode) => (
    <section data-testid="agent-turns" className="px-2 pb-2">
      <h3 className="px-2 pt-3 pb-1 text-meta font-medium tracking-wide text-fg-subtle uppercase">
        {t('agentTurns.title')}
      </h3>
      {children}
    </section>
  );

  if (snapshot.kind === 'checking') {
    return frame(
      <p data-testid="agent-turns-checking" className="px-2 py-1 text-meta text-fg-subtle">
        {t('agentTurns.checking')}
      </p>,
    );
  }

  if (snapshot.kind === 'unknown') {
    // **사유를 그대로 싣는다.** 그리고 "0 이 아니다"를 말로 적는다 — 이 줄이 없으면
    // 사람은 빈 목록과 같은 뜻으로 읽는다.
    return frame(
      <div data-testid="agent-turns-unknown"
        className="mx-1 rounded border border-dashed border-border px-2 py-2">
        <p className="text-meta text-fg">{t('agentTurns.unknown')}</p>
        <p className="mt-0.5 text-meta text-fg-subtle">{t('agentTurns.unknownHint')}</p>
        <p className="mt-1 text-meta text-fg-subtle break-words">{snapshot.reason}</p>
      </div>,
    );
  }

  const groups = groupTurnsByThread(snapshot.turns);
  if (!groups.length) {
    return frame(
      <>
        <p data-testid="agent-turns-none" className="px-2 py-1 text-meta text-fg-muted">
          {t('agentTurns.none')}
        </p>
        <p className="px-2 text-meta text-fg-subtle">{t('agentTurns.scope')}</p>
      </>,
    );
  }

  return frame(
    <>
      <p data-testid="agent-turns-count" className="px-2 pb-1 text-meta text-state-running">
        {t('agentTurns.count', { n: snapshot.turns.length })}
      </p>
      <ul className="flex flex-col gap-1">
        {groups.map((group) => {
          const root = group.threadRootId;
          return (
            <li key={`${group.channelId}/${root ?? '_root'}`}
              data-testid={`agent-turns-group-${group.channelId}-${root ?? 'root'}`}
              className="rounded bg-surface-sunken">
              {/*
                러너가 스레드를 말하지 않은 묶음은 **버튼이 아니다** — 눌러도 갈 곳이 없는
                버튼을 그리지 않는다(design.md §4). 그 사실을 `title` 이 말한다.
              */}
              {root ? (
                <button type="button" data-testid={`agent-turns-open-${root}`}
                  onClick={() => onOpenThread(root)}
                  className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-surface-hover">
                  <span className="truncate text-meta font-medium text-fg">{channelLabel(group.channelId)}</span>
                  <span className="ml-auto shrink-0 text-meta text-state-running">
                    {t('agentTurns.count', { n: group.turns.length })}
                  </span>
                </button>
              ) : (
                <div className="flex items-center gap-2 px-2 py-1" title={t('agentTurns.noThread')}>
                  <span className="truncate text-meta font-medium text-fg-muted">{channelLabel(group.channelId)}</span>
                  <span className="ml-auto shrink-0 text-meta text-state-running">
                    {t('agentTurns.count', { n: group.turns.length })}
                  </span>
                </div>
              )}
              <ul>
                {group.turns.map((turn) => {
                  const startedAt = Date.parse(turn.startedAt);
                  return (
                    <li key={turn.sessionId} data-testid={`agent-turn-${turn.sessionId}`}
                      className="flex items-baseline gap-1.5 px-2 pb-1 pl-4 text-meta">
                      <span className="truncate font-medium text-fg-agent">@{handleOf(turn.agentAccountId)}</span>
                      {/*
                        `mode` 는 옵셔널이다 — 없으면 **알 수 없다는 뜻이지 멘션 턴이라는
                        뜻이 아니다**(`AgentSessionView.mode` 주석). 그래서 표시는
                        `interactive` 일 때만 붙이고, 없을 때 "자동"이라고 적지 않는다.
                      */}
                      {turn.mode === 'interactive' && (
                        <span data-testid={`agent-turn-human-${turn.sessionId}`}
                          className="shrink-0 rounded bg-accent-surface px-1 text-accent">
                          {t('agentTurns.human')}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-fg-subtle">
                        {Number.isFinite(startedAt) ? runningLabel(Math.max(0, now - startedAt), locale, t) : turn.harness}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
      <p className="px-2 pt-1 text-meta text-fg-subtle">{t('agentTurns.scope')}</p>
    </>,
  );
}
