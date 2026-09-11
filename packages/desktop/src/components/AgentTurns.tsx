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
import type { AgentSessionView } from '@harkroom/shared';
import type { AgentTurnsSnapshot } from '../lib/agentTurns';
import { groupTurnsByThread } from '../lib/agentTurns';
import { ConfirmDialog } from './ConfirmDialog';
import { runningLabel } from '../lib/time';
import { useLocale, useT } from '../i18n/useT';

export function AgentTurns({
  snapshot, handleOf, channelLabel, threadTitleOf, onOpenThread, onCancelTurns, onOpenTerminal,
  variant = 'panel', now = Date.now(),
}: {
  snapshot: AgentTurnsSnapshot;
  /** 계정 id → `@handle`. 스토어 모양을 이 컴포넌트가 알지 않게 함수로 받는다. */
  handleOf: (accountId: string) => string;
  channelLabel: (channelId: string) => string;
  /**
   * 스레드 루트 id → **스레드 이름**(루트의 첫 줄). 없으면 채널 이름만 선다 — 아직 못
   * 받았거나 볼 권한이 없는 것이고, 그때 이름을 지어내지 않는다(`lib/agentTurns.ts`
   * `threadTitle` 주석). 받아 오는 것은 부르는 쪽의 일이다: 이 컴포넌트는 스토어도
   * api 도 모른다(그래서 회귀선이 props 만으로 화면을 세울 수 있다).
   */
  threadTitleOf?: (threadRootId: string) => string | null;
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
  /**
   * 이 턴의 **터미널을 연다**(관제탑에서만 선다). 스레드를 말하지 않은 턴에는 이 문이
   * 없다 — `terminalTarget` 이 가리키는 것이 스레드이기 때문이다(`TerminalChip` 과 같은
   * 길로 연다: 새 경로를 만들면 같은 문에 손잡이가 둘이 된다).
   */
  onOpenTerminal?: (turn: AgentSessionView) => void;
  /**
   * **좁은 칸(`panel`)이냐 본문(`tower`)이냐.**
   *
   * 컨셉이 관제탑을 본문에 둔 이유는 폭이다: 스레드 이름 · 하네스 · 경과 · 터미널까지
   * 한 줄에 세우려면 300px 로는 안 된다. 그래서 같은 목록을 두 폭으로 그린다 — 목록을
   * 두 컴포넌트로 갈라 쓰면 *"묶음은 스레드"*·*"조종 중인 턴은 다른 문"* 같은 판단이
   * 두 곳에 복사되고, 한쪽만 고쳐지는 것이 이 개편이 고치려는 어긋남 그 자체다.
   *
   * 칸(`panel`)에서는 **중단 버튼을 넘기지 않는다**(`onCancelTurns` 부재) — 관제탑이
   * 칸과 **항상 함께** 보이므로(둘 다 Agents 칸에서 선다) 같은 버튼이 한 화면에 두 벌
   * 서게 되고, 사람은 매번 어느 쪽을 누를지 고른다.
   */
  variant?: 'panel' | 'tower';
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
  /**
   * `조종 끝내기` 확인 겹창. **줄 단위인데도 확인을 두는 유일한 자리**이고, 위 규칙의
   * 예외인 근거가 다르다: 멘션 턴을 끊는 것은 에이전트의 일을 멈추는 것이지만, 조종을
   * 끊는 것은 **사람이 지금 쓰고 있을 수도 있는 터미널**을 끊는 것이다. 그 사람이 나일
   * 수도 남일 수도 있고, 목록만 봐서는 그 창이 살아 있는지 알 수 없다.
   */
  const [confirmControl, setConfirmControl] = useState<AgentSessionView | null>(null);

  const tower = variant === 'tower';
  const frame = (children: React.ReactNode, sub?: React.ReactNode) => (
    <section data-testid="agent-turns" className={tower ? 'px-4 pb-6' : 'px-2 pb-2'}>
      {tower ? (
        /* 본문에서는 제목이 **머리글**이다 — 칸의 구획 이름(uppercase meta)으로 두면
           본문 한가운데에 사이드바 조각이 놓인 것처럼 보인다. */
        <header className="border-b border-border pb-2 pt-4">
          <h2 className="text-title font-semibold text-fg">{t('agentTurns.title')}</h2>
          {sub}
        </header>
      ) : (
        <h3 className="px-2 pt-3 pb-1 text-meta font-medium tracking-wide text-fg-subtle uppercase">
          {t('agentTurns.title')}
        </h3>
      )}
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
   * **묶음에서 빼는 것과 아예 못 끊는 것은 다르다.** 위 문장의 "자기 창에서 끝내면 된다"는
   * 그 창이 아직 있을 때만 참이었다: 뷰어 수 프레임이 유실되면 패널을 닫아도 조종이 남고,
   * 그러면 창도 없고 끊을 손도 없어 그 스레드의 멘션이 영구히 유예된다(실측). 그래서 줄
   * 단위에는 **다른 이름의 문**을 따로 낸다(`조종 끝내기` + 확인) — 묶음에서 빠지는 것은
   * 그대로다: 여럿을 한 번에 끊는 실수를 막는 것이 그쪽의 목적이다.
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

  /**
   * 본문 머리글의 한 줄 요약. **가장 오래된 턴**을 함께 적는 이유: 폭주는 오래 도는 쪽에서
   * 시작되고, 목록을 다 읽기 전에 "지금 급한가"를 판단하게 하는 숫자가 그것이다.
   */
  const oldestStart = Math.min(...snapshot.turns.map((turn) => Date.parse(turn.startedAt) || now));
  const sub = tower ? (
    <p data-testid="agent-turns-subline" className="mt-1 text-meta text-fg-subtle">
      {t('agentTurns.subline', {
        n: snapshot.turns.length,
        threads: groups.length,
        oldest: runningLabel(Math.max(0, now - oldestStart), locale, t),
      })}
    </p>
  ) : undefined;

  return frame(
    <>
      <div className={`flex items-center gap-2 pb-1 ${tower ? 'pt-2' : 'px-2'}`}>
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
      {confirmControl && (
        <ConfirmDialog
          title={t('agentTurns.endControlTitle', { handle: handleOf(confirmControl.agentAccountId) })}
          detail={t('agentTurns.endControlDetail')}
          confirmLabel={t('agentTurns.endControlConfirm')}
          cancelLabel={t('agentTurns.cancelKeep')}
          danger
          onConfirm={() => { onCancelTurns?.([confirmControl]); setConfirmControl(null); }}
          onCancel={() => setConfirmControl(null)}
        />
      )}
      <ul className="flex flex-col gap-1">
        {groups.map((group) => {
          const root = group.threadRootId;
          /*
            **묶음의 이름은 스레드다.** 채널 이름만 세우면 한 채널에서 두 스레드가 돌 때
            묶음 둘이 똑같은 이름으로 서고, `이 스레드 턴 전부 중단` 을 무엇에 누르는지
            알 수 없다 — 그 버튼에 확인 겹창을 두지 않은 근거가 *"무엇을 멈추는지 보면서
            누른다"* 였으므로, 이름이 없으면 그 근거가 사라진다.

            못 받았으면 채널 이름으로 **되돌아간다**(지어내지 않는다).
          */
          const title = root ? threadTitleOf?.(root) ?? null : null;
          const label = title ?? channelLabel(group.channelId);
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
                    <span className="truncate text-meta font-medium text-fg">{label}</span>
                    {title && (
                      <span className="shrink-0 text-meta text-fg-subtle">{channelLabel(group.channelId)}</span>
                    )}
                    <span className="ml-auto shrink-0 text-meta text-state-running">
                      {t('agentTurns.count', { n: group.turns.length })}
                    </span>
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2" title={t('agentTurns.noThread')}>
                    <span className="truncate text-meta font-medium text-fg-muted">{label}</span>
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
                      className={`flex items-baseline text-meta ${tower
                        ? 'gap-3 border-t border-border px-3 py-1.5'
                        : 'gap-1.5 px-2 pb-1 pl-4'}`}>
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
                      {/*
                        하네스는 **본문에서만 자기 칸을 갖는다.** 칸(300px)에서는 경과
                        시간이 그 자리를 쓰고 있어서, 하네스는 시각을 못 읽을 때만 대신
                        선다(아래) — 좁은 곳에서 둘을 다 세우면 에이전트 이름이 잘린다.
                      */}
                      {tower && (
                        <span data-testid={`agent-turn-harness-${turn.sessionId}`}
                          className="shrink-0 text-fg-subtle">{turn.harness}</span>
                      )}
                      <span className="ml-auto shrink-0 text-fg-subtle">
                        {Number.isFinite(startedAt)
                          ? runningLabel(Math.max(0, now - startedAt), locale, t)
                          : tower ? t('agentTurns.startUnknown') : turn.harness}
                      </span>
                      {/*
                        **터미널은 스레드를 가리킨다**(`terminalTarget`). 그래서 러너가
                        스레드를 말하지 않은 턴에는 이 문이 **없다** — 눌러도 열 자리가
                        없는 버튼을 그리지 않는다(design.md §4).
                      */}
                      {tower && onOpenTerminal && turn.threadRootId && (
                        <button type="button" data-testid={`agent-turn-terminal-${turn.sessionId}`}
                          onClick={() => onOpenTerminal(turn)}
                          title={t('agentTurns.terminalTitle')}
                          className="shrink-0 rounded px-1 text-fg-muted hover:bg-surface-hover">
                          {t('agentTurns.terminal')}
                        </button>
                      )}
                      {/*
                        **조종 중인 턴은 다른 이름의 문으로 끝낸다.** 예전에는 이 자리에
                        버튼이 아예 없었고 근거는 "그 화면 앞에 사람이 앉아 있으니 자기 창에서
                        끝내면 된다"였다 — 그 전제가 틀렸다: 패널을 닫아도 조종이 남는 경로가
                        있고(뷰어 수 프레임 유실, 실측) 그때는 창도 없고 끊을 손도 없어 그
                        스레드의 멘션이 영구히 유예된다. 남은 수단이 러너 종료뿐이었는데 그것은
                        그 에이전트의 다른 스레드 턴까지 죽인다.

                        이름과 확인을 가른다: `중단` 은 에이전트의 일을 멈추는 것이고
                        `조종 끝내기` 는 **사람이 쓰고 있을 수도 있는 터미널**을 끊는 것이다.
                        같은 이름·같은 무게로 두면 목록을 훑다 남의 작업을 끊는다.
                      */}
                      {onCancelTurns && (turn.mode === 'interactive' ? (
                        <button type="button" data-testid={`agent-turn-end-control-${turn.sessionId}`}
                          onClick={() => setConfirmControl(turn)}
                          className="shrink-0 rounded px-1 text-danger hover:bg-danger-surface">
                          {t('agentTurns.endControl')}
                        </button>
                      ) : (
                        <button type="button" data-testid={`agent-turn-cancel-${turn.sessionId}`}
                          onClick={() => onCancelTurns([turn])}
                          className="shrink-0 rounded px-1 text-danger hover:bg-danger-surface">
                          {t('agentTurns.cancel')}
                        </button>
                      ))}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
      <p className={`pt-1 text-meta text-fg-subtle ${tower ? '' : 'px-2'}`}>{t('agentTurns.scope')}</p>
    </>,
    sub,
  );
}
