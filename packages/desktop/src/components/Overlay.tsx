import { useEffect, useRef, useState, type ReactNode } from 'react';

/** 열려 있는 오버레이의 순서. 맨 뒤가 가장 나중에 열린 것이다. */
const STACK: object[] = [];

/**
 * 스크림 + Esc + 바깥 클릭을 한 자리에서 정한다(계획 Task 10 Step 5).
 *
 * ## 왜 프리미티브인가 — Esc 가 조용히 안 먹던 자리
 *
 * `Directory`·`Inbox`·`Saved` 는 각자 **패널 div 의 `onKeyDown`** 으로 Esc 를 받고 있었다.
 * 그것은 **포커스가 패널 안에 있을 때만** 도는 핸들러다. 열자마자는 검색 입력이
 * `autoFocus` 라 우연히 동작하지만, 결과를 한 번 클릭하거나 패널 여백을 누르는 순간
 * 포커스가 문서로 빠져 **Esc 가 조용히 죽는다.**
 *
 * 계획서가 "Directory 는 Esc 로 안 닫힌다"고 실측한 것이 이 상태였다 — 재현이 조건부라
 * 버그로 보이지 않았을 뿐이다. `SearchPalette` 만 document 리스너를 써서 늘 닫혔다.
 *
 * 그래서 **document 리스너 하나**로 통일한다. 세 화면이 같은 규칙을 쓰면 한쪽만 고쳐지는
 * 갈라짐도 없어진다.
 *
 * ## 겹쳐 열려도 하나만 닫힌다
 *
 * 오버레이가 둘 이상 열려 있으면 **가장 나중에 열린 것만** Esc 를 받는다. 전부 닫으면
 * 사람이 하나를 닫으려던 조작이 화면 전체를 지운다.
 *
 * ## 모달이다 — 포커스가 안에 머물고, 닫히면 돌아간다
 *
 * 스크림이 뒤를 가리는데 Tab 이 뒤로 새면, 키보드로 쓰는 사람은 보이지 않는 버튼을 누른다.
 * 그래서 세 가지를 한다(맨 위 오버레이만):
 *
 * 1. `aria-modal="true"` — 스크린리더가 뒤 문서를 읽지 않는다.
 * 2. **Tab 가둠** — 마지막 다음은 처음, 처음 앞은 마지막. 안에 포커스가 없으면 열릴 때
 *    패널 자체가 받는다(소비자가 먼저 옮겼으면 — 확인창의 취소, 검색 입력 — 그대로 둔다).
 * 3. **닫히면 연 자리로 복귀** — 열기 직전 포커스(보통 `⋯` 나 연 버튼)로 돌려준다. 안 하면
 *    포커스가 `body` 로 떨어져 사람은 목록 어디에 있었는지 잃는다.
 *
 * 연 자리는 **첫 렌더에서** 잡는다. effect 에서 잡으면 늦다 — 자식의 effect 가 먼저 돌아서
 * (예: `ConfirmDialog` 가 취소 버튼에 포커스) 그때의 활성 요소는 이미 겹창 안이다.
 */
export function Overlay({ label, onClose, children, className = 'w-[42rem]', align = 'start' }: {
  /** 접근성 이름. `role="dialog"` 에는 이름이 있어야 스크린리더가 무엇이 열렸는지 말한다. */
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** 패널 폭 등 자리별 차이. 스크림·모서리·배경은 공통이다. */
  className?: string;
  /**
   * 세로 정렬. 기본은 `start` 다 — 첫 소비자들(Directory·Inbox·Saved·검색)은 목록이라
   * 내용 높이가 열려 있고, 그런 패널을 가운데 두면 항목이 늘 때마다 창이 위아래로 자란다.
   *
   * `center` 는 **높이가 정해진 작은 창**을 위한 것이다. 확인창처럼 한 문장을 묻는 패널을
   * 화면 맨 위에 붙여 두면, 방금 누른 버튼에서 멀어진 데다 시선이 가야 할 곳이
   * 스크림의 가장자리가 된다.
   */
  align?: 'start' | 'center';
}) {
  /**
   * **스택의 맨 위만 Esc·Tab 을 받는다.** `preventDefault` 로는 안 된다 — 같은 대상에 걸린
   * 형제 리스너는 그것과 무관하게 전부 돌기 때문이다(실측). 그래서 열린 순서를 모듈
   * 스코프 배열로 들고, 자기가 맨 위일 때만 움직인다.
   *
   * 토큰은 마운트 한 번에 하나다. `onClose` 가 바뀔 때마다 새로 넣으면, 아래 깔린
   * 오버레이가 다시 그려지는 순간 맨 위로 올라와 Esc 를 가로챈다.
   */
  const [token] = useState(() => ({}));
  // 연 자리. 첫 렌더에서 잡는다(머리말 "모달이다" 3).
  const [opener] = useState<Element | null>(() => (typeof document === 'undefined' ? null : document.activeElement));
  const panelRef = useRef<HTMLDivElement>(null);
  const isTop = (): boolean => STACK[STACK.length - 1] === token;

  useEffect(() => {
    STACK.push(token);
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();

    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !isTop() || !panel) return;
      const items = focusables(panel);
      const active = document.activeElement;
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = active instanceof Node && panel.contains(active);
      if (e.shiftKey && (!inside || active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onTab);
    return () => {
      document.removeEventListener('keydown', onTab);
      const i = STACK.indexOf(token);
      if (i >= 0) STACK.splice(i, 1);
      // 연 자리가 아직 문서에 있을 때만 돌려준다 — 지워진 행으로 보내면 포커스가 허공에 뜬다.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
    // 토큰·연 자리는 마운트 동안 고정이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (!isTop()) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  return (
    <div
      className={`fixed inset-0 z-40 flex justify-center bg-black/60 p-8
                  ${align === 'center' ? 'items-center' : 'items-start'}`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        // 안에 포커스할 것이 없을 때 패널이 받는다(Tab 가둠). 받은 표시는 그리지 않는다 —
        // 사람이 누를 수 있는 것이 아니다.
        tabIndex={-1}
        // 크기를 안 적는다 — 겹창도 앱 기본값(본문단 13px)을 그대로 물려받는다.
        // 여기 14px 을 박아 두면 겹창 안만 한 단 큰 화면이 되고, 그것이 이 저장소가
        // 어휘를 둘로 갈랐던 방식이다.
        className={`flex max-h-full flex-col overflow-hidden rounded-lg border border-border
                    bg-surface-raised text-fg outline-none ${className}`}
        // 패널 안의 클릭이 스크림까지 올라가면 무엇을 눌러도 닫힌다.
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Tab 이 들를 수 있는 것들, 문서 순서대로. */
function focusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true');
}
