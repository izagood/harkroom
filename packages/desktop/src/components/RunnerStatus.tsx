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
  running: 'text-success',
  external: 'text-accent',
  needs_reissue: 'text-warning',
  stopped: 'text-fg-subtle',
  failed: 'text-danger',
};

/** 사이드바의 점. presence 점과 **다른 사실**이라 나란히 산다(Sidebar 의 주석 참고). */
const DOT: Record<RunnerStatus, string> = {
  running: 'bg-success',
  external: 'bg-accent',
  needs_reissue: 'bg-warning',
  stopped: 'bg-fg-subtle',
  failed: 'bg-danger',
};

export function RunnerStatusLine({ state }: { state: RunnerState | undefined }) {
  const label = runnerStatusLabel(state);
  return (
    <div className="text-[11px]" role="status">
      <span className={state ? TONE[state.status] : 'text-fg-muted'}>{label}</span>
      {/* 사유는 **보이는 자리**에 둔다 — `sr-only` 나 콘솔에만 두면 아무도 읽지 않는다. */}
      {state?.message && (
        <span className="ml-1 text-fg-muted">— {state.message}</span>
      )}
    </div>
  );
}

export function RunnerStatusDot({ state, agentId }: { state: RunnerState | undefined; agentId: string }) {
  // 상태를 모르면 아무것도 그리지 않는다 — '알 수 없음'을 '꺼짐'으로 읽으면 사람이
  // 아무 일도 안 하지만 Russalka 는 이미 띄워져 있을 수 있다. 알고 있는 사실만 말한다.
  if (!state) return null;
  // failed 상태에서는 사람에게 보이는 사유를 함께 그린다(#368). 이유 없는 '실패'는
  // 사람이 할 수 있는 일이 없는 거짓 신호다.
  const message = state.status === 'failed' ? state.message : null;
  return (
    <>
      <span
        data-testid={`runner-${agentId}`}
        data-runner-status={state.status}
        title={`러너: ${runnerStatusLabel(state)}${message ? ` — ${message}` : ''}`}
        className={`h-2 w-2 rounded-sm ${DOT[state.status]}`}
      />
      {message && (
        <span className="text-[10px] text-danger" title={message}>
          !
        </span>
      )}
    </>
  );
}
