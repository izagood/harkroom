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
import { useState } from 'react';
import type { AgentSessionView } from '@murmur/shared';
import type { AgentTurnsSnapshot } from '../lib/agentTurns';
import { groupTurnsByThread } from '../lib/agentTurns';
import { ConfirmDialog } from './ConfirmDialog';
import { runningLabel } from '../lib/time';
import { useLocale, useT } from '../i18n/useT';

export function AgentTurns({ snapshot, handleOf, channelLabel, onOpenThread, onCancelTurns, now = Date.now() }: {
  snapshot: AgentTurnsSnapshot;
  /** 계정 id → `@handle`. 스토어 모양을 이 컴포넌트가 알지 않게 함수로 받는다. */
  handleOf: (accountId: string) => string;
  channelLabel: (channelId: string) => string;
  /**
   * 스레드로 이동. 부르는 쪽이 `controller.openMessage` 를 태우므로 **채널 전환·스레드
   * 패널·실패 통지**가 퍼머링크와 같은 경로로 처리된다 — 여기서 다시 조립하지 않는다.
   */
  onOpenThread: (threadRootId: string) => void;
  /**
   * 이 턴들을 **그만두게 한다**(3단계). 한 줄이든 한 스레드든 전부든 **같은 콜백**이다 —
   * 서버에도 묶음 전용 문이 없다(화면이 무엇을 한 묶음으로 보는지는 화면의 일이고, 서버에
   * 그 판정을 두면 두 곳에서 갈린다).
   *
   * 없으면 중단 버튼을 **그리지 않는다**. 눌러도 아무 일이 없는 버튼을 만들지 않는다
   * (design.md §4) — 배선을 빠뜨린 화면에서 조용히 죽은 버튼이 서는 대신 버튼이 부재한다.
   */
  onCancelTurns?: (turns: AgentSessionView[]) => void;
  /** 회귀선이 시각을 고정할 수 있어야 한다(`lib/time.ts::agoLabel` 이 `now` 를 받는 이유와 같다). */
  now?: number;
}) {
  const t = useT();
  const locale = useLocale();
  /**
   * `전부 중단` 확인 겹창(3단계). **줄·스레드 단위에는 확인을 두지 않는다** — 그 둘은
   * 사람이 무엇을 멈추는지 보면서 누르는 것이고, 확인을 세 곳에 다 두면 확인 자체가
   * 장식이 된다. 전부는 다르다: 목록 밖의 스레드까지 멈추므로 남의 정상 작업이 함께 죽는다.
   */
  const [confirmAll, setConfirmAll] = useState<AgentSessionView[] | null>(null);

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

  /**
   * 묶음 중단이 실제로 멈출 턴들. **사람이 조종 중인 턴(`mode === 'interactive'`)은 뺀다** —
   * 그 화면 앞에는 사람이 앉아 있고, 목록에서 누른 한 번으로 남의 터미널을 죽이는 것은
   * 이 기능이 막으려는 사고(의도 없이 여럿을 건드리는 것)와 같은 모양이다. 그 턴은 자기
   * 창에서 끝내면 된다(Ctrl-C 가 그 세션에는 실제로 통한다 — `acceptsInput` 이 참이다).
   *
   * `mode` 가 없는 턴(구 러너)은 **뺀 것이 아니라 모르는 것**이라 포함한다: 멘션 턴이
   * 대다수이고, 모른다는 이유로 중단에서 제외하면 폭주를 멈추는 손이 조용히 반쪽이 된다.
   */
  const stoppable = (turns: readonly AgentSessionView[]): AgentSessionView[] =>
    turns.filter((turn) => turn.mode !== 'interactive');

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
      <div className="flex items-center gap-2 px-2 pb-1">
        <p data-testid="agent-turns-count" className="text-meta text-state-running">
          {t('agentTurns.count', { n: snapshot.turns.length })}
        </p>
        {onCancelTurns && stoppable(snapshot.turns).length > 1 && (
          /* **둘 이상일 때만 선다.** 하나뿐이면 그 줄의 [중단] 과 같은 일을 하는 두 번째
             버튼이 되고, 같은 일을 하는 길이 둘이면 사람은 매번 어느 쪽인지 고른다. */
          <button type="button" data-testid="agent-turns-cancel-all"
            onClick={() => setConfirmAll(stoppable(snapshot.turns))}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-meta text-danger hover:bg-danger-surface">
            {t('agentTurns.cancelAll')}
          </button>
        )}
      </div>
      {confirmAll && (
        <ConfirmDialog
          title={t('agentTurns.cancelAllTitle', { n: confirmAll.length })}
          detail={t('agentTurns.cancelDetail')}
          confirmLabel={t('agentTurns.cancelConfirm')}
          cancelLabel={t('agentTurns.cancelKeep')}
          /* 되돌릴 수 없다 — 중단된 턴은 다시 이어지지 않고 새 멘션으로만 다시 시작한다. */
          danger
          onConfirm={() => { onCancelTurns?.(confirmAll); setConfirmAll(null); }}
          onCancel={() => setConfirmAll(null)}
        />
      )}
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
              {/*
                묶음 머리는 **버튼 하나가 아니라 줄**이다(3단계). 이동과 중단을 한 버튼에
                담을 수 없고, 중단을 이동 버튼 안에 중첩하면 누를 때마다 두 일이 함께
                일어난다 — 그것이 바로 이 기능이 막으려는 사고의 모양이다.
              */}
              <div className="flex items-center gap-1 px-2 py-1">
                {root ? (
                  <button type="button" data-testid={`agent-turns-open-${root}`}
                    onClick={() => onOpenThread(root)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <span className="truncate text-meta font-medium text-fg">{channelLabel(group.channelId)}</span>
                    <span className="ml-auto shrink-0 text-meta text-state-running">
                      {t('agentTurns.count', { n: group.turns.length })}
                    </span>
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2" title={t('agentTurns.noThread')}>
                    <span className="truncate text-meta font-medium text-fg-muted">{channelLabel(group.channelId)}</span>
                    <span className="ml-auto shrink-0 text-meta text-state-running">
                      {t('agentTurns.count', { n: group.turns.length })}
                    </span>
                  </div>
                )}
                {/*
                  **스레드가 중단의 정본 단위다.** 폭주는 스레드에 갇혀 일어나므로 사람이
                  실제로 쓰게 될 버튼은 대개 이것 하나다. 여기에는 확인을 두지 않는다 —
                  무엇을 멈추는지 보면서 누르는 자리이고, 확인이 세 곳에 다 있으면 확인이
                  장식이 된다(`전부` 만 목록 밖까지 멈추므로 확인을 받는다).
                */}
                {onCancelTurns && stoppable(group.turns).length > 0 && (
                  <button type="button" data-testid={`agent-turns-cancel-group-${group.channelId}-${root ?? 'root'}`}
                    onClick={() => onCancelTurns(stoppable(group.turns))}
                    title={t('agentTurns.cancelThreadTitle')}
                    className="shrink-0 rounded px-1.5 py-0.5 text-meta text-danger hover:bg-danger-surface">
                    {t('agentTurns.cancelThread')}
                  </button>
                )}
              </div>
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
                      {/*
                        **지금 이 턴이 쓰는 claude 계정**(다중 계정 3단계). 계정 풀은
                        러너가 기동할 때 정하고 한도에 걸리면 턴 단위로 다음 계정으로
                        넘어가는데, 그 사실이 러너 콘솔 한 줄에만 남아서 사람은 등록한
                        계정 중 무엇이 도는지 볼 수 없었다 — 그래서 사용량도, 넘어간
                        순간도 알 수 없었다. 여기 배지가 그 사실을 턴 줄에 붙인다.

                        `undefined` 와 `null` 을 가른다(`AgentSessionView.claudeAccount`):
                        없으면 **아무것도 그리지 않는다** — 이 필드를 싣지 않는 러너이거나
                        claude 하네스가 아닌 턴이고, 그때 "기본"이라고 적으면 화면이
                        확인한 적 없는 것을 단언한다. `null` 은 확인된 사실이다: 풀이 비어
                        시스템 기본 로그인으로 돈다.

                        풀 이름은 배지에 적지 않고 `title` 에 둔다 — 줄이 좁고, 사람이
                        평소 쫓는 것은 계정 이름이다. 같은 이름의 계정이 풀마다 있을 수
                        있어서 풀은 그때만 필요하다.
                      */}
                      {turn.claudeAccount !== undefined && (
                        <span data-testid={`agent-turn-account-${turn.sessionId}`}
                          title={turn.claudePool
                            ? t('agentTurns.accountTitle', { pool: turn.claudePool })
                            : t('agentTurns.accountTitleRoot')}
                          className="min-w-0 shrink truncate rounded bg-surface-raised px-1 text-fg-muted">
                          {turn.claudeAccount ?? t('agentTurns.accountDefault')}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-fg-subtle">
                        {Number.isFinite(startedAt) ? runningLabel(Math.max(0, now - startedAt), locale, t) : turn.harness}
                      </span>
                      {/*
                        **사람이 조종 중인 턴에는 이 버튼이 없다** — 부재이지 비활성이 아니다.
                        그 화면 앞에는 사람이 앉아 있고, 그 세션은 입력을 받으므로(`acceptsInput`)
                        자기 창에서 끝내는 길이 이미 있다. 비활성으로 두면 사람은 왜 못 누르는지
                        물을 대상을 찾게 된다(`TerminalChip` 이 같은 판단을 적어 뒀다).
                      */}
                      {onCancelTurns && turn.mode !== 'interactive' && (
                        <button type="button" data-testid={`agent-turn-cancel-${turn.sessionId}`}
                          onClick={() => onCancelTurns([turn])}
                          className="shrink-0 rounded px-1 text-danger hover:bg-danger-surface">
                          {t('agentTurns.cancel')}
                        </button>
                      )}
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
