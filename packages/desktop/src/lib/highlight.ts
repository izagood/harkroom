/**
 * 찾기 결과 본문에서 **찾은 낱말이 나온 자리**를 가른다(⌘K 팔레트의 강조).
 *
 * 서버는 낱말 앞부분(접두 tsquery)과 세 글자 이상 중간일치로 맞춘다 — 둘 다 그 글자가 본문 어딘가에
 * 있다는 뜻이라, 글자 그대로 찾아 칠하면 서버가 맞춘 자리와 같다. 따옴표·`-` 같은 검색 문법 기호는
 * 떼고 찾는다(`"배포 순서"` 의 따옴표는 본문에 없다). 대소문자는 가리지 않는다. 모바일
 * `search_screen.dart` 의 `highlightSpans` 와 같은 규칙이다.
 */
export interface HighlightPart {
  text: string;
  hit: boolean;
}

export function queryWords(query: string): string[] {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/^[-"]+|"+$/g, '').toLowerCase())
    .filter((w) => w.length > 0);
  // 긴 낱말을 먼저 — 「배포」 와 「배포해」 가 같이 있으면 긴 쪽이 이긴다.
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

export function highlightParts(text: string, query: string): HighlightPart[] {
  const words = queryWords(query);
  const lower = text.toLowerCase();
  // 길이가 바뀌는 소문자화(드문 유니코드)면 자리가 어긋난다 — 그때는 칠하지 않는다.
  if (words.length === 0 || lower.length !== text.length) return [{ text, hit: false }];
  const marks = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(w, from);
      if (at < 0) break;
      marks.fill(true, at, at + w.length);
      from = at + w.length;
    }
  }
  const parts: HighlightPart[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marks[i] !== marks[start]) {
      parts.push({ text: text.slice(start, i), hit: marks[start] ?? false });
      start = i;
    }
  }
  return parts.length ? parts : [{ text, hit: false }];
}

/**
 * 한 줄로 잘리는 자리에서 찾은 낱말이 잘린 뒤쪽에 있으면 강조가 안 보인다 — 첫 일치 앞 [lead] 글자쯤에서
 * `…` 로 시작하는 발췌로 바꾼다(모바일 `searchExcerpt` 와 같다). 낱말 가운데를 자르지 않게 그 앞 공백까지 물린다.
 */
export function searchExcerpt(text: string, query: string, lead = 20): string {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return text;
  let first = -1;
  for (const w of queryWords(query)) {
    const at = lower.indexOf(w);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  if (first <= lead) return text;
  let start = first - lead;
  const space = text.lastIndexOf(' ', start);
  if (space >= 0 && first - space <= lead + 10) start = space + 1;
  return `…${text.slice(start)}`;
}
