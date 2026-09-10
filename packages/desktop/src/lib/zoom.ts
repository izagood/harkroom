/**
 * 화면 배율 — **글자만이 아니라 화면 전체를 키운다.**
 *
 * ## 왜 웹뷰 배율인가 (타이포 척도를 올리지 않는 이유)
 *
 * "글씨가 작다"는 요청에 `--text-*` 4단(`index.css`)을 올리는 것이 곧바로 떠오르지만, 그
 * 길은 화면을 깨뜨린다. Tailwind v4 의 여백·크기 유틸은 `--spacing`(rem) 기반이라 뿌리
 * 글자 크기를 따라가지만, 4단은 **px 리터럴**이고 화면에는 px 임의값이 39곳(`[62px]` 레일 ·
 * `[640px]` 스레드…), 패널 폭은 아예 JS 상수다(`sidebarWidth` 240 · `DEFAULT_THREAD_WIDTH`
 * 640 · `MIN_CHANNEL_WIDTH` 200). 글자만 커지면 그 전부가 제자리에 남아 밀도가 무너진다.
 *
 * 웹뷰 배율은 **CSS px 공간 자체**를 늘린다. 글자·여백·선·아이콘·패널 폭이 한 좌표계에서
 * 같이 커지므로 위의 상수를 하나도 건드리지 않아도 비율이 유지되고, `PaneResizer` 가 쓰는
 * `clientX`·`getBoundingClientRect` 도 같은 공간이라 드래그가 그대로 맞는다.
 *
 * ## 왜 `zoomHotkeysEnabled` 를 쓰지 않는가
 *
 * Tauri 창 설정에 `zoomHotkeysEnabled` 가 있고 macOS 에서는 폴리필로 `Cmd + [- = +]` 를
 * 잡아 준다. 쓰지 않는 이유는 **그것이 프런트엔드에 값을 알려주지 않기** 때문이다 — 20%
 * 씩 20~1000% 를 제 마음대로 오가므로 아래 단계표와 어긋나고, 설정 화면의 라디오는 100%
 * 인데 실제 화면은 140% 인 상태가 만들어진다. 단축키는 `Workspace` 의 전역 keydown 에서
 * 직접 잡아 `prefs.zoom` 을 고친다. 그래야 손잡이가 하나다: 설정 라디오와 단축키가 같은
 * 값을 읽고 같은 값을 쓴다.
 */

/**
 * 고를 수 있는 배율. Slack 의 표를 그대로 쓴다(요청자 확인, 2026-09-10).
 *
 * **슬라이더가 아니라 이산 목록인 이유**: 배율을 잘못 고르면 되돌릴 손잡이가 방금 작아진
 * 화면 어딘가에 있다. 칸이 아홉이면 몇 번 눌러 제자리로 오지만, 연속값은 "원래 얼마였나"
 * 를 사람이 기억해야 한다. 하한을 70% 에서 끊는 것도 같은 난간이다 — 그 아래로 내려가면
 * 설정 화면의 글씨 자체를 못 읽는다.
 */
export const ZOOM_STEPS: readonly number[] = [70, 80, 90, 100, 110, 125, 150, 175, 200];

/**
 * **웹뷰 배율이 1.0 인 칸.** `100` 이다 — 눈금이 말하는 100% 가 곧 "배율을 쓰지 않는다" 다.
 *
 * 한때 이 값이 90 이었다. 근거는 "본문단 13px 은 통상(Slack 15px)의 ~87% 라 지금 화면은
 * 이미 작다" 였고, 그래서 기본값 100% 가 배율 **1.111** 을 걸었다. 그 결정을 되돌린 이유:
 *
 * 1. **요청한 것과 다르다.** 사람이 원한 것은 *"조금 커진 상태가 앱의 기본"* 이고, 그 기본은
 *    앱 자신의 척도여야 한다 — 배율은 사람이 일부러 건드릴 때만 1 이 아니어야 한다.
 * 2. **기본값이 1 이 아니면 배율의 부작용을 전원이 안고 간다.** 실측 사고(2026-09-10):
 *    배율 1.111 에서 앱 레이아웃이 보이는 높이보다 ~11% 길어져 **입력창이 화면 밖으로
 *    나갔다**(창이 클수록 심했다). 그 잘림 자체는 `index.css` 의 뷰포트 고정으로 따로
 *    고쳤지만, 기본값에서 배율을 걸지 않는 것이 그 위험을 아예 없앤다.
 *
 * 화면을 키우는 일은 여기가 아니라 **앱의 척도**(`--text-*` 4단·`--spacing`)가 한다.
 */
export const BASELINE_ZOOM = 100;

/** 기본 배율. `BASELINE_ZOOM` 과 같은 칸이므로 **기본 상태에서는 배율을 쓰지 않는다.** */
export const DEFAULT_ZOOM = 100;

/**
 * 눈금(퍼센트)을 웹뷰가 받는 배율로 옮긴다. `BASELINE_ZOOM` 칸이 1.0 이다.
 *
 * 저장하는 값이 배율(1.111…)이 아니라 **눈금(100)** 인 이유: 저장본은 사람이 고른 것을
 * 담아야 한다. 배율로 저장하면 부동소수 비교가 라디오의 선택 표시를 흔들고, 나중에
 * 눈금 표를 고치는 날 저장된 값이 어느 칸이었는지 알 수 없게 된다.
 */
export function zoomFactor(step: number): number {
  return step / BASELINE_ZOOM;
}

/**
 * 저장본·외부에서 온 값을 눈금 하나로 좁힌다. 표에 없는 값은 **가장 가까운 칸**으로
 * 붙인다 — 표를 나중에 고치면 예전 기기에 남은 값이 표 밖이 되는데, 그것을 기본값으로
 * 되돌리면 150% 를 쓰던 사람이 업데이트 한 번에 100% 로 떨어진다. 가장 가까운 칸이면
 * 사람이 고른 뜻("크게 보고 있었다")이 살아남는다.
 */
export function normalizeZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ZOOM;
  let best = DEFAULT_ZOOM;
  for (const step of ZOOM_STEPS) {
    if (Math.abs(step - value) < Math.abs(best - value)) best = step;
  }
  return best;
}

/**
 * 지금 칸에서 한 칸 옮긴다(`direction` 은 +1 / -1). 양 끝에서는 **제자리에 머문다** —
 * 감싸 돌면 200% 에서 한 번 더 누른 사람이 70% 를 보게 되고, 그것은 누른 사람이 뜻한
 * 것과 정반대다.
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const here = normalizeZoom(current);
  const index = ZOOM_STEPS.indexOf(here);
  return ZOOM_STEPS[index + direction] ?? here;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface Internals {
  invoke?: Invoke;
  metadata?: { currentWindow?: { label?: string } };
}

function internals(): Internals | undefined {
  return (globalThis as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__;
}

/**
 * `@tauri-apps/api` 를 의존으로 들이지 않고 `__TAURI_INTERNALS__` 를 직접 쓴다 —
 * `lib/badge.ts` · `lib/notify.ts` · `lib/runnerLauncher.ts` 가 이미 이 규칙이고, 배율
 * 하나 때문에 깨면 Tauri 를 만지는 표면이 둘로 갈린다. 커맨드 이름과 인자는
 * `@tauri-apps/api` 의 `Webview.setZoom` 이 보내는 것과 같다.
 */
const ZOOM_COMMAND = 'plugin:webview|set_webview_zoom';

function windowLabel(): string {
  return internals()?.metadata?.currentWindow?.label ?? 'main';
}

/**
 * 배율을 웹뷰에 건다. Tauri 가 없으면(브라우저 dev · vitest) 조용히 넘긴다.
 *
 * 실패를 삼키는 이유: `set_zoom` 은 **macOS 11+ 에서만** 지원되고(Tauri 문서), 권한이
 * 빠진 구버전 번들에서도 거부된다. 배율은 부가 표시라 앱을 막으면 안 된다 — `badge.ts`
 * 가 같은 판단이다.
 *
 * **같은 값을 두 번 걸지 않는다.** 부르는 쪽이 스토어 구독이라 배율과 무관한 변화에도
 * 깨어나는데, 그때마다 IPC 를 왕복하면 설정을 한 번 만질 때마다 수십 번이 된다.
 */
export function createZoomer(): { apply(step: number): Promise<void> } {
  let applied: number | null = null;

  return {
    async apply(step) {
      const normalized = normalizeZoom(step);
      if (applied === normalized) return;
      const invoke = internals()?.invoke;
      if (typeof invoke !== 'function') return;
      applied = normalized;
      try {
        await invoke(ZOOM_COMMAND, { label: windowLabel(), value: zoomFactor(normalized) });
      } catch {
        // 다음 변화에서 다시 시도할 수 있게 기억을 지운다.
        applied = null;
      }
    },
  };
}
