import { splitCode } from './code';

/**
 * 입력 중인 초안에서 **코드 구간이 어디인가**(사용자 요청, 2026-09-10 —
 * "채팅창에서도 인터랙티브하게 적용되도록").
 *
 * ## 판정을 여기서 다시 쓰지 않는다
 *
 * 무엇이 코드인지는 `splitCode` 하나가 정한다 — 메시지로 그려질 때(`MessageBody`),
 * 서버가 알림을 보낼 때(`mentionScanText`)와 **같은 함수**다. 컴포저가 자기 정규식으로
 * 백틱을 찾으면 규칙이 두 벌이 되고, 그 둘은 반드시 갈라진다: 입력창은 코드라고 칠했는데
 * 보낸 메시지는 평문이거나(닫히지 않은 백틱), 칠하지 않은 자리가 코드로 나온다. 그건
 * 강조가 아니라 **거짓말**이다 — #298 이 코드 안의 `@handle` 에서 없앤 그 거짓말이다.
 *
 * 이 파일이 하는 일은 그 판정에 **원문 위치를 얹는 것**뿐이고, 위치는 `splitCode` 가
 * 조각마다 들고 오는 `start`·`end` 를 그대로 옮긴다(계산하지 않는다).
 */

/** 코드 구간 하나. `text.slice(start, end)` 가 **백틱까지** 포함한 원문이다. */
export interface CodeMark {
  start: number;
  end: number;
  kind: 'inline' | 'block';
}

/** 초안의 코드 구간들. 앞에서 뒤로 정렬돼 있고 서로 겹치지 않는다. */
export function codeMarks(text: string): CodeMark[] {
  const out: CodeMark[] = [];
  for (const seg of splitCode(text)) {
    if (seg.kind === 'plain') continue;
    out.push({ start: seg.start, end: seg.end, kind: seg.kind === 'codeBlock' ? 'block' : 'inline' });
  }
  return out;
}

/** 겹판이 그리는 조각. `plain` 도 조각으로 남는 것이 요점이다(아래). */
export interface CodePiece {
  text: string;
  kind: 'plain' | 'inline' | 'block';
}

/**
 * 초안을 겹판이 그릴 조각으로 나눈다.
 *
 * **조각을 이어 붙이면 원문과 글자 하나까지 같다.** 그것이 이 함수의 계약이고
 * (`test/composerCodeMarks.test.ts` 가 잰다), 겹판이 입력칸과 **같은 자리에서 줄바꿈**하기
 * 위한 조건이다 — 글자 하나가 빠지거나 늘면 그 줄부터 칠이 밀려서, 칠한 자리와 글자가
 * 어긋난다. 그래서 조각을 `splitCode` 의 조각에서 직접 만들지 않고 **위치로 잘라** 만든다:
 * `splitCode` 의 평문 조각은 펜스 앞뒤의 개행을 품지 않아(줄 단위로 잘리므로) 이어 붙여도
 * 원문이 되지 않는다.
 */
export function codePieces(text: string): CodePiece[] {
  const out: CodePiece[] = [];
  let at = 0;
  for (const m of codeMarks(text)) {
    if (m.start > at) out.push({ text: text.slice(at, m.start), kind: 'plain' });
    out.push({ text: text.slice(m.start, m.end), kind: m.kind });
    at = m.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), kind: 'plain' });
  return out;
}

/** 토글 뒤의 초안과 선택 범위. 선택은 **코드 안쪽 글자**를 잡는다. */
export interface CodeToggle {
  text: string;
  start: number;
  end: number;
}

/**
 * 선택한 글을 코드로 감싸거나, 이미 코드면 **벗긴다**(⌘E / Ctrl+E).
 *
 * ## 왜 손으로 백틱을 치는 것 말고 이것이 필요한가
 *
 * 백틱은 한글 자판에서 조합 상태를 건드리는 자리에 있고(왼쪽 위), 감쌀 때는 **커서를 두 번
 * 옮겨야** 한다 — 앞에 하나, 끝에 하나. 그 사이에 자동완성이 열리거나 커서가 밀리면 짝이
 * 어긋나 백틱 하나만 남고, 그러면 `splitCode` 는 코드가 아니라고 판정한다(닫히지 않은 것은
 * 코드가 아니다). 고른 글을 한 번에 감싸는 것이 그 실패를 없앤다.
 *
 * ## 여러 줄은 펜스로 감싼다
 *
 * 인라인 코드는 **개행을 넘지 않는다**(`INLINE_CODE` 의 규칙, `[^`\n]+`). 그래서 여러 줄을
 * 고른 뒤 백틱 하나로 감싸면 아무것도 코드가 되지 않는다 — 사람은 눌렀는데 백틱만 두 개
 * 생긴 것을 본다. 파서의 규칙을 그대로 따라 여러 줄은 ``` 세 개로 감싼다.
 *
 * ## 벗기기의 경계
 *
 * 선택이 있으면 그 선택이 코드 구간 **안에 들어 있을 때** 벗긴다. 선택이 없으면
 * (커서만 있으면) 커서가 구간의 **안쪽**에 있을 때만이다 — 닫는 백틱 바로 뒤에서 누른 것은
 * "방금 쓴 코드를 벗기겠다"가 아니라 "여기서 새 코드를 열겠다"에 가깝다.
 */
export function toggleCode(text: string, from: number, to: number): CodeToggle {
  const empty = from === to;
  const inside = codeMarks(text).find((m) => (empty
    ? m.start < from && from < m.end
    : m.start <= from && to <= m.end));

  if (inside) {
    // 벗긴다. 인라인은 앞뒤 백틱 하나씩, 펜스는 **펜스 줄 자체**가 사라진다.
    const raw = text.slice(inside.start, inside.end);
    const body = inside.kind === 'inline'
      ? raw.slice(1, -1)
      : raw.split('\n').slice(1, -1).join('\n');
    return {
      text: text.slice(0, inside.start) + body + text.slice(inside.end),
      start: inside.start,
      end: inside.start + body.length,
    };
  }

  const selected = text.slice(from, to);

  // 고른 것이 없으면 빈 코드를 열고 그 **안에** 커서를 둔다 — 열어 놓고 커서를 밖에 두면
  // 이어 치는 글자가 코드 밖에 쌓인다.
  if (empty) {
    return { text: `${text.slice(0, from)}\`\`${text.slice(from)}`, start: from + 1, end: from + 1 };
  }

  if (!selected.includes('\n')) {
    return {
      text: `${text.slice(0, from)}\`${selected}\`${text.slice(to)}`,
      start: from + 1,
      end: to + 1,
    };
  }

  // 펜스는 **자기 줄을 독차지해야** 파서가 펜스로 읽는다(`FENCE_LINE`: 줄 전체가 펜스여야
  // 한다). 그래서 앞뒤가 줄머리·줄끝이 아니면 개행을 하나씩 보탠다. 고른 글의 마지막이
  // 이미 개행이면 더 넣지 않는다 — 블록 안에 빈 줄이 생긴다.
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const tail = after === '' || after.startsWith('\n') ? '' : '\n';
  const closeLead = selected.endsWith('\n') ? '' : '\n';
  const start = from + lead.length + 4;
  return {
    text: `${before}${lead}\`\`\`\n${selected}${closeLead}\`\`\`${tail}${after}`,
    start,
    end: start + selected.length,
  };
}
