/**
 * 입력창 자동 높이(2026-10-21, jaebin 요청 — Slack 입력창처럼).
 *
 * 옛 입력창은 `rows`(기본 2줄)로 키가 못박혀 있었다. 길게 쓰면 두 줄 창 안에서 내내 위아래로
 * 굴려야 했다. 이제 칸은 **글 높이를 따라** 자라고, 상한(`COMPOSER_MAX_H`)에 닿으면 그때부터
 * 칸 안에서 굴러간다. 입력창은 화면 아래에 붙어 있으므로(목록이 위, 입력창이 아래인 세로 줄)
 * 키가 늘면 **위로** 커지고, 그만큼 메시지 목록이 줄어든다.
 *
 * - 바닥 키는 그대로다 — `rows` 가 정하는 최소 키 아래로는 줄지 않는다(`height:auto` 로 재면
 *   textarea 는 `rows` 만큼의 키를 낸다).
 * - 상한은 CSS 가 쥔다(`max-height`). 이 함수는 글 높이만 적고, 넘치면 CSS 가 잘라 굴리게 둔다 —
 *   창 크기가 바뀌면 vh 상한은 다시 계산할 것도 없이 따라온다.
 */

/**
 * 상한: **창 높이의 40%, 그러나 30rem(기본 글자 크기에서 480px) 넘게는 아니다.**
 * 40% 인 이유는 나머지 60% 에 대화가 남아야 무엇에 답하는지 보면서 쓰기 때문이다. rem 상한은
 * 큰 모니터에서 입력창이 화면을 덮는 것을 막는다(1440px 창에서 40% 는 576px — 한 화면을 다
 * 채우는 글은 거기서 굴려도 된다). 겹판(`ComposerCode`)과 같은 상자 안에 있으므로 겹판도 같이 큰다.
 */
export const COMPOSER_MAX_H = 'max-h-[min(40vh,30rem)]';

/**
 * 칸을 글 높이에 맞춘다. 그리기 전(`useLayoutEffect`)에 부른다.
 *
 * `height:auto` 로 한 번 접었다가 `scrollHeight` 를 읽는 흔한 방법이다. 그 접는 순간 textarea 의
 * `scrollTop` 이 0 으로 깎이므로(내용이 칸에 다 들어가 굴릴 곳이 없어진다) 되돌려 놓는다 —
 * 안 그러면 상한을 넘긴 글에서 한 글자 칠 때마다 칸이 맨 위로 튄다. 커서가 글 끝에 있으면 끝까지
 * 내린다: 새 줄을 친 그 순간에 커서 줄이 칸 아래로 숨지 않게.
 */
export function fitComposerHeight(el: HTMLTextAreaElement): void {
  const prevTop = el.scrollTop;
  el.style.height = 'auto';
  // 아직 배치되지 않은 칸(숨은 창·접힌 패널)은 0 을 잰다. 그 값을 적으면 키 0 으로 굳으니 비워 둔다 —
  // `rows` 가 정하는 바닥 키로 서고, 다음 글 변화나 폭 변화에 다시 잰다.
  if (el.scrollHeight === 0) {
    el.style.height = '';
    return;
  }
  // scrollHeight 는 테두리를 빼고 잰다. 상자가 border-box 라 테두리만큼 더해 줘야 마지막 줄이
  // 1~2px 잘려 굴림막대가 서는 일이 없다.
  const border = el.offsetHeight - el.clientHeight;
  el.style.height = `${el.scrollHeight + border}px`;
  const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
  el.scrollTop = atEnd ? el.scrollHeight : prevTop;
}
