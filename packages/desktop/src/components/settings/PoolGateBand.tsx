/**
 * 계정 풀 칸 위의 **이 맥에서 쓰이는가** 띠(시안 pool_gate v2, jaebin E1~E4 전부 A).
 *
 * 판정은 `lib/poolGate.ts`. ① 이 맥에서 돌면 띠가 없다. ⑤ 모르면 회색 한 줄만(잠그지 않는다).
 * 나머지는 노란 띠에 이유와 **할 일 하나**를 둔다:
 * - ② 배정 없음 → [이 맥에서 돌리기]: 서버 배정과 이 맥 설정을 한 번에 켠다(E2 A).
 * - ③ 다른 머신 → [어디서 돌리나로]: 배정 칸으로 데려가기만 한다. 풀 칸에서 다른 머신의 러너를 멈추는 일이
 *   부수효과로 일어나면 안 된다(E2 A). 최근 턴이 실어 온 풀이 있으면 한 줄 더(E4 A).
 * - ④ 배정은 이 맥, 설정에 없음 → [이 맥 오퍼레이터에서 켜기]: 체크 하나만.
 * 저장된 순서가 있으면 지우지 않고 남긴다는 말과 [이 순서 지우기](E3 A).
 */
import type { PoolGate } from '../../lib/poolGate';
import { useT } from '../../i18n/useT';

export interface RecentPoolTurn { pool: string; account: string | null; rank: number | null }

export function PoolGateBand({
  gate, operatorName, recent, hasChain, busy, canAct, onRunHere, onEnableHere, onGoToAssignment, onClear,
}: {
  gate: PoolGate;
  /** ③ 의 오퍼레이터 이름. 모르면 `null`. */
  operatorName: string | null;
  /** ③ 에서 그 머신의 최근 턴이 실어 온 풀(`claudePool`·`claudePoolRank`). 없으면 그 줄을 생략한다. */
  recent: RecentPoolTurn | null;
  hasChain: boolean;
  busy: boolean;
  /** 배정을 바꿀 수 있는 사람인가(소유자·admin). 아니면 버튼 없이 이유만. */
  canAct: boolean;
  onRunHere(): void;
  onEnableHere(): void;
  onGoToAssignment(): void;
  onClear(): void;
}) {
  const t = useT();
  if (gate.kind === 'here') return null;
  if (gate.kind === 'unknown') {
    return <p className="mt-1 text-meta text-fg-subtle" data-testid="agent-pool-gate" data-gate="unknown">{t('agents.run.poolGate.unknown')}</p>;
  }
  const btn = 'rounded-row border border-border bg-surface px-2 py-0.5 text-meta font-medium text-fg hover:bg-surface-hover disabled:opacity-50';
  const message = gate.kind === 'unassigned'
    ? t('agents.run.poolGate.unassigned')
    : gate.kind === 'half'
      ? t('agents.run.poolGate.half')
      : t('agents.run.poolGate.elsewhere', { name: operatorName ?? t('agents.assignment.unknownOperator') });
  return (
    <div className="mt-1 space-y-1 rounded-md bg-warning-surface px-2 py-1.5 text-meta text-fg" role="status"
      data-testid="agent-pool-gate" data-gate={gate.kind}>
      <p>{message}</p>
      {gate.kind === 'elsewhere' && recent && (
        <p className="text-fg-muted" data-testid="agent-pool-gate-recent">
          {recent.rank !== null
            ? t('agents.run.poolGate.recentRank', { pool: recent.pool, account: recent.account ?? '?', rank: recent.rank })
            : t('agents.run.poolGate.recent', { pool: recent.pool, account: recent.account ?? '?' })}
        </p>
      )}
      {hasChain && <p className="text-fg-muted">{t('agents.run.poolGate.kept')}</p>}
      <div className="flex flex-wrap gap-2">
        {canAct && gate.kind === 'unassigned' && (
          <button type="button" className={btn} disabled={busy} onClick={onRunHere} data-testid="agent-pool-gate-run-here">
            {t('agents.run.poolGate.runHere')}
          </button>
        )}
        {canAct && gate.kind === 'half' && (
          <button type="button" className={btn} disabled={busy} onClick={onEnableHere} data-testid="agent-pool-gate-enable">
            {t('agents.run.poolGate.enableHere')}
          </button>
        )}
        {canAct && gate.kind === 'elsewhere' && (
          <button type="button" className={btn} onClick={onGoToAssignment} data-testid="agent-pool-gate-goto">
            {t('agents.run.poolGate.goToAssignment')}
          </button>
        )}
        {hasChain && (
          <button type="button" className={btn} disabled={busy} onClick={onClear} data-testid="agent-pool-gate-clear">
            {t('agents.run.poolGate.clear')}
          </button>
        )}
      </div>
    </div>
  );
}
