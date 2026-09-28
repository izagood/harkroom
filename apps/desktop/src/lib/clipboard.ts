/**
 * 클립보드에 담는 한 가지 방법. 원래는 `AgentsSettings.tsx` 안에만 있었고(#177), 코드
 * 블록에도 복사 버튼이 붙으면서 두 화면이 쓰게 되어 여기로 나왔다.
 *
 * ## 실패를 조용히 삼키지 않는다
 *
 * 삼키면 사람은 붙여넣기를 시도하고 나서야 안 됐다는 것을 알고, 그때는 어느 것을
 * 복사했는지도 잊는다(#178·#179 가 같은 말을 한다). 그래서 이 함수는 **무슨 일이
 * 일어났는지를 돌려주고**, 실패하기 전에 화면에 남은 길을 하나 열어 둔다 — 복사 대상이
 * 그려진 노드를 **선택 상태로 만들어** 사람이 ⌘C 를 누를 수 있게 한다.
 *
 * 화면 밖 textarea + `document.execCommand('copy')` 는 쓰지 않는다: 사람이 볼 수도
 * 선택할 수도 없는 노드를 곧바로 지우고, execCommand 는 복사에 실패해도 던지지 않고
 * `false` 만 돌려주므로 "복사됨"을 거짓으로 띄우게 된다.
 *
 * ## 문구를 여기서 정하지 않는다
 *
 * 결과만 돌려주고 사람에게 뭐라 말할지는 **부르는 쪽이 정한다.** 근거는
 * `MessageItem::copyToClipboard` 머리말이 이미 적어 둔 것이다 — *"손으로 복사할 길이
 * 대상마다 다르기 때문"*. 화면에 안 보이는 링크는 실패 문구에 링크 자체를 실어야 하고,
 * 화면에 그려져 있는 코드 블록은 "선택해 뒀으니 ⌘C" 가 맞는 말이다. 문구를 이 파일에
 * 박으면 그 차이가 사라진다.
 */
export type CopyOutcome =
  /** 클립보드에 들어갔다. 사람이 더 할 일이 없다. */
  | 'copied'
  /** 클립보드는 못 썼지만 대상을 선택해 뒀다 — 남은 일은 ⌘C 한 번이다. */
  | 'selected'
  /** 클립보드도 선택도 못 했다. 남은 길은 손으로 옮겨 적는 것뿐이다. */
  | 'manual';

/**
 * `text` 를 클립보드에 담는다. `target` 은 그 텍스트가 **그려진 노드**다 — 클립보드가
 * 막혔을 때 선택해 줄 대상이므로, 복사할 문자열과 다른 노드를 넘기면 사람은 엉뚱한
 * 것을 선택한 채 ⌘C 를 누른다.
 */
export async function copyText(text: string, target?: HTMLElement | null): Promise<CopyOutcome> {
  // 비보안 컨텍스트에서는 브라우저가 `navigator.clipboard` 를 아예 노출하지 않는다 —
  // 그래서 `isSecureContext` 를 따로 보지 않고 존재 여부만 본다.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      // 권한 거부 등 → 아래 선택 경로로 내려간다. 성공했다고 하지 않는다.
    }
  }
  const selection = window.getSelection?.();
  if (target && selection) {
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    return 'selected';
  }
  return 'manual';
}
