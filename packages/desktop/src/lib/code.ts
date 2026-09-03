/**
 * 본문에서 **코드만** 떼어낸다(#216). 마크다운 전체가 아니다 — 에이전트 출력에서 가치가
 * 가장 크면서 렌더링 표면이, 따라서 공격 표면도 가장 작은 것이 코드다.
 *
 * 이 함수가 사슬의 **맨 앞**에 있는 것이 요점이다. 멘션·링크(#214)보다 먼저 raw 본문을
 * 나눠야 코드가 우선권을 갖는다. 순서가 뒤집히면 코드 블록 안의 URL 이 이미 링크가 된
 * 뒤라 되돌릴 방법이 없다 — 코드는 코드다.
 *
 * 라이브러리를 쓰지 않는다. 마크다운 렌더러는 raw HTML 통과를 기본으로 켜 두는 경우가
 * 많고, 그 설정 하나가 "HTML 을 통과시키지 않는다"는 결정을 조용히 뒤집는다. 직접
 * 토크나이즈해서 React 엘리먼트로 넘기면 이스케이프는 React 가 보장한다.
 */
export type CodeSegment =
  /** 코드가 아닌 부분. 여기에만 멘션·링크 인식을 얹는다. */
  | { kind: 'plain'; text: string }
  /** 백틱 하나로 감싼 것. */
  | { kind: 'inlineCode'; code: string }
  /** 백틱 세 개로 감싼 것. `lang` 은 **표시용일 뿐** — 문법 강조는 하지 않는다. */
  | { kind: 'codeBlock'; code: string; lang: string | null };

/**
 * 펜스 줄. 줄 전체가 펜스여야 한다 — `see ```x``` here` 처럼 문장 안에 섞인 것은 펜스가
 * 아니다. 여는 줄의 나머지는 언어 표시로 읽는다.
 */
const FENCE_LINE = /^[ \t]*```([^\n`]*)$/;

/**
 * 인라인 코드. 개행을 넘지 않는 것이 의도다 — 짝이 없는 백틱 하나가 뒤의 본문 전체를
 * 코드로 삼키면 메시지가 사라진 것처럼 보인다(펜스에서 같은 이유로 같은 결정을 한다).
 *
 * 앞뒤에 백틱이 더 붙어 있으면 집지 않는다. ```` ```x``` ```` 를 한 줄에 쓴 것은 인라인도
 * 블록도 아닌 애매한 입력이니, 애매한 것은 평문으로 둔다.
 */
const INLINE_CODE = /(?<!`)`([^`\n]+)`(?!`)/g;

/** 코드가 아닌 구간을 인라인 코드로 한 번 더 나눈다. */
function splitInline(text: string, out: CodeSegment[]): void {
  let cursor = 0;
  for (const m of text.matchAll(INLINE_CODE)) {
    if (m.index > cursor) out.push({ kind: 'plain', text: text.slice(cursor, m.index) });
    out.push({ kind: 'inlineCode', code: m[1]! });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) out.push({ kind: 'plain', text: text.slice(cursor) });
}

/**
 * 본문을 코드/비코드 구간으로 나눈다.
 *
 * **닫히지 않은 펜스는 코드가 아니다.** 열고 닫지 않은 것을 블록으로 그리면 그 뒤 본문
 * 전체가 코드가 되어 메시지가 통째로 사라진 것처럼 보인다. 그래서 닫는 줄을 먼저 찾고,
 * 없으면 여는 줄까지 평문으로 되돌린다.
 */
export function splitCode(body: string): CodeSegment[] {
  const out: CodeSegment[] = [];
  const lines = body.split('\n');
  let plainFrom = 0;
  let i = 0;

  const flushPlain = (until: number) => {
    if (until <= plainFrom) return;
    splitInline(lines.slice(plainFrom, until).join('\n'), out);
  };

  while (i < lines.length) {
    const open = FENCE_LINE.exec(lines[i]!);
    if (!open) { i += 1; continue; }

    // 닫는 줄을 찾는다. 언어 표시가 붙어 있어도 닫는 줄로 본다 — 두 번째 펜스가 나온
    // 시점에서 블록은 끝난 것이고, 그 뒤를 계속 코드로 두면 위 결정을 어기게 된다.
    let close = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (FENCE_LINE.test(lines[j]!)) { close = j; break; }
    }
    if (close === -1) { i += 1; continue; }

    flushPlain(i);
    const lang = (open[1] ?? '').trim();
    out.push({
      kind: 'codeBlock',
      code: lines.slice(i + 1, close).join('\n'),
      lang: lang.length ? lang : null,
    });
    i = close + 1;
    plainFrom = i;
  }
  flushPlain(lines.length);

  return out.length ? out : [{ kind: 'plain', text: body }];
}
