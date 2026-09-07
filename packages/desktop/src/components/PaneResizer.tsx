import { useCallback, useEffect, useRef } from 'react';
import { MIN_ROOM_LEFT } from '../lib/prefs';

/** 화살표 한 번에 구분선이 움직이는 거리. 사이드바 손잡이와 같은 보폭이다. */
const STEP = 10;

/**
 * 패널의 **왼쪽 가장자리**에 서는 세로 구분선. 끌면 그 패널이 넓어지거나 좁아진다.
 *
 * 사이드바(`Sidebar.tsx`)에도 같은 손잡이가 있지만 계산이 다르다 — 사이드바는 창의 왼쪽
 * 가장자리에 붙어 있어 `clientX` 가 곧 폭이다. 스레드·터미널은 **오른쪽**에 붙어 있어서
 * 그 식이 통하지 않는다: 왼쪽으로 갈수록 폭이 커지고, 기준점도 창이 아니라 앞에 선
 * 패널들의 폭에 따라 움직인다. 그래서 여기서는 `mousedown` 순간의 폭과 좌표를 원점으로
 * 잡고 **이동량**만 더한다. 원점을 쓰면 창 크기·형제 패널의 폭을 몰라도 정확하다.
 *
 * 사이드바를 이 컴포넌트로 갈아끼우지는 않았다. 사이드바는 접힘(폭 0)과 얽혀 있어서
 * 같은 부품으로 묶으려면 그쪽 규약(`collapsed` 면 손잡이를 그리지 않는다)까지 이 안으로
 * 들어와야 한다 — 부품이 두 화면의 사정을 다 알게 되는 쪽이 더 나쁘다.
 *
 * **위치는 부모가 잡는다**: 부모 패널이 `relative` 여야 하고, 이 손잡이는 그 안에서
 * `absolute left-0` 으로 선다. 폭 계산도 `parentElement` 를 부모 패널로 읽으므로,
 * 이 컴포넌트는 반드시 폭을 지는 그 요소의 **직계 자식**이어야 한다.
 */
export function PaneResizer({ label, width, min, max, onWidth }: {
  /** 접근성 이름. "무엇의" 너비인지 사람이 읽을 수 있어야 한다. */
  label: string;
  width: number;
  min: number;
  max: number;
  onWidth: (next: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  /** 드래그 원점. `null` 이면 끌고 있지 않다. */
  const origin = useRef<{ x: number; width: number; max: number } | null>(null);

  /**
   * 이 패널이 커질 수 있는 진짜 상한. 상수(`max`)와 **왼쪽에 남은 자리** 중 작은 쪽이다
   * — `MIN_ROOM_LEFT` 의 근거는 `prefs.ts` 에 적어 뒀다.
   *
   * jsdom 에는 레이아웃 엔진이 없어 모든 사각형이 0 이다. 그때 이 식을 그대로 쓰면 상한이
   * 음수가 되어 **모든 드래그가 최소 폭으로 붙는다** — 그래서 줄의 폭이 0 이면 기하
   * 제약을 걸지 않는다(측정할 것이 없다는 뜻이므로).
   */
  const roomBound = useCallback((): number => {
    const pane = ref.current?.parentElement ?? null;
    const row = pane?.parentElement ?? null;
    if (!pane || !row) return max;
    const rowRect = row.getBoundingClientRect();
    if (rowRect.width === 0) return max;
    const paneRect = pane.getBoundingClientRect();
    const roomLeft = paneRect.left - rowRect.left;
    return Math.min(max, Math.max(min, paneRect.width + roomLeft - MIN_ROOM_LEFT));
  }, [max, min]);

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const o = origin.current;
      if (!o) return;
      // 왼쪽으로 끌면(clientX 감소) 넓어진다 — 패널이 구분선의 오른쪽에 있으므로.
      const next = o.width - (e.clientX - o.x);
      onWidth(Math.max(min, Math.min(o.max, next)));
    };
    const onUp = (): void => {
      origin.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // 드래그 도중 언마운트되면 `mouseup` 을 받을 리스너가 사라져 body 의 cursor·
      // userSelect 가 영구히 남는다(#372 에서 사이드바가 같은 값을 치렀다).
      if (origin.current) onUp();
    };
  }, [min, onWidth]);

  const onMouseDown = (e: React.MouseEvent): void => {
    // preventDefault 와 userSelect 는 서로 다른 것을 막는다(#372): 전자는 mousedown 의
    // 기본 동작인 "선택 시작"을, 후자는 드래그 중 다른 경로로 새 선택이 생기는 것을 막는다.
    e.preventDefault();
    origin.current = { x: e.clientX, width, max: roomBound() };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  /** 화살표는 **구분선을 그 방향으로** 움직인다 — 왼쪽 화살표면 패널이 넓어진다. */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowLeft' ? STEP : -STEP;
    onWidth(Math.max(min, Math.min(roomBound(), width + delta)));
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      /* 눌리는 띠는 보이는 선(1px `border-l`)보다 넓다 — 1px 을 정확히 겨냥하게 만들면
         기능이 있어도 못 쓴다. 왼쪽으로 살짝 물려(`-left-0.5`) 선 위에 걸치게 둔다. */
      className="absolute -left-0.5 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent focus:bg-accent"
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    />
  );
}
