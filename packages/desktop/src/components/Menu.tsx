import { useState, useRef, useEffect, useCallback, useLayoutEffect, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /**
   * 이 항목과 같은 일을 하는 단축키(#488 A1). 오른쪽 끝에 흐리게 선다.
   *
   * **아이콘 슬롯은 두지 않았다.** #488 문서가 계정 메뉴에서 12px 글리프를 "정보가 아니라
   * 장식"이라고 명시해 뺐고, 남긴 것은 `⌘,` 하나다 — 그것은 장식이 아니라 **가르치는
   * 정보**이기 때문이다(메뉴는 단축키를 가르치는 자리다). 그래서 프리미티브에도 가르치는
   * 쪽만 슬롯으로 낸다.
   *
   * 접근성 이름에서는 **빠진다** — `aria-hidden` 이다. 항목의 이름은 `Settings` 이지
   * `Settings ⌘,` 가 아니고, 스크린리더는 글리프를 "커맨드 콤마"로 읽지 못한다.
   */
  shortcut?: string;
}

/**
 * 트리거에 붙일 속성. 소비자가 자기 요소에 그대로 펼친다.
 *
 * **왜 프리미티브가 트리거를 직접 렌더하지 않는가**: 트리거 방식이 소비자마다 다르다.
 * 계정 메뉴(#113)는 클릭이고, 채널 컨텍스트 메뉴(#111)는 우클릭이다. 프리미티브가
 * `<button onClick>` 을 강제하면 #111 은 이것을 못 쓰고 메뉴를 다시 만들게 된다 —
 * 그 중복을 피하는 것이 이 프리미티브를 만든 이유다(#113 이슈가 그렇게 적었다).
 * 그래서 트리거 **요소**는 소비자가 만들고, 접근성 속성과 ref 는 여기서 준다.
 */
export interface MenuTriggerProps {
  ref: (el: HTMLElement | null) => void;
  onClick: () => void;
  /**
   * 우클릭으로 커서 위치에 연다(#111). `openOnContextMenu` 를 준 소비자에게만 넘어온다 —
   * 안 준 소비자에게는 `undefined` 라 우클릭 동작이 붙지 않는다.
   */
  onContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
}

interface MenuPosition {
  x: number;
  y: number;
}

interface MenuProps {
  /** 트리거 요소를 만든다. 받은 props 를 그 요소에 그대로 펼쳐라. */
  renderTrigger: (props: MenuTriggerProps) => ReactNode;
  items: MenuItem[];
  /**
   * 메뉴가 트리거의 위로 열릴지 아래로 열릴지. 기본은 위('top') 다 — 첫 소비자가
   * 사이드바 **푸터**라 아래로 열면 화면 밖으로 나간다. 커서 위치에 여는 것(#111)은
   * 이 열거형으로 표현되지 않는다 — 그 요구가 실제로 생길 때 좌표 기반 배치를 더한다
   * (지금 추측으로 만들면 틀린 추상이 된다).
   *
   * `openOnContextMenu` 로 열린 경우에는 이 값이 무시되고 커서 좌표가 쓰인다.
   */
  placement?: 'top' | 'bottom';
  /**
   * 우클릭 진입점을 켠다(#111). 좌표는 소비자가 주지 않는다 — `contextmenu` 이벤트의
   * `clientX`/`clientY` 를 쓴다. 초판은 `position?: MenuPosition` 이었는데 소비자가
   * `{x: 0, y: 0}` 같은 **무시되는 더미**를 넘겨야 했다. 값이 쓰이지 않는 데이터는
   * 플래그로 적어야 읽는 사람이 속지 않는다.
   */
  openOnContextMenu?: boolean;
  /**
   * 항목 위에 서는 머리(#488 A1). 계정 메뉴가 "지금 이게 누구인가"를 말해야 해서 생겼다 —
   * 얼굴 · 이름 · `@handle` · 어느 워크스페이스인지.
   *
   * **항목이 아니다.** `MenuItem` 으로 넣으면 눌리는 것이 되고 화살표 이동에도 걸린다 —
   * 머리는 읽는 것이지 고르는 것이 아니다. 그래서 `role="menuitem"` 밖에 둔다.
   */
  header?: ReactNode;
  className?: string;
}

/**
 * 항목의 포커스 표시(#488 B3). 정본 문서가 "시스템 파란 포커스 링"을 결함으로 적었고
 * 고친 모습을 **"포커스 링은 앱의 강조색이다"** 라고 못박았다.
 *
 * **`outline-none` 만 두면 안 된다.** 그것은 파란 링을 지우는 동시에 키보드로 옮기는
 * 사람에게서 "지금 어디에 있는지"를 통째로 빼앗는다 — 메뉴는 ↑/↓ 로 도는 자리라
 * 그 표시가 없으면 쓸 수 없는 것이 된다. 그래서 기본 링은 끄고 **`focus-visible` 에만**
 * 우리 링을 다시 켠다: 브라우저가 "이 포커스는 키보드에서 왔다"고 판정한 경우에만
 * 그리는 의사 클래스라, 마우스 클릭 뒤에 남던 사각형은 사라지고 화살표 이동에서는 선다.
 * `focus` 가 아니라 `focus-visible` 인 것이 이 결함의 핵심이다.
 *
 * 링은 안쪽에 그린다(`-outline-offset-1`). 항목은 메뉴 테두리에 가로로 꽉 차서, 바깥으로
 * 밀어낸 링은 메뉴 밖으로 잘려 나가고 위아래 항목끼리 겹친다.
 *
 * 색은 토큰(`outline-accent` → `--color-accent`)이다. 하드코딩한 색을 쓰면 라이트에서
 * 고른 값이 다크에서 안 맞는다 — 이 저장소가 색 이름을 화면 코드에서 없앤 이유가 그것이다.
 *
 * **`focus-visible:outline-solid` 가 왜 붙어 있는가**(빼면 링이 안 그려진다): Tailwind v4 의
 * `outline-none` 은 `--tw-outline-style: none` 을 남기고, `outline-2` 는 굵기만 정하면서
 * 스타일을 `outline-style: var(--tw-outline-style)` 로 그 변수에서 읽는다. 그래서 둘만
 * 쓰면 `focus-visible` 에서도 스타일이 `none` 으로 계산되어 2px 가 보이지 않는다.
 * 변수를 `solid` 로 되돌리는 한 클래스가 있어야 링이 실제로 선다.
 */
const MENU_ITEM_FOCUS = 'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-1';

/**
 * 이 요소를 실제로 **자르는** 위·아래 경계(뷰포트 좌표). 조상 중 세로로 잘라 내는
 * 상자(`overflow-y` 가 visible 이 아닌 것)를 모두 훑어 가장 좁은 구간을 남긴다.
 *
 * **뷰포트만 보면 안 되는 이유**: 메시지 메뉴가 사는 곳은 스레드 패널의
 * `flex-1 overflow-y-auto` 목록이고, 그 목록은 화면 바닥이 아니라 **작성칸 위**에서 끝난다.
 * 창 안에 들어가는 메뉴도 목록 밖으로 넘으면 잘려 나간다 — 마지막 메시지의 `⋯` 메뉴가
 * "Copy link" 중간에서 잘리던 것이 정확히 이 차이였다.
 *
 * `getBoundingClientRect` 를 못 쓰는 환경(jsdom 은 전부 0 을 준다)에서는 넘침이 계산되지
 * 않아 아무것도 뒤집히지 않는다 — 지금 동작 그대로다.
 */
function clipBounds(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY;
    if (overflowY === 'visible' || overflowY === '') continue;
    const r = p.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}

export function Menu({ renderTrigger, items, placement = 'top', openOnContextMenu = false, header, className = '' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [openAt, setOpenAt] = useState<MenuPosition | null>(null);
  /**
   * 요청한 방향이 잘려서 반대로 뒤집었나. **`placement` 를 덮어쓰지 않고 따로 둔다** —
   * 소비자가 준 방향은 "자리가 있으면 이쪽"이라는 뜻이라 그대로 남아야 하고, 메뉴가
   * 닫혔다 다시 열릴 때(다른 자리에서) 뒤집기는 처음부터 다시 재야 한다.
   */
  const [flipped, setFlipped] = useState(false);
  /**
   * 위아래 어느 쪽에도 안 들어갈 때 잘라 둘 높이(px). 넓은 쪽에 붙이고 남는 만큼만 보이게
   * 한 뒤 **메뉴 안에서 굴리게** 한다 — 잘려 나간 항목은 있는 줄도 모르지만, 굴러가는
   * 항목은 손이 닿는다. `null` 이면 제한 없음(대부분의 경우)이다.
   */
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback(() => {
    setOpen(false);
    setOpenAt(null);
    setFlipped(false);
    setMaxHeight(null);
    triggerRef.current?.focus();
  }, []);

  const enabledIndexes = items.flatMap((item, i) => (item.disabled ? [] : [i]));

  // 열리면 첫 활성 항목으로 포커스를 옮긴다 — 키보드로 연 사람이 곧바로 ↑/↓ 를 쓸 수 있어야
  // 하고, Escape·화살표 처리가 메뉴 안의 포커스에 달려 있다.
  useLayoutEffect(() => {
    if (!open) return;
    itemRefs.current[enabledIndexes[0] ?? 0]?.focus();
    // enabledIndexes 는 매 렌더 새 배열이라 의존성에 넣으면 매 렌더 재실행된다 — 열림 전이만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * 잘리는 쪽으로 열렸으면 반대쪽으로 뒤집고, 양쪽 다 모자라면 넓은 쪽에 붙여 굴린다
   * (하단 메시지의 `⋯` 메뉴가 목록 밑단에서 잘리던 결함).
   *
   * 그리기 **전**이 아니라 그린 **직후**에 잰다: 메뉴 높이는 항목 수·머리·번역 문구에
   * 따라 다르다. 좌표로 여는 경로(#111)는 아직 렌더 전이라 항목당 28px 로 어림하지만,
   * 여기서는 실제 상자를 쓸 수 있으니 어림하지 않는다. `useLayoutEffect` 라 페인트 전에
   * 자리가 정해져 — 메뉴가 아래에 그려졌다 위로 튀는 것이 사람 눈에 보이지 않는다.
   *
   * **열림 전이에서만 돈다.** 그래서 재는 시점의 방향은 언제나 소비자가 준 방향이고
   * (`close` 가 되돌린다), 뒤집은 뒤 다시 재지 않는다 — 다시 재면 양쪽 다 좁을 때
   * 두 방향을 오가며 흔들린다.
   *
   * 좌표로 연 경우는 건드리지 않는다 — 그쪽은 이미 창 안으로 잘라 넣고 `position: fixed`
   * 라 조상이 자르지도 않는다.
   */
  useLayoutEffect(() => {
    if (!open || openAt) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    const height = menu.getBoundingClientRect().height;
    // jsdom 은 모든 상자를 0 으로 준다 — 높이가 0 이면 잰 것이 없는 것이라 손대지 않는다.
    if (height === 0) return;
    const triggerRect = trigger.getBoundingClientRect();
    const clip = clipBounds(menu);
    // `mb-1`/`mt-1` 과 같은 4px. 뒤집힌 자리를 재는 값이라 클래스와 어긋나면 안 된다.
    const GAP = 4;
    const roomBelow = clip.bottom - triggerRect.bottom - GAP;
    const roomAbove = triggerRect.top - clip.top - GAP;
    const preferDown = placement === 'bottom';
    const preferred = preferDown ? roomBelow : roomAbove;
    const other = preferDown ? roomAbove : roomBelow;
    // 요청한 쪽에 들어가면 그대로 둔다 — 자리가 있는데 뒤집는 것은 소비자의 뜻을 어기는 것이다.
    if (height <= preferred) return;
    // 반대쪽에 들어가면 뒤집는다. 둘 다 모자라면 **넓은 쪽**으로 간다.
    const flip = height <= other || other > preferred;
    if (flip) setFlipped(true);
    const room = flip ? other : preferred;
    // 넓은 쪽에도 모자랄 때만 자른다. 너무 얇게 자르면 메뉴가 한 줄짜리 띠가 되므로
    // 최소 한 화면(항목 넷 남짓)은 남긴다 — 그만큼도 없는 자리면 어차피 굴려야 한다.
    if (height > room) setMaxHeight(Math.max(room, 132));
  }, [open, openAt, placement, items.length]);

  // 바깥 클릭으로 닫는다. document 리스너라 **네이티브** MouseEvent 다 — React 의 합성
  // 이벤트 타입을 쓰면 캐스트로 타입을 속이게 된다(초판이 그랬다).
  // 우클릭으로 여는 경우에도 이 리스너가 그 이벤트를 잡지 않는다 — 순서가 보장한다:
  // `mousedown`(button=2) 이 먼저 오고 `contextmenu` 가 뒤에 오는데, 메뉴는 후자에서
  // 열린다. 즉 여는 시점에는 이 리스너가 아직 붙어 있지 않다.
  //
  // 초판은 `e.button !== 0` 로 우클릭을 통째로 무시했는데, 그러면 메뉴가 열린 상태에서
  // **다른 곳을 우클릭해도 닫히지 않는다.** jsdom 은 `contextMenu` 만 발사해서 그
  // 차이가 테스트에 드러나지 않는다.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, close]);

  /** 메뉴 안에서의 키보드 이동. 항목 버튼에 직접 걸어 리스너 재부착을 피한다. */
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLElement>, index: number): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (!enabledIndexes.length) return;
    const at = enabledIndexes.indexOf(index);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = enabledIndexes[(((at === -1 ? 0 : at) + step) + enabledIndexes.length) % enabledIndexes.length]!;
    itemRefs.current[next]?.focus();
  };

  const triggerProps: MenuTriggerProps = {
    ref: (el) => { triggerRef.current = el; },
    onClick: () => setOpen((v) => !v),
    onContextMenu: openOnContextMenu
      ? (e: ReactMouseEvent<HTMLElement>) => {
          // 브라우저 기본 메뉴를 막는다.
          e.preventDefault();
          setOpen(true);
          setOpenAt({ x: e.clientX, y: e.clientY });
        }
      : undefined,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
  };

  /**
   * 좌표로 열렸을 때만 인라인 스타일을 쓴다. **좌표가 없으면 예전 Tailwind 클래스를
   * 그대로 둔다** — 초판은 두 경로를 모두 인라인 스타일로 바꾸면서 `left: 0`/`right: 0`
   * 을 새로 넣었고, 그건 기존 소비자(#113 계정 메뉴, #121 메시지 툴바)의 가로 정렬을
   * 바꾼다. 좌표를 안 준 소비자는 지금과 똑같이 동작해야 한다.
   *
   * 화면 밖으로 나가지 않게 자른다. 메뉴 높이는 항목 수에 따라 다르니 실제 높이를 재서
   * 자르는 것이 정확하지만, 여는 순간에는 아직 렌더되지 않았다. 항목 하나가 약 28px 이라
   * 항목 수로 어림한다 — 300px 같은 고정값은 항목 셋짜리 메뉴를 화면 아래에서
   * 불필요하게 위로 밀어 올린다.
   */
  const MENU_WIDTH = 128;
  const EDGE_GAP = 8;
  const menuStyle = openAt
    ? (() => {
        // 머리가 있으면 그만큼 더 높다(약 44px). 좌표로 여는 소비자(#111)는 아직 머리를
        // 쓰지 않지만, 어림값을 항목 수에만 매어 두면 다음 소비자가 조용히 화면 밖으로 나간다.
        const height = items.length * 28 + (header ? 44 : 0) + 8;
        const x = Math.max(EDGE_GAP, Math.min(openAt.x, window.innerWidth - MENU_WIDTH - EDGE_GAP));
        const y = Math.max(EDGE_GAP, Math.min(openAt.y, window.innerHeight - height - EDGE_GAP));
        return { position: 'fixed' as const, left: x, top: y };
      })()
    : undefined;

  // 뒤집기는 세로 방향만 바꾼다 — 가로 정렬(클래스 없음 = 정적 위치)은 그대로다.
  // 기존 소비자(#113 계정 메뉴, #121 메시지 툴바)가 잘리지 않는 자리에서는 `flipped` 가
  // 계속 false 라 지금과 한 픽셀도 다르지 않다.
  const effectivePlacement: 'top' | 'bottom' = flipped ? (placement === 'top' ? 'bottom' : 'top') : placement;

  return (
    <>
      {renderTrigger(triggerProps)}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
          className={`${openAt ? '' : `absolute ${effectivePlacement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'}`} z-10 min-w-32 rounded border border-border bg-surface-raised py-1 shadow-lg ${className}`}
          style={maxHeight == null ? menuStyle : { ...menuStyle, maxHeight, overflowY: 'auto' }}
        >
          {/*
            머리와 항목은 **같은 가로 축**에 선다 — 둘 다 `px-3` 이다. 항목만 넓히면
            (예: `px-4`) 이름이 머리의 이름보다 오른쪽으로 밀려 두 줄이 어긋나 보인다.
            좁아 보이던 것은 가로가 아니라 **세로**였다: 항목이 `py-1.5`(6px) 라 줄 높이가
            29px 밖에 안 됐고, 그래서 글자가 테두리에 눌린 것처럼 왼쪽 위로 쏠려 읽혔다.
            `py-2`(8px) 로 올려 33px 을 준다 — 머리(`pb-2 pt-1`)와 같은 8px 축을 쓰고,
            줄끼리 붙지 않으면서 네 줄짜리 메뉴가 길어지지도 않는 최소치다.
          */}
          {header && (
            <div className="border-b border-border px-3 pb-2 pt-1">{header}</div>
          )}
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(el) => { itemRefs.current[index] = el; }}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => { if (!item.disabled) { item.onSelect(); close(); } }}
              onKeyDown={(e) => onMenuKeyDown(e, index)}
              // 항목은 본문단(앱 기본값 13px), 단축키는 이미 아랫단 11px 이다 — 고르려면
              // 항목을 읽어야 하고 단축키는 한 번 배우면 안 읽는다.
              className={`flex w-full items-center gap-4 px-3 py-2 text-left ${MENU_ITEM_FOCUS} ${
                item.disabled ? 'cursor-not-allowed text-fg-subtle' : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
              }`}
            >
              <span>{item.label}</span>
              {item.shortcut && (
                <span aria-hidden="true" className="ml-auto text-meta text-fg-subtle">{item.shortcut}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
