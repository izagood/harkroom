/**
 * 에이전트 상세의 **저장 규칙**(designer A3, 스레드 c4f4dab4).
 *
 * 전에는 저장 방식이 다섯 가지였다 — 고정 [Save changes], 칸마다 [Save]·[Save list], 고르면 바로
 * 저장되는 칸, 대화상자. 글자를 치는 칸(이름·지시문·폴더·모델 목록)은 이제 한 저장 바로 모은다:
 * 칸이 자기 초안을 여기 **등록**하고, 바는 바뀐 것이 있을 때만 뜨고 그 수를 말한다.
 *
 * 칸은 자기 초안·저장 경로를 그대로 갖는다(서버 라우트가 다르다 — 이름·지시문은 `updateAgent`,
 * 폴더는 이 머신의 오퍼레이터 로컬 설정, 모델 목록은 `setAgentPickableModels`). 바는 그것들을
 * 차례로 부를 뿐이다. 등록할 바가 없으면(이 컨텍스트 밖에서 그려지면) 칸은 제 버튼을 그대로 쓴다.
 */
import { createContext, useContext, useEffect, useRef } from 'react';

export interface PendingHandlers {
  /** 저장한다. 실패하면 칸이 제 자리에 이유를 그리고 `false` 를 돌려준다. */
  save: () => Promise<boolean>;
  /** 마지막으로 읽은 서버 값으로 초안을 되돌린다. */
  revert: () => void;
}

/** `count` 는 이 칸에서 바뀐 것의 수. 0 이면 등록을 거둔다. */
export type RegisterPending = (key: string, count: number, handlers: PendingHandlers | null) => void;

export const PendingEditsContext = createContext<RegisterPending | null>(null);

/**
 * 칸이 제 초안을 저장 바에 건다. 돌려주는 값은 **바가 있는가** — 있으면 칸은 제 저장 버튼을
 * 그리지 않는다(같은 값을 저장하는 버튼이 두 곳에 서지 않게).
 *
 * 핸들러는 ref 로 최신 것을 넘긴다 — 매 렌더 새 함수를 등록하면 부모 상태가 매 렌더 바뀌어 돈다.
 */
export function usePendingEdit(key: string, count: number, save: () => Promise<boolean>, revert: () => void): boolean {
  const register = useContext(PendingEditsContext);
  const latest = useRef({ save, revert });
  latest.current = { save, revert };
  useEffect(() => {
    if (!register) return;
    register(key, count, count > 0 ? { save: () => latest.current.save(), revert: () => latest.current.revert() } : null);
  }, [register, key, count]);
  useEffect(() => () => { register?.(key, 0, null); }, [register, key]);
  return register !== null;
}

/**
 * 「바로 적용」 표지 — 고르는 즉시 서버에 걸리는 칸(호출 범위·머지 권한·PAT·사용 중지)의
 * 제목 옆에 선다. 저장 바가 생긴 뒤로 사람은 "저장을 눌러야 걸린다"를 기본으로 읽으므로,
 * 그렇지 않은 칸은 그 사실을 말해야 한다.
 */
export function ImmediateBadge({ label }: { label: string }) {
  return (
    <span data-testid="immediate-badge" className="ml-1.5 rounded-full border border-border px-1.5 text-meta font-normal text-fg-subtle">
      {label}
    </span>
  );
}

/**
 * 설정 화면을 떠나는 길(목차·← 뒤로)이 묻는 자리. 상세에 저장 안 한 변경이 있는 동안만 걸린다.
 * 설정 화면(`SettingsScreen`)과 에이전트 상세는 부모·자식이 아니라 컨텍스트로 잇지 않고 이 한 칸으로
 * 잇는다 — 걸린 것이 없으면 떠나는 길은 그대로 바로 간다.
 */
let leaveGuard: ((go: () => void) => void) | null = null;

export function setLeaveGuard(guard: (go: () => void) => void): () => void {
  leaveGuard = guard;
  return () => { if (leaveGuard === guard) leaveGuard = null; };
}

export function guardedLeave(go: () => void): void {
  if (leaveGuard) leaveGuard(go);
  else go();
}
