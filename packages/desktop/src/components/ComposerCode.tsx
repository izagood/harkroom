import { useLayoutEffect } from 'react';
import { codePieces } from '../lib/codeMarks';

/**
 * 입력 중인 코드에 **입력칸 안에서** 코드 면을 깐다(사용자 요청, 2026-09-10).
 *
 * 사람이 `` `이렇게` `` 쓴 것은 보낸 뒤에는 코드로 그려지는데(`MessageBody`) 입력창에서는
 * 백틱 두 개가 붙은 평문이었다. 그래서 짝이 맞았는지, 어디까지 코드인지를 **보내 보고**
 * 알았다. 이 겹판이 그 확인을 입력 시점으로 옮긴다.
 *
 * ## 왜 textarea 를 놔두고 겹판을 깔았는가
 *
 * 글자를 직접 칠하려면 입력칸이 `contenteditable` 이어야 한다. 이 컴포저는 초안을
 * **문자열 하나**로 들고 커서 위치(`selectionStart`)로 멘션 후보를 계산하고, 붙여넣기·
 * 예약·보냄 취소가 모두 그 문자열 위에 서 있다(`Composer.tsx`). `contenteditable` 로
 * 바꾸면 그 전부가 DOM 조각을 다시 문자열로 만드는 일이 되고, 무엇보다 **한글 조합
 * 입력**이 React 의 제어 값과 싸운다(조합 중 글자가 튀거나 사라진다). 입력의 정확성은
 * 강조보다 앞이므로 입력칸은 손대지 않고, 뒤에 같은 글을 한 벌 더 그려 **면만** 깐다.
 *
 * ## 글자를 두 번 그리지 않는다
 *
 * 겹판의 글자는 투명이고(`text-transparent`) 보이는 글자는 여전히 입력칸의 것이다.
 * 흔한 구현은 반대로 한다(입력칸 글자를 투명하게 하고 겹판이 글자를 그린다) — 그러면
 * 글자 색·굵기까지 바꿀 수 있지만, 선택 영역을 칠할 때 입력칸의 선택 배경이 겹판 글자를
 * 덮어 **글자가 사라진 파란 띠**가 된다. 면만 깔면 그 대가가 없다.
 *
 * ## 그래서 고정된 제약: 자리를 옮기는 것은 아무것도 얹지 않는다
 *
 * 겹판은 입력칸과 **같은 자리에서 줄바꿈해야** 한다. 그래서 글꼴·크기·줄높이·여백·테두리
 * 굵기를 입력칸과 한 벌로 묶어 두고(`COMPOSER_BOX`), 코드 면에는 가로 여백을 주지 않는다 —
 * `px` 를 1px 만 얹어도 그 뒤의 글자가 밀려 다음 줄부터 칠이 어긋난다. 세로 여백은
 * 인라인 요소에서 줄 높이를 바꾸지 않으므로(그래서 면이 조금 넉넉해 보인다) 그것만 준다.
 *
 * 고정폭 글꼴을 주지 않는 것도 같은 이유다. 글자 폭이 달라지면 줄바꿈 자리가 갈린다 —
 * 코드를 고정폭으로 보는 것은 보낸 뒤 메시지의 몫이다.
 */

/**
 * 입력칸과 겹판이 **같이** 쓰는 상자 값. 한 곳에서 정하는 것이 요점이다 — 두 곳에 적으면
 * 한쪽만 고쳐지고, 그 순간 칠이 글자에서 밀린다(그 어긋남은 여백을 고친 사람 눈에는
 * 보이지 않는다: 짧은 한 줄에서는 티가 나지 않고 두 줄째부터 벌어진다).
 */
export const COMPOSER_BOX = 'rounded border px-3 py-2.5 leading-relaxed';

interface Props {
  /** 지금 초안. 입력칸에 들어 있는 것과 **같은 문자열**이어야 한다. */
  text: string;
  /** 입력칸. 스크롤 위치를 여기서 읽어 겹판에 옮긴다. */
  boxRef: React.RefObject<HTMLTextAreaElement | null>;
  /** 겹판. 스크롤을 맞출 대상이라 부모가 들고 있다(입력칸의 `onScroll` 이 부른다). */
  layerRef: React.RefObject<HTMLDivElement | null>;
}

export function ComposerCode({ text, boxRef, layerRef }: Props) {
  /*
    입력칸이 스크롤된 상태에서 글이 바뀌면(붙여넣기·전송·되돌리기) 겹판만 위에 남는다.
    그리기 직후에 한 번 맞춘다 — `onScroll` 은 사람이 굴릴 때만 오고, 값이 바뀌어서 생긴
    스크롤에는 오지 않는 경우가 있다.
  */
  useLayoutEffect(() => {
    const box = boxRef.current;
    const layer = layerRef.current;
    if (!box || !layer) return;
    layer.scrollTop = box.scrollTop;
  }, [text, boxRef, layerRef]);

  return (
    <div
      ref={layerRef}
      aria-hidden="true"
      data-testid="composer-code-layer"
      /*
        `pointer-events-none`: 겹판은 입력칸 위가 아니라 아래에 있지만(뒤에 그려진 입력칸이
        위로 온다), 그래도 손을 받지 않게 못박는다 — 나중에 z 순서가 바뀌어도 클릭이 글자
        대신 이 판에 떨어지지 않는다.

        `whitespace-pre-wrap break-words`: textarea 의 줄바꿈 규칙이다(공백·개행을 그대로
        두고 부드럽게 감싸며, 끊을 곳이 없는 긴 낱말은 잘라 넘긴다).

        `border-transparent`: 입력칸의 1px 테두리와 **같은 굵기**를 둔다. 테두리는 안쪽
        상자를 밀므로, 여기서 빼면 글자가 1px 씩 어긋난다.
      */
      className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words border-transparent text-transparent ${COMPOSER_BOX}`}
    >
      {codePieces(text).map((piece, i) => (
        piece.kind === 'plain'
          ? <span key={i}>{piece.text}</span>
          : (
            <span
              key={i}
              data-testid="code-mark"
              data-kind={piece.kind}
              /*
                보낸 뒤의 코드와 **같은 토큰**이다(`MessageBody` 의 인라인 코드·코드 블록이
                `bg-surface-sunken`). 입력창만의 색을 새로 고르면 같은 글이 보내기 전후로
                다른 색이 되고, 그건 "이게 코드다"가 아니라 "입력창이 뭔가 한다"로 읽힌다.

                `box-decoration-clone`: 줄을 넘긴 코드의 면이 조각마다 둥근 모서리를 갖게
                한다. 없으면 넘어간 조각이 각진 채로 잘려 면이 깨져 보인다.
              */
              className="box-decoration-clone rounded bg-surface-sunken py-0.5"
            >
              {piece.text}
            </span>
          )
      ))}
      {/*
        끝의 개행 하나는 **줄로 세지 않는다** — `pre-wrap` 은 마지막 개행 뒤의 빈 줄을
        만들지 않지만 textarea 는 만든다. 그 차이 때문에 초안이 개행으로 끝날 때 겹판의
        높이가 한 줄 짧아져 스크롤 위치가 어긋난다. 빈 글자 하나를 붙여 줄을 세운다.
      */}
      {text.endsWith('\n') ? '\u200b' : null}
    </div>
  );
}
