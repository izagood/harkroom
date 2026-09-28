/**
 * **대기** — 아직 오지 않은 깨움 예약(Agents 관제 4단계).
 *
 * ## 왜 도는 턴 옆에 서야 하는가
 *
 * 관제 화면이 답하는 물음은 *"지금 우리 팀이 무슨 일을 하고 있나"* 였고, 지금까지 그
 * 답은 **도는 턴**뿐이었다. 그런데 `도는 턴 0개` 에는 두 뜻이 섞여 있다 — 아무 일도 없는
 * 것과 **기다리는 중인 것**이고, 사람이 실제로 묻는 것은 대개 뒤쪽이다("죽었나 기다리나").
 * 예약은 스레드마다 흩어진 wake 메시지로만 보였으므로, 스레드를 다 열어 보지 않으면
 * 그 사실을 알 수 없었다.
 *
 * ## 이 구획은 도는 턴과 **신뢰도가 다르다**
 *
 * 세션 목록은 러너 메모리에서 오므로 릴레이가 끊기면 서버도 모른다. 깨움은 테이블에
 * 있어 **언제나 알 수 있다**. 그래서 위 구획이 `모른다` 를 그리는 순간에도 이 구획은
 * 숫자를 낸다 — 그 조합이 곧 *"도는 턴은 모르지만 기다리는 것은 둘 있다"* 이고, 그때가
 * 사람이 이 화면을 제일 필요로 하는 순간이다.
 *
 * ## 아무것도 없으면 아무것도 그리지 않는다
 *
 * `대기 없음` 이라는 줄을 세우지 않는다. 위 구획이 이미 "도는 턴이 없다"를 말하고 있고,
 * 여기에 또 빈 줄을 세우면 화면의 절반이 부재를 설명하는 자리가 된다.
 *
 * ## 칸에서는 **수만** 낸다
 *
 * 관제탑은 칸과 항상 함께 보인다(둘 다 Agents 칸에서 선다). 그래서 칸에 같은 줄을 다시
 * 세우면 한 화면에 같은 목록이 두 벌 서고, 그것은 #741 이 중단 버튼을 칸에서 뺀 것과
 * 같은 문제다. 칸이 답해야 하는 것은 *"기다리는 것이 있나"* 뿐이고 그 답은 숫자다 —
 * 사유·채널·남은 시간은 본문 폭에서 읽는다.
 */
import type { AgentWakeView } from '@harkroom/shared';
import type { AgentWakesSnapshot } from '../lib/agentTurns';
import { waitLabel } from '../lib/time';
import { useLocale, useT } from '../i18n/useT';

export function AgentWaits({ snapshot, handleOf, channelLabel, onOpenThread, variant = 'panel', now = Date.now() }: {
  snapshot: AgentWakesSnapshot;
  handleOf: (accountId: string) => string;
  channelLabel: (channelId: string) => string;
  /** 예약이 돌아갈 자리로 이동. 앵커는 서버가 wake 메시지에서 되찾아 준 것이다. */
  onOpenThread: (threadRootId: string) => void;
  /** 좁은 칸이냐 본문이냐 — `AgentTurns` 의 같은 이름 주석이 근거다. */
  variant?: 'panel' | 'tower';
  now?: number;
}) {
  const t = useT();
  const locale = useLocale();
  const tower = variant === 'tower';

  // 첫 답이 오기 전에는 자리를 만들지 않는다 — `검사 중` 줄이 서면 도는 턴 구획의
  // 같은 줄과 겹쳐 화면이 두 번 같은 말을 한다.
  if (snapshot.kind === 'checking') return null;

  const head = (children: React.ReactNode) => (
    <section data-testid="agent-waits" className={tower ? 'px-4 pb-6' : 'px-2 pb-2'}>
      <h3 className={`text-meta font-medium tracking-wide text-fg-subtle uppercase ${tower ? 'pb-1 pt-3' : 'px-2 pb-1 pt-3'}`}>
        {t('agentWaits.title')}
      </h3>
      {children}
    </section>
  );

  if (snapshot.kind === 'unknown') {
    /*
      **여기서 0 을 말하지 않는다.** 예약은 테이블에 있어 언제나 알 수 있는 사실이므로,
      못 받았다는 것은 서버에 닿지 못했다는 뜻이다 — 그 사실을 사유째로 적는다
      (`AgentTurns` 의 `unknown` 과 같은 규율).
    */
    return head(
      <p data-testid="agent-waits-unknown" className={`text-meta text-fg-subtle ${tower ? '' : 'px-2'}`}>
        {t('agentWaits.unknown')} · {snapshot.reason}
      </p>,
    );
  }

  if (!snapshot.wakes.length) return null;

  const rows: AgentWakeView[] = snapshot.wakes;
  if (!tower) {
    // 칸은 **수만** 낸다(파일 머리 주석). 목록을 다시 세우면 한 화면에 두 벌이 된다.
    return head(
      <p data-testid="agent-waits-count" className="px-2 text-meta text-fg-muted">
        {t('agentWaits.count', { n: rows.length })}
      </p>,
    );
  }
  return head(
    <>
      <ul className="flex flex-col">
        {rows.map((wake) => {
          const at = Date.parse(wake.wakeAt);
          return (
            <li key={wake.id} data-testid={`agent-wait-${wake.id}`}>
              {/*
                줄 전체가 이동 버튼이다 — 예약에 대해 사람이 할 수 있는 일은 지금 그
                스레드를 보는 것뿐이고(취소 문은 아직 없다), 그 하나를 줄 옆의 작은
                버튼에 숨기면 좁은 칸에서 누를 자리가 없다.
              */}
              <button type="button" data-testid={`agent-wait-open-${wake.id}`}
                onClick={() => onOpenThread(wake.threadRootId)}
                className={`flex w-full min-w-0 items-baseline text-left text-meta hover:bg-surface-hover ${tower
                  ? 'gap-3 border-t border-border px-3 py-1.5'
                  : 'gap-1.5 rounded px-2 py-0.5'}`}>
                <span className="shrink-0 font-medium text-fg-agent">@{handleOf(wake.agentAccountId)}</span>
                {/*
                  사유가 없는 줄은 **지워진 깨움**이다. 시계는 살아 있어 깨움은 그대로
                  오므로 줄을 감추지 않고, 대신 왜 빈지를 적는다 — 빈칸으로 두면 사람은
                  화면이 고장난 줄로 읽는다.
                */}
                <span className="min-w-0 flex-1 truncate text-fg-muted">
                  {wake.reason ?? t('agentWaits.reasonMissing')}
                </span>
                {tower && (
                  <span className="shrink-0 text-fg-subtle">{channelLabel(wake.channelId)}</span>
                )}
                {/* 시각은 **남은 시간**으로 적는다 — 사람이 재는 것은 시계가 아니라 기다림의 길이다. */}
                <span data-testid={`agent-wait-when-${wake.id}`} className="shrink-0 text-fg-subtle">
                  {Number.isFinite(at) ? waitLabel(at - now, locale, t) : t('agentWaits.whenUnknown')}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="pt-1 text-meta text-fg-subtle">{t('agentWaits.scope')}</p>
    </>,
  );
}
