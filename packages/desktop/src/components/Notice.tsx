import { useAppStore } from '../state/appStore';

/**
 * 조용히 삼키면 안 되는 실패를 사람 앞에 세우는 자리(#178).
 *
 * 별도 컴포넌트인 이유: 알림을 만드는 곳(컨트롤러의 `openMessage`, 메시지의 "Copy link")과
 * 보여 주는 곳이 다르다. 만든 쪽이 각자 자기 자리에 그리면 화면마다 모양이 갈라지고,
 * 어떤 자리는 아예 안 그려서 실패가 사라진다 — 실제로 클립보드 실패가 그렇게 사라지면
 * 사람은 붙여넣기를 해 보고 나서야 안 됐다는 것을 안다.
 *
 * `role="alert"` 이라 스크린리더가 뜨는 즉시 읽는다. 닫기는 사람이 누른다 — 시간이 지나
 * 저절로 사라지면 자리를 비운 사이에 뜬 오류를 아무도 못 본다.
 */
export function Notice() {
  const notice = useAppStore((s) => s.notice);
  if (!notice) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-[13px] text-amber-900"
    >
      <span className="flex-1">{notice}</span>
      <button
        className="rounded px-1 text-amber-700 hover:bg-amber-100"
        aria-label="Dismiss notice"
        onClick={() => useAppStore.getState().set({ notice: null })}
      >
        ×
      </button>
    </div>
  );
}
