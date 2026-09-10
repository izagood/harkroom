import { splitCode } from './code';
import { classifyLink } from './link';
import { linkAt } from './markdown';

/**
 * 초안에 **하이퍼링크를 넣는 두 길**(사용자 요청, 2026-09-10 — "텍스트에 하이퍼링크 넣을
 * 수 있는 기능").
 *
 * ## 그리는 쪽은 이미 있었다
 *
 * `[글자](주소)` 는 #216 부터 메시지로 그려지고 눌러서 열린다(`MessageBody`). 없던 것은
 * **쓰는 쪽**이다: 대괄호·소괄호 넷을 손으로 치고 커서를 세 번 옮겨야 했고, 그동안 멘션
 * 자동완성이 열리거나 커서가 밀리면 짝이 어긋나 링크가 아닌 글자가 남았다. #728 이 백틱에서
 * 없앤 그 실패와 같은 것이고, 그래서 같은 모양으로 고친다 — 판정을 새로 쓰지 않고 열쇠
 * 하나(⌘K)와 붙여넣기 제안을 얹는다.
 *
 * ## 규칙은 여기서 새로 만들지 않는다
 *
 * - **무엇이 링크 문법인가**: `markdown.ts` 의 `linkAt` 하나다. 렌더러가 쓰는 그 함수다.
 * - **무엇이 코드인가**: `splitCode` 하나다(#728 과 같은 근거). 코드 안의 `[글자](주소)` 는
 *   보낸 뒤 링크가 아니므로 여기서도 링크가 아니다 — 예외 처리가 아니라 순서에서 따라온다.
 * - **무엇이 주소인가**: `classifyLink` 하나다(`lib/link.ts` 의 허용 목록). 고른 글을
 *   "주소"로 볼지 "이름"으로 볼지가 여기서 갈리므로, 그 판단이 실제로 열리는 것과 같아야
 *   한다. `example.com`(스킴 없음)은 주소가 아니라 이름이다 — 눌러도 열리지 않을 것을
 *   주소 자리에 넣으면 사람은 링크를 만들었다고 믿는다.
 */

/** 초안 안의 링크 문법 하나. `text.slice(start, end)` 가 `[글자](주소)` 전체다. */
export interface LinkMark {
  start: number;
  end: number;
  label: string;
  href: string;
}

/**
 * 초안의 링크 문법들. 앞에서 뒤로 정렬돼 있고 서로 겹치지 않는다.
 *
 * 코드 구간은 건너뛴다. 위치는 `splitCode` 가 평문 조각마다 들고 오는 `start` 에 얹어
 * 계산한다 — 코드가 어디까지인지를 이 파일이 다시 세지 않는다.
 */
export function linkMarks(text: string): LinkMark[] {
  const out: LinkMark[] = [];
  for (const seg of splitCode(text)) {
    if (seg.kind !== 'plain') continue;
    let i = 0;
    while (i < seg.text.length) {
      const m = linkAt(seg.text, i);
      if (!m) { i += 1; continue; }
      out.push({
        start: seg.start + i,
        end: seg.start + i + m.length,
        label: m.label,
        href: m.href,
      });
      i += m.length;
    }
  }
  return out;
}

/** 바꾼 뒤의 초안과 커서(또는 선택) 자리. `toggleCode` 와 같은 모양이다. */
export interface LinkEdit {
  text: string;
  start: number;
  end: number;
}

/**
 * 고른 글을 링크로 감싸거나, 이미 링크면 **벗긴다**(⌘K / Ctrl+K).
 *
 * ## 커서는 **비어 있는 자리**로 간다
 *
 * 감싼 직후에 사람이 채워야 하는 것은 하나뿐이고, 그것이 어느 쪽인지는 고른 글이 말한다:
 *
 * - 고른 것이 **주소**면 이름이 빈다 → `[](주소)`, 커서는 대괄호 안.
 * - 고른 것이 **이름**이면(또는 아무것도 안 골랐으면) 주소가 빈다 → `[이름]()`,
 *   커서는 소괄호 안 — 대개 주소는 클립보드에 있으므로 그대로 붙여넣으면 끝난다.
 *
 * 규칙이 하나(빈 자리로 간다)라서 두 경우를 따로 외울 것이 없다.
 *
 * ## 반쯤 만든 것도 링크로 다룬다
 *
 * `[이름]()` 은 주소가 없어 **아직 링크로 그려지지 않는다**(`MD_LINK` 는 빈 주소를 받지
 * 않고, 받는다 해도 `classifyLink` 가 막는다). 그래서 만드는 중의 초안은 화면에 평범한
 * 글자로 보이고, 그것이 맞다 — 열 수 없는 것을 링크처럼 보여 주면 거짓이다. 다만 ⌘K 를
 * 다시 누르면 벗겨져야 하므로 판정은 `linkAt`(문법) 기준이다. 빈 주소는 `linkAt` 이
 * 안 잡으므로, 그 상태에서 ⌘K 는 벗기기가 아니라 **바깥에 새 링크를 여는 것**이 된다 —
 * 만드는 중에 되돌리는 길은 되돌리기(⌘Z)다.
 *
 * ## 여러 줄은 링크가 되지 않는다
 *
 * 링크 이름은 개행을 넘지 못한다(`MD_LINK` 의 `[^\]\n]+`, 그리고 블록 구조가 줄 단위다).
 * 그래서 여러 줄을 고른 ⌘K 는 **`null`** 이다 — 감싸 봐야 링크가 아닌 대괄호만 남는다.
 * 부르는 쪽이 그 사실을 사람에게 말해야 한다(조용히 아무 일도 안 하면 앱이 멈춘 것으로
 * 읽힌다). 펜스로 우회하는 코드(`toggleCode`)와 갈리는 지점이다: 링크에는 여러 줄 형태가
 * 아예 없다.
 */
export function toggleLink(text: string, from: number, to: number): LinkEdit | null {
  const empty = from === to;
  // 선택이 있으면 그 선택이 링크 **안에 들어 있을 때** 벗긴다. 커서만 있으면 **안쪽**에
  // 있을 때만이다 — 닫는 괄호 바로 뒤에서 누른 것은 "방금 쓴 링크를 벗기겠다"가 아니라
  // "여기서 새 링크를 열겠다"에 가깝다(`toggleCode` 와 같은 경계).
  const inside = linkMarks(text).find((m) => (empty
    ? m.start < from && from < m.end
    : m.start <= from && to <= m.end));

  if (inside) {
    // 벗기면 **이름만** 남는다. 주소를 남기면 벗긴 자리에 맨 URL 이 서서 그것이 또
    // 링크가 되므로(맨 URL 도 링크다, #214) 누른 사람에게는 아무것도 안 벗겨진 것으로
    // 보인다. 이름이 사람이 읽으려고 쓴 것이고, 주소는 되돌리기로 돌아온다.
    return {
      text: text.slice(0, inside.start) + inside.label + text.slice(inside.end),
      start: inside.start,
      end: inside.start + inside.label.length,
    };
  }

  const selected = text.slice(from, to);
  if (selected.includes('\n')) return null;

  const before = text.slice(0, from);
  const after = text.slice(to);

  if (selected && classifyLink(selected)) {
    // 고른 것이 주소다 — 이름을 받는다.
    return { text: `${before}[](${selected})${after}`, start: from + 1, end: from + 1 };
  }

  // 고른 것이 이름이다(빈 것도 여기로 온다) — 주소를 받는다.
  const at = from + selected.length + 3; // `[` + 이름 + `](`
  return { text: `${before}[${selected}]()${after}`, start: at, end: at };
}

/**
 * 고른 글 **위에** 주소를 붙여넣은 것. 컴포저가 제안 줄로 들고 있다가, 사람이 누르면
 * `applyPastedLink` 로 적용한다.
 *
 * `raw` 와 `href` 를 함께 두는 이유: 초안에 들어간 것은 클립보드의 **날 글자**(끝에 개행이
 * 붙어 오는 일이 흔하다)이고, 링크에 넣을 것은 다듬은 주소다. 둘을 하나로 두면 찾을 때와
 * 넣을 때의 글자가 갈려 제안이 자기 자리를 못 찾는다.
 */
export interface PastedLink {
  /** 붙여넣기가 덮어쓴 글 — 링크의 이름이 될 것. */
  label: string;
  /** 초안에 실제로 들어간 글자. 자리를 찾는 데 쓴다. */
  raw: string;
  /** 링크에 넣을 주소. */
  href: string;
  /** 붙여넣은 자리(붙여넣기 직전의 `selectionStart`). */
  at: number;
}

/**
 * 이 붙여넣기를 링크로 만들 수 있는가. 안 되면 `null` 이고, 그러면 **제안 줄이 서지 않는다** —
 * 평범한 붙여넣기에 매번 줄이 뜨면 그 줄은 곧 아무도 안 읽는 장식이 된다(`pasteCalls` 와
 * 같은 판단).
 *
 * 조건이 셋이다: 덮어쓴 글이 있어야 하고(이름이 될 것이 없으면 만들 링크가 없다), 그것이
 * 한 줄이어야 하고(`toggleLink` 와 같은 이유), 붙여넣은 것이 **열리는 주소**여야 한다.
 */
export function linkFromPaste(label: string, raw: string, at: number): PastedLink | null {
  if (!label.trim() || label.includes('\n')) return null;
  const href = raw.trim();
  if (!classifyLink(href)) return null;
  // 이미 링크 문법을 붙여넣었으면 손대지 않는다 — 겹쳐 싸면 `[[a](b)](b)` 가 된다.
  if (linkAt(href, 0)) return null;
  return { label, raw, href, at };
}

/**
 * 제안을 적용한 초안. 붙여넣은 주소가 **아직 초안에 그대로 있을 때만** 값이 나온다 —
 * 그래서 컴포저는 이 함수로 제안을 그릴지도 판단한다(제안을 초안에서 파생시키는 것은
 * `linkOffer`·`callOffer` 와 같은 규약이다: 지운 글을 가리키는 버튼을 남기지 않는다).
 *
 * 자리는 기록해 둔 `at` 을 먼저 믿고, 어긋나면(그 뒤로 앞쪽을 더 고쳤다) 찾아본다.
 */
export function applyPastedLink(text: string, p: PastedLink): LinkEdit | null {
  const at = text.startsWith(p.raw, p.at) ? p.at : text.indexOf(p.raw);
  if (at < 0) return null;
  const md = `[${p.label}](${p.href})`;
  const end = at + md.length;
  // 커서는 링크 **뒤**다. 이름과 주소가 둘 다 채워져 있으므로 채울 빈 자리가 없고,
  // 사람은 대개 이어서 문장을 쓴다.
  return { text: text.slice(0, at) + md + text.slice(at + p.raw.length), start: end, end };
}
