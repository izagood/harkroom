import { useEffect, type ReactNode } from 'react';

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
 */
export function Overlay({ label, onClose, children, className = 'w-[42rem]' }: {
  /** 접근성 이름. `role="dialog"` 에는 이름이 있어야 스크린리더가 무엇이 열렸는지 말한다. */
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** 패널 폭 등 자리별 차이. 스크림·모서리·배경은 공통이다. */
  className?: string;
}) {
  useEffect(() => {
    /**
     * **스택의 맨 위만 Esc 를 받는다.** `preventDefault` 로는 안 된다 — 같은 대상에 걸린
     * 형제 리스너는 그것과 무관하게 전부 돌기 때문이다(실측). 그래서 열린 순서를 모듈
     * 스코프 배열로 들고, 자기가 맨 위일 때만 닫는다.
     */
    const token = {};
    STACK.push(token);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (STACK[STACK.length - 1] !== token) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = STACK.indexOf(token);
      if (i >= 0) STACK.splice(i, 1);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={label}
        className={`flex max-h-full flex-col overflow-hidden rounded-lg border border-border
                    bg-surface-raised text-sm text-fg ${className}`}
        // 패널 안의 클릭이 스크림까지 올라가면 무엇을 눌러도 닫힌다.
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
