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

/**
 * **어떤 상태가 사유를 글자로 받는가.**
 *
 * ## 이 판정이 여기 있는 이유 (`docs/desktop-rail.html` 3단계)
 *
 * `RunnerStatusDot`(사이드바의 네모난 점)이 이 목록을 들고 있었고, 3단계가 에이전트 칸을
 * 얼굴 그리드로 바꾸면서 그 컴포넌트의 마지막 호출자가 사라져 **함께 지웠다**. 목록은
 * 남는다 — `dmRow` 가 그것을 보고 있고, 지우면 그 자리가 같은 표를 제 손으로 다시 적는다.
 *
 * ## 넷 중 셋이다
 *
 * `failed`·`needs_harness`·`needs_login` 이 사유를 받고 **`needs_reissue` 는 빠진다.**
 * 그쪽은 화면에 재발급 버튼이 서므로 다음 행동이 문구 없이도 드러난다. 나머지 셋은
 * 사람이 할 일이 **문구에만** 있다 — 어느 실행 파일을 설치할지(`#473`), 어디에 다시
 * 로그인할지는 색으로 말할 수 없다.
 *
 * `#368` 이 세운 규율이 이 함수의 전제다: *"사유가 title 툴팁에만 있으면 사람은 그것을
 * 찾지 못한다."* 그래서 이것을 부르는 자리는 반드시 **보이는 글자**로 펼친다.
 */
export function runnerReason(state: RunnerState | undefined): string | null {
  if (!state) return null;
  return state.status === 'failed' || state.status === 'needs_harness' || state.status === 'needs_login'
    ? state.message
    : null;
}

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

/*
 * **`RunnerStatusDot` 이 여기 있었다** — 지웠다(`docs/desktop-rail.html` 3단계).
 *
 * 사이드바 목록 한 줄 안의 네모난 점 + `!` 였고, 마지막 호출자는 에이전트 칸의 목록이었다.
 * 3단계가 그 칸을 얼굴 그리드로 바꾸면서 러너 상태를 말하는 것이 **아바타 하나**가 됐다
 * (`lib/faceState.ts`) — B1 의 요구가 그것이다: *"점은 사람에게만 남고 … 상태를 아바타가
 * 말하게 한다."* 호출자가 없어진 컴포넌트를 남겨 두면 다음 사람이 그것을 새 자리에 세워
 * B1 이 없앤 다섯 번째 어휘를 되살린다(design.md §4: 닿지 않는 것을 남기지 않는다).
 *
 * **들고 있던 판정은 잃지 않았다**: 어떤 상태가 사유를 글자로 받는지는 위
 * `runnerReason` 이 이어받았고, `needs_reissue` 가 빠지는 이유도 그 주석에 있다.
 */
