import { splitCode } from './code';

/**
 * 긴 메시지를 접을지 정한다(#217).
 *
 * 기준은 **줄 수가 아니라 높이**다. 줄 수로 재면 코드 블록(#216) 열 줄이 든 메시지와
 * 같은 줄 수의 평문이 같은 값을 받는데, 화면에서 먹는 세로는 전혀 다르다. 반대로 80자를
 * 훌쩍 넘는 한 줄은 줄 수로는 1 이지만 실제로는 여러 줄로 감긴다.
 *
 * 그런데 실제 픽셀 높이는 렌더 뒤에만 알 수 있고 **jsdom 에는 레이아웃 엔진이 없다** —
 * `scrollHeight > clientHeight` 로 넘침을 재는 코드는 테스트에서 언제나 `0 > 0` 을 보고,
 * 그러면 "접히지 않았다" 가 영원히 초록으로 통과한다. #187 이 그 함정을 이미 밟았다
 * (폭 0 만 확인하는 테스트가 실제로는 접히지 않는 사이드바를 통과시켰다).
 *
 * 그래서 본문 문자열만으로 높이를 **추정**한다. 자르는 것은 CSS `max-height` 가 하고,
 * 추정값은 "접을 대상인가" 만 정한다. 두 일을 나눠 두면 추정이 어긋나도 실패 방향이
 * 안전하다 — 덜 접히는 것으로 끝나고, 말없이 잘리는 쪽으로는 갈 수 없다(MessageBody 가
 * 자르기와 "더 보기" 를 같은 조건 하나에 묶는다).
 */

/** 한 줄이 대략 몇 글자에서 감기는가. 메시지 열 폭과 본문 글꼴에서 나온 어림값이다. */
const CHARS_PER_LINE = 80;
/** 평문 한 줄이 먹는 세로(px). */
const TEXT_LINE_PX = 24;
/** 코드 한 줄이 먹는 세로(px). 본문보다 글자가 작고 행간이 좁다(text-[0.9em]). */
const CODE_LINE_PX = 20;
/** 코드 블록의 테두리와 언어 머리글이 먹는 세로(px). */
const CODE_BLOCK_CHROME_PX = 28;

/**
 * 접었을 때 남기는 높이(px). MessageBody 가 이 값을 그대로 `max-height` 로 쓴다 —
 * 값이 한 곳에만 있어야 "자른 높이" 와 "판정에 쓴 높이" 가 어긋나지 않는다.
 */
export const COLLAPSED_MAX_PX = 320;

/**
 * 이 높이를 넘을 때만 접는다. `COLLAPSED_MAX_PX` 를 그대로 문턱으로 쓰면 340px 짜리
 * 메시지가 20px 를 감추려고 "더 보기" 를 달게 된다 — 감춘 분량보다 버튼이 더 시끄럽다.
 */
export const COLLAPSE_THRESHOLD_PX = 480;

/** 개행과 감김을 모두 세어 시각적 줄 수를 낸다. 빈 줄도 한 줄을 먹는다. */
function wrappedLines(text: string): number {
  return text
    .split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0);
}

/**
 * 본문이 그려질 높이를 px 로 추정한다. 코드 블록은 자기 줄 수만큼, 평문은 감김까지
 * 세어 더한다. 인라인 코드는 흐름 안에 있으므로 앞뒤 평문과 한 덩어리로 센다 —
 * 조각마다 한 줄로 세면 인라인 코드가 여럿인 한 줄짜리 메시지가 몇 줄로 부풀어 오른다.
 */
export function estimateBodyHeight(body: string): number {
  let px = 0;
  let flow = '';
  const flushFlow = () => {
    if (flow) px += wrappedLines(flow) * TEXT_LINE_PX;
    flow = '';
  };
  for (const seg of splitCode(body)) {
    if (seg.kind === 'codeBlock') {
      flushFlow();
      // 코드는 감기지 않고 가로로 스크롤한다(MessageBody) — 줄 수가 그대로 높이다.
      px += seg.code.split('\n').length * CODE_LINE_PX + CODE_BLOCK_CHROME_PX;
      continue;
    }
    flow += seg.kind === 'inlineCode' ? seg.code : seg.text;
  }
  flushFlow();
  return px;
}

/** 접을 대상인가. 자기가 쓴 메시지도 예외가 없다 — 본문 말고는 아무것도 보지 않는다. */
export function shouldCollapse(body: string): boolean {
  return estimateBodyHeight(body) > COLLAPSE_THRESHOLD_PX;
}
