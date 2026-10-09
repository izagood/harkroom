import { useActiveStore } from '../state/communities';
import { useT } from '../i18n/useT';

/** 스레드 첫 줄을 이만큼까지만 싣는다 — 카드 한 줄을 넘기지 않는다. */
const SNIPPET_CHARS = 40;

/**
 * 에이전트가 **터미널에서 사람을 기다린다**는 것을 말하는 카드(2026-10-09 A안).
 *
 * 전에는 실패 알림과 같은 띠(`Notice`) 한 칸을 썼다. 그 띠는 ① 바탕과 명도가 거의 같아 잘
 * 안 보였고 ② 관문이 풀려도 ×를 누르기 전까지 남았고 ③ 헤더 아래 흐름 안에 그려져 화면
 * 전체를 한 줄 밀었다. 이 카드는 본문 오른쪽 위에 **겹쳐** 그리고(밀지 않는다), 누가·어디서
 * 기다리는지와 그리로 가는 문([터미널 열기])을 함께 준다.
 *
 * 내려가는 때: 그 터미널을 열었을 때(`set({ terminalTarget })` — 앱이 자동으로 연 경우 포함,
 * 그래서 대개는 서지도 않는다), 세션이 끝났을 때(`agent.attention.cleared`), [나중에].
 * [나중에]는 카드만 접는다 — 턴 줄의 ⌨ 대기 표시는 풀릴 때까지 남는다(`AgentTurns`).
 *
 * 여럿이면 가장 최근 하나를 그리고 나머지는 "외 n" 으로 센다. `role="status"` — 실패가
 * 아니라 할 일이라 끼어들어 읽지 않는다.
 */
export function GateCard() {
  const t = useT();
  const gates = useActiveStore((s) => s.gates);
  const open = gates.filter((g) => !g.dismissed);
  const gate = open.at(-1);
  const channel = useActiveStore((s) => (gate ? s.channels.find((c) => c.id === gate.channelId) : undefined));
  const rootBody = useActiveStore((s) => (gate?.threadRootId
    ? s.messages[gate.channelId]?.find((m) => m.id === gate.threadRootId)?.body
    : undefined));
  if (!gate) return null;
  const firstLine = rootBody?.split('\n')[0]?.trim();
  const snippet = firstLine && firstLine.length > SNIPPET_CHARS ? `${firstLine.slice(0, SNIPPET_CHARS)}…` : firstLine;
  const where = [
    t('gate.account', { account: gate.accountLabel }),
    channel ? `#${channel.name}${snippet ? ` › ${snippet}` : ''}` : null,
  ].filter(Boolean).join(' · ');
  const { threadRootId } = gate;
  return (
    <div
      role="status"
      data-testid="gate-card"
      className="absolute right-3 top-3 z-40 w-80 max-w-[calc(100%-1.5rem)] rounded-card border border-border border-l-4 border-l-accent-brand bg-surface-raised px-3 py-2.5 shadow-float"
    >
      <p className="text-body font-semibold text-fg">
        ⌨ {t('gate.title', { handle: gate.agentHandle })}
      </p>
      <p className="mt-0.5 truncate text-meta text-fg-muted" title={where}>{where}</p>
      <div className="mt-2 flex items-center gap-1.5">
        {threadRootId && (
          <button
            type="button"
            data-testid="gate-card-open"
            className="rounded-row bg-accent px-2 py-1 text-meta font-medium text-fg-on-strong hover:bg-accent-hover"
            onClick={() => useActiveStore.getState().set({
              terminalTarget: { agentAccountId: gate.agentAccountId, channelId: gate.channelId, threadRootId },
            })}
          >
            {t('gate.open')}
          </button>
        )}
        <button
          type="button"
          data-testid="gate-card-later"
          className="rounded-row px-2 py-1 text-meta text-fg-muted hover:bg-surface-hover"
          onClick={() => useActiveStore.getState().dismissGate(gate.sessionId)}
        >
          {t('gate.later')}
        </button>
        {open.length > 1 && (
          <span className="ml-auto text-meta text-fg-subtle">{t('gate.more', { count: open.length - 1 })}</span>
        )}
      </div>
    </div>
  );
}
