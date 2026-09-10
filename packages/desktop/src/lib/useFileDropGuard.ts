import { useEffect } from 'react';
import { isFileDrag } from './fileDrag';

/**
 * 컴포저 **밖**에 떨어진 파일이 앱을 갈아치우지 못하게 막는다.
 *
 * ## 왜 필요한가
 *
 * 웹뷰의 기본 동작은 "떨어진 파일을 연다" 다 — 즉 지금 떠 있는 앱 화면 자리에 그 파일을
 * 띄운다. murmur 는 SPA 이므로 그 순간 화면·초안·소켓이 통째로 사라지고, 돌아오는 길은
 * 앱을 다시 켜는 것뿐이다. 컴포저는 자기 위에 떨어진 것만 막을 수 있고, 사람 손은 자주
 * 조금 빗나간다(메시지 목록, 사이드바, 스레드 패널).
 *
 * ## 왜 창(window)에 다는가
 *
 * React 의 리스너는 루트 컨테이너에 붙으므로 컴포저의 `onDrop` 이 **먼저** 지나간다.
 * 여기서는 기본 동작만 걷어낸다 — 전파를 끊지 않으므로 첨부 경로는 그대로 산다.
 *
 * ## 왜 파일일 때만인가
 *
 * 글자 드래그까지 막으면 컴포저 안에서 글을 끌어 옮기는 평범한 동작이 죽는다
 * (`isFileDrag` 의 주석).
 */
export function useFileDropGuard(): void {
  useEffect(() => {
    // dragover 를 막지 않으면 브라우저는 drop 자체를 주지 않는다 — 둘은 한 쌍이다.
    const over = (e: DragEvent): void => { if (isFileDrag(e.dataTransfer)) e.preventDefault(); };
    const drop = (e: DragEvent): void => { if (isFileDrag(e.dataTransfer)) e.preventDefault(); };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);
}
