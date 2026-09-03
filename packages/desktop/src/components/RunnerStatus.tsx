/**
 * 러너 실행 상태 표시(#250). 설정 → 에이전트 상세와 사이드바 에이전트 항목이 **같은 판정**을
 * 쓴다 — 두 자리가 따로 문구를 만들면 한쪽만 고치는 사고가 난다.
 */
import type { RunnerState, RunnerStatus } from '../lib/runnerLauncher';

/**
 * 사람이 읽는 한 줄. **'꺼짐'과 '78 로 죽었다'를 뭉치지 않는다** — 앞은 정상이고 뒤는
 * 사람이 재발급을 눌러야 하는 상태다. 78 이 아닌 종료는 **코드를 그대로 보여 준다**:
 * 앱이 원인을 지어내면 사람은 러너 로그를 볼 이유를 잃는다.
 */
export function runnerStatusLabel(state: RunnerState | undefined): string {
  if (!state) return '꺼짐';
  switch (state.status) {
    case 'running': return '실행 중';
    case 'external': return '외부에서 실행 중';
    case 'needs_reissue': return '종료 (78: 자격증명 폐기 — 재발급 필요)';
    case 'stopped':
      return state.exitCode === null || state.exitCode === 0
        ? '꺼짐'
        : `종료 (기타: 코드 ${state.exitCode})`;
    case 'failed': return '기동 실패';
  }
}

const TONE: Record<RunnerStatus, string> = {
  running: 'text-green-700',
  external: 'text-blue-700',
  needs_reissue: 'text-amber-800',
  stopped: 'text-zinc-500',
  failed: 'text-red-700',
};

/** 사이드바의 점. presence 점과 **다른 사실**이라 나란히 산다(Sidebar 의 주석 참고). */
const DOT: Record<RunnerStatus, string> = {
  running: 'bg-green-500',
  external: 'bg-blue-400',
  needs_reissue: 'bg-amber-400',
  stopped: 'bg-zinc-600',
  failed: 'bg-red-500',
};

export function RunnerStatusLine({ state }: { state: RunnerState | undefined }) {
  const label = runnerStatusLabel(state);
  return (
    <div className="text-[11px]" role="status">
      <span className={state ? TONE[state.status] : 'text-zinc-400'}>{label}</span>
      {/* 사유는 **보이는 자리**에 둔다 — `sr-only` 나 콘솔에만 두면 아무도 읽지 않는다. */}
      {state?.message && (
        <span className="ml-1 text-zinc-600">— {state.message}</span>
      )}
    </div>
  );
}

export function RunnerStatusDot({ state, agentId }: { state: RunnerState | undefined; agentId: string }) {
  if (!state) return null;
  return (
    <span
      data-testid={`runner-${agentId}`}
      data-runner-status={state.status}
      title={`러너: ${runnerStatusLabel(state)}`}
      className={`h-2 w-2 rounded-sm ${DOT[state.status]}`}
    />
  );
}
