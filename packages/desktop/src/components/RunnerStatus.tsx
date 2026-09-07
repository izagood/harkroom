/**
 * 러너 실행 상태 표시(#250). 설정 → 에이전트 상세와 사이드바 에이전트 항목이 **같은 판정**을
 * 쓴다 — 두 자리가 따로 문구를 만들면 한쪽만 고치는 사고가 난다.
 */
import type { RunnerState, RunnerStatus } from '../lib/runnerLauncher';

/**
 * 사람이 읽는 한 줄. **'꺼짐'과 '78 로 죽었다'를 뭉치지 않는다** — 앞은 정상이고 뒤는
 * 사람이 무언가를 해야 하는 상태다. 78 이 아닌 종료는 **코드를 그대로 보여 준다**:
 * 앱이 원인을 지어내면 사람은 러너 로그를 볼 이유를 잃는다.
 *
 * ## `needs_harness` 가 따로 있는 이유 (`#473`)
 *
 * 78 을 두 사유가 공유한다 — 자격증명 폐기와 하네스 부재. **사람이 할 일이 정반대다**:
 * 앞은 재발급이고 뒤는 설치다. 앞 판본은 78 을 전부 "자격증명 폐기"로 적었고, 하네스가
 * 없는 사람은 재발급을 눌러도 아무것도 안 고쳐졌다.
 *
 * 어느 실행 파일인지는 여기서 말하지 않는다 — `state.message` 가 이름을 들고 있고
 * (`runnerLauncher.ts::exitStateFor78`), 이 라벨과 그 문구는 화면에서 나란히 나온다.
 * 이름을 여기서도 만들면 하네스 표가 두 곳으로 갈린다.
 */
export function runnerStatusLabel(state: RunnerState | undefined): string {
  if (!state) return '꺼짐';
  switch (state.status) {
    case 'running': return '실행 중';
    // `#431` 2단계 A: `external`(presence 추측)이 사라지고 `adopted` 가 들어왔다.
    // **daemon 이 `kill(pid, 0)` 으로 확인한 러너**라서 생사를 단언할 수 있다 — 앞
    // 이름은 "이 앱이 안 띄웠다"는 뜻이었는데 "실행 중"으로 읽혔고, 그 오독이 `#430` 이다.
    // **문구 재정의는 `#443` 범위다** — 여기서는 상태값이 가리키는 사실만 바로잡는다.
    case 'adopted': return 'daemon 이 들고 있음';
    // 재기동을 **예약했다**. 'running' 도 'stopped' 도 아닌 이유는 상태값 주석에 있다 —
    // SIGTERM 은 graceful 이라 러너는 진행 중인 턴을 마친 뒤에야 죽고, 그 시차가 분
    // 단위다. 무엇을 기다리는지는 `state.message` 가 말한다.
    case 'restarting': return '재기동 대기 (진행 중인 턴을 마치는 중)';
    case 'needs_reissue': return '종료 (78: 자격증명 폐기 — 재발급 필요)';
    case 'needs_harness': return '종료 (78: 하네스를 찾을 수 없음 — 설치 필요)';
    case 'needs_login': return '종료 (78: 하네스 로그인 만료 — 재로그인 필요)';
    case 'stopped':
      return state.exitCode === null || state.exitCode === 0
        ? '꺼짐'
        : `종료 (기타: 코드 ${state.exitCode})`;
    case 'failed': return '기동 실패';
  }
}

const TONE: Record<RunnerStatus, string> = {
  running: 'text-success',
  adopted: 'text-accent',
  needs_reissue: 'text-warning',
  // 자격증명 폐기와 같은 톤이다 — 둘 다 "러너는 떴는데 사람이 한 단계를 해야 한다"이고,
  // 그것은 실패(`danger`)가 아니다. 무엇을 해야 하는지가 문구로 갈린다.
  needs_harness: 'text-warning',
  // 로그인 만료도 같은 톤이다 — 사람이 한 단계(재로그인)를 하면 낫는다.
  needs_login: 'text-warning',
  // 실패가 아니라 **진행 중**이다 — 사람이 방금 누른 것이 돌고 있다는 뜻이므로
  // 경고(warning)로 물들이지 않는다.
  restarting: 'text-accent',
  stopped: 'text-fg-subtle',
  failed: 'text-danger',
};

/** 사이드바의 점. presence 점과 **다른 사실**이라 나란히 산다(Sidebar 의 주석 참고). */
const DOT: Record<RunnerStatus, string> = {
  running: 'bg-success',
  adopted: 'bg-accent',
  needs_reissue: 'bg-warning',
  needs_harness: 'bg-warning',
  needs_login: 'bg-warning',
  restarting: 'bg-accent',
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
  // 아무 일도 안 하지만 러너는 이미 떠 있을 수 있다. 알고 있는 사실만 말한다.
  if (!state) return null;
  // failed 면 점 옆에 `!` 를 세우고 사유를 `title` 에 싣는다(#368). 이 자리는 목록 한 줄
  // 안이라 문구를 통째로 펼칠 폭이 없다 — **사유 전문을 읽는 자리는 따로 있다**: 채널의
  // 실패 줄(ChannelPane)과 사이드바 Agents 섹션이 같은 `state.message` 를 글자로 펼친다.
  // 점 하나만 두지 않는 이유는 색이 스크린리더에 아무 말도 하지 않기 때문이다.
  // `needs_harness` 도 여기 든다(`#473`) — 사람이 **할 일이 있는** 상태이고, 그 할 일이
  // 무엇인지는 문구에만 있다(어느 실행 파일을 설치할지). 점 색만 보이면 그 사람은
  // 여전히 무엇을 설치할지 모른다. `needs_reissue` 는 빠져 있다 — 그쪽은 화면에 재발급
  // 버튼이 서므로 다음 행동이 문구 없이도 드러난다.
  const message =
    state.status === 'failed' || state.status === 'needs_harness' || state.status === 'needs_login'
      ? state.message : null;
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
