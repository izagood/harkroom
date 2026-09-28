import { useEffect, useRef, type ReactNode } from 'react';
import { Overlay } from './Overlay';

/**
 * 되돌릴 수 없는 조작을 한 번 더 묻는 자리.
 *
 * ## 왜 인라인 확인이 아니라 겹창인가
 *
 * 메시지 삭제 확인은 원래 **호버 툴바 안**에서 'Really delete' / 'Keep' 두 버튼이
 * 이모지 버튼들 옆에 끼어드는 방식이었다. 세 가지가 동시에 무너진다:
 *
 * 1. **툴바가 자기 폭을 바꾼다.** 확인 버튼이 들어오면서 아이콘들이 왼쪽으로 밀려,
 *    방금 누른 `⋯` 자리에 다른 것이 와 있다. 커서 아래에서 버튼이 갈리는 배치다.
 * 2. **무엇을 지우는지 화면이 말하지 않는다.** 툴바는 행 우상단에 떠 있어서 본문과
 *    묶여 보이지 않는다 — 목록을 훑다가 두 번째로 누른 사람은 자기가 어느 메시지에
 *    확인을 준 것인지 모른다.
 * 3. **호버로 사라진다.** 툴바 자체가 `opacity-0 group-hover:opacity-100` 이라,
 *    확인을 띄워 놓고 커서가 행 밖으로 나가면 질문이 조용히 없어진다. 되돌릴 수 없는
 *    조작의 확인 단계가 마우스 위치에 달려 있으면 안 된다.
 *
 * 겹창은 셋을 한꺼번에 없앤다: 툴바를 건드리지 않고, 대상을 본문째 보여 주고,
 * 스크림이 다른 조작을 막아 커서를 어디로 옮기든 질문이 남는다.
 *
 * ## 기본 손가락은 '취소' 다
 *
 * 열리자마자 포커스는 **취소**로 간다. 되돌릴 수 없는 쪽에 포커스를 두면, 확인창을
 * 띄운 줄 모르고 Enter 를 친 사람이 그대로 지우게 된다 — 확인 단계를 둔 이유를
 * 확인창이 스스로 무너뜨리는 셈이다. Esc·바깥 클릭도 취소다(`Overlay` 가 맡는다).
 */
export function ConfirmDialog({ title, detail, confirmLabel, cancelLabel = 'Cancel', danger = false, onConfirm, onCancel }: {
  /** 무엇을 묻는지. `role="dialog"` 의 접근성 이름으로도 쓰인다. */
  title: string;
  /** 대상을 알아보게 하는 본문. 문자열이면 그대로, 노드면 그대로 그린다. */
  detail?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** 되돌릴 수 없는 조작인가. 확인 버튼의 색만 바꾼다 — 배치는 같다. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);

  return (
    <Overlay label={title} onClose={onCancel} align="center" className="w-[22rem]">
      <div className="flex flex-col gap-3 p-4">
        {/* 겹창 제목은 이름줄단 15px — 화면 제목단(17px)은 화면 하나를 여는 자리에만 준다
            (`Composer` 의 예약 겹창과 같은 규칙). */}
        <p className="text-name font-medium text-fg">{title}</p>
        {/* 대상 미리보기. 넘치면 잘린다 — 확인창은 메시지를 읽는 자리가 아니라
            "이것 맞나"를 알아보는 자리다. */}
        {detail !== undefined && (
          <div className="max-h-24 overflow-hidden rounded border border-border bg-surface-sunken px-2 py-1.5 text-fg-muted">
            {detail}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            /* 시험이 버튼을 **글자로 집지 않게** 이름을 준다 — 로케일 기본값이 바뀌면
               글자로 집은 줄이 이유 없이 빨개진다(사전 이관이 세운 규율). */
            data-testid="confirm-cancel"
            className="rounded px-3 py-1 text-fg-muted hover:bg-surface-sunken"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            data-testid="confirm-ok"
            className={danger
              ? 'rounded border border-danger-border bg-danger-surface px-3 py-1 font-medium text-danger hover:bg-danger-surface-strong'
              : 'rounded bg-accent px-3 py-1 font-medium text-fg-on-strong hover:bg-accent-hover'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
