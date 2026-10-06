import { useEffect } from 'react';
import { getController } from '../state/controller';
import { useActiveStore } from '../state/communities';
import { useT } from '../i18n/useT';

/** 토스트가 떠 있는 시간(designer 흐름 시안 b9e52c00). */
export const SAVE_TOAST_MS = 4000;

/**
 * 첨부를 저장했다는 **아래쪽** 토스트 — 「Downloads에 rc68-SUMMARY.md 저장함 · Finder에서 보기」.
 *
 * 왜 Notice 가 아닌가: Notice 는 실패 자리다(경고색, 사람이 ×를 눌러야 사라진다 — `Notice.tsx` 머리 주석).
 * 저장 성공을 거기 실으면 창 맨 위를 덮고 손으로 치워야 한다. 그렇다고 아무 말도 없으면 어디에 저장됐는지
 * Finder 를 열어 찾아야 했다(이번 수정의 출발점). 그래서 4초 뒤 저절로 사라지는 `role="status"` 다.
 *
 * 폴더 이름은 Rust 가 저장한 경로에서 뽑은 **실제** 폴더다 — 저장 창에서 사람이 위치를 바꿨을 수 있으므로
 * "다운로드에"라고 단정하지 않는다.
 */
export function SaveToast() {
  const t = useT();
  const toast = useActiveStore((s) => s.saveToast);
  useEffect(() => {
    if (!toast) return;
    const id = toast.id;
    const timer = setTimeout(() => {
      // 그 사이 새 토스트가 떴으면 그것을 지우지 않는다.
      if (useActiveStore.getState().saveToast?.id === id) useActiveStore.getState().set({ saveToast: null });
    }, SAVE_TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  const token = toast.token;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div
        role="status"
        data-testid="save-toast"
        className="pointer-events-auto flex max-w-full items-center gap-3 rounded-row bg-fg px-3 py-1.5 text-body text-surface shadow-lg"
      >
        <span className="min-w-0 truncate">{t('attachment.saved', { name: toast.name, folder: toast.folder })}</span>
        {token !== null && (
          <button
            type="button"
            className="shrink-0 rounded-sm px-1 font-semibold text-accent hover:underline"
            onClick={() => void getController().revealSavedAttachment(token)}
            data-testid="save-toast-reveal"
          >{t('attachment.revealInFinder')}</button>
        )}
      </div>
    </div>
  );
}
