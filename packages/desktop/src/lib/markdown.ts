import { QUOTE_LINE, type CodeSegment } from '@murmur/shared';
import { classifyLink, type LinkTarget } from './link';

/**
 * 본문의 **마크다운 구조**를 읽는다(#216).
 *
 * ## 왜 라이브러리를 쓰지 않는가
 *
 * `react-markdown`·`marked` 는 결국 HTML 문자열을 만들고 그것이 `dangerouslySetInnerHTML`
 * 로 들어간다. 본문은 **에이전트도 쓰는 신뢰할 수 없는 텍스트**다(`test/bodyCode.test.tsx`
 * 가 지키는 경계). 여기서 나오는 것은 문자열이 아니라 **구조체**이고, 렌더러는 그 구조체를
 * React 엘리먼트로만 바꾼다 — 그래서 `dangerouslySetInnerHTML` 이 들어올 자리가 애초에
 * 없다. 코드 블록에 문법 강조기를 들이지 않은 것과 같은 이유다(`MessageBody`).
 *
 * ## 순서가 규칙이다
 *
 * `splitCode`(코드) → **여기**(블록 + 인라인 강조) → `splitMentions`/`splitLinks`.
 *
 * 이 순서에서 따라오는 결과들이고, 어느 것도 별도 예외 처리가 아니다:
 * - 코드 블록 안의 `**`·`#`·`-` 는 마크다운이 아니다 — 코드가 먼저 떼어졌기 때문이다.
 * - `` `*.tmp` `` 의 `*` 는 강조를 열지 않는다 — 인라인 코드는 이 파서를 지나지 않는다.
 * - 굵은 글씨 안의 `@handle` 은 여전히 멘션이다 — 멘션이 마지막에 얹히기 때문이다.
 *
 * ## 닫히지 않은 것은 문법이 아니다
 *
 * `splitCode` 의 "닫히지 않은 펜스는 코드가 아니다" 와 같은 규칙을 강조에도 적용한다.
 * `**굵게` 는 그대로 `**굵게` 로 남는다. 닫는 짝을 낙관하면 뒤 본문 전체가 굵어지고,
 * 그건 사람에게 "메시지가 깨졌다" 로 보인다.
 */

/** 강조 상태. 세 축이 독립이므로 중첩(`**굵고 _기울고_**`)이 그대로 표현된다. */
export interface Emphasis {
  strong: boolean;
  em: boolean;
  strike: boolean;
}

const PLAIN: Emphasis = { strong: false, em: false, strike: false };

/**
 * 한 줄 안의 조각. `text` 만 뒤에서 멘션·링크로 다시 나뉜다 — `code` 와 `link` 는
 * 이미 확정된 것이라 손대지 않는다.
 */
export type Inline =
  | ({ kind: 'text'; text: string } & Emphasis)
  /** 인라인 코드. `splitCode` 가 이미 집어 준 것을 그대로 옮긴다. */
  | { kind: 'code'; code: string }
  /**
   * `[글자](주소)`. `target` 이 없으면 애초에 이 조각이 만들어지지 않는다(아래 참고).
   * `href` 는 **쓴 그대로의 주소**다 — 호버로 목적지를 보여 주는 용도이고, 실제 이동은
   * 언제나 `target` 이 한다.
   */
  | ({ kind: 'link'; text: string; href: string; target: LinkTarget } & Emphasis);

/**
 * 표 칸의 정렬. `null` 은 구분줄이 정렬을 말하지 않았다는 뜻이고, 그때는 **왼쪽**이다 —
 * 칸 내용을 보고 숫자면 오른쪽으로 미루는 식의 추측을 하지 않는다. 그런 추측은 같은 열이
 * 행마다 다르게 서는 결과를 낳는다.
 */
export type Align = 'left' | 'center' | 'right' | null;

/** 한 행. 칸마다 인라인 조각 목록이다. */
export type Row = Inline[][];

/** 목록 항목. `children` 에는 **중첩 목록만** 들어간다. */
export interface ListItem {
  spans: Inline[];
  children: Block[];
}

/** 본문의 블록. 문단 사이가 아니라 **블록 사이**가 시각적 간격의 단위다. */
export type Block =
  | { kind: 'paragraph'; spans: Inline[] }
  /** `#`~`######`. `level` 은 1~6 이고 렌더러가 `aria-level` 로 옮긴다. */
  | { kind: 'heading'; level: number; spans: Inline[] }
  | { kind: 'quote'; spans: Inline[] }
  | { kind: 'rule' }
  | { kind: 'code'; code: string; lang: string | null }
  /** `start` 는 `1.` 이 아니라 `3.` 으로 시작한 목록을 그대로 그리기 위한 것이다. */
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  /**
   * GFM 표. `align.length` 가 곧 **열 수**이고 모든 행이 그 길이로 맞춰져 들어온다 —
   * 렌더러가 행마다 칸 수를 다시 세지 않게 하려는 것이다. 행마다 열 수가 다른 표를
   * 그대로 넘기면 `<td>` 가 어긋나 표가 계단처럼 무너진다.
   */
  | { kind: 'table'; align: Align[]; head: Row; rows: Row[] };

// ── 인라인 ───────────────────────────────────────────────────────────────────

/**
 * `[글자](주소)`. 주소에 공백을 허용하지 않고 글자에 개행을 허용하지 않는다 — 링크
 * 문법이 여러 줄을 삼키면 그 사이의 블록 구조가 사라진다.
 */
const MD_LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;

interface Opener {
  mark: string;
  key: keyof Emphasis;
}

/**
 * `i` 위치에서 강조가 열리는가.
 *
 * `_` 만 조건이 하나 더 붙는다: 앞 글자가 영숫자면 열지 않는다. 우리가 실제로 주고받는
 * 본문에는 `kMDItemLastUsedDate`·`NSOSPLastRootDirectory` 같은 식별자가 늘 있고, 그걸
 * 기울임으로 바꿔 버리면 **글자가 사라진다**(`_` 가 지워진다). 그건 렌더링이 아니라 훼손이다.
 * `*` 는 같은 위험이 없어서 그대로 둔다.
 */
function openerAt(text: string, i: number, active: Emphasis): Opener | null {
  const cands: Opener[] = [
    { mark: '**', key: 'strong' },
    { mark: '~~', key: 'strike' },
    { mark: '*', key: 'em' },
    { mark: '_', key: 'em' },
  ];
  for (const c of cands) {
    if (!text.startsWith(c.mark, i)) continue;
    // 이미 켜져 있는 축은 열지 않는다 — `**a**b**c**` 를 한 덩어리로 삼키지 않게 한다.
    if (active[c.key]) continue;
    const next = text[i + c.mark.length];
    // 여는 기호 뒤가 공백이면 강조가 아니다. `a * b * c` 를 기울임으로 만들지 않는다.
    if (next === undefined || /\s/.test(next)) continue;
    if (c.mark === '_' && i > 0 && /[a-zA-Z0-9]/.test(text[i - 1]!)) continue;
    return c;
  }
  return null;
}

/**
 * `from` 이후에서 닫는 짝의 위치. 없으면 -1 이고, 그러면 여는 기호는 그냥 글자로 남는다.
 *
 * 닫는 기호 앞이 공백이면 짝이 아니다(여는 조건의 대칭). `_` 는 뒤 글자가 영숫자면
 * 짝이 아니다 — `snake_case_name` 의 두 번째 `_` 로 닫히는 것을 막는다.
 */
function findCloser(text: string, from: number, mark: string): number {
  for (let j = from; j + mark.length <= text.length; j += 1) {
    if (!text.startsWith(mark, j)) continue;
    if (j === from) continue; // 빈 강조(`****`)는 강조가 아니다.
    if (/\s/.test(text[j - 1]!)) continue;
    if (mark === '_') {
      const after = text[j + mark.length];
      if (after !== undefined && /[a-zA-Z0-9]/.test(after)) continue;
    }
    return j;
  }
  return -1;
}

/**
 * 한 덩어리의 글자를 강조·링크 조각으로 나눈다. 재귀로 중첩을 처리한다 — 여는 기호를
 * 만나면 짝 안쪽을 강조 상태만 바꿔 다시 훑는다.
 */
function scanInline(text: string, active: Emphasis, out: Inline[]): void {
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) out.push({ kind: 'text', text: buf, ...active });
    buf = '';
  };

  while (i < text.length) {
    if (text[i] === '[') {
      const m = MD_LINK.exec(text.slice(i));
      // 열 수 없는 주소면 **링크를 만들지 않는다.** 막는 것이 아니라 누를 것이 생기지
      // 않는다 — `classifyLink` 허용 목록이 그대로 신뢰 경계다(`lib/link.ts`).
      const target = m ? classifyLink(m[2]!) : null;
      if (m && target) {
        flush();
        out.push({ kind: 'link', text: m[1]!, href: m[2]!, target, ...active });
        i += m[0].length;
        continue;
      }
    }

    const open = openerAt(text, i, active);
    if (open) {
      const close = findCloser(text, i + open.mark.length, open.mark);
      if (close !== -1) {
        flush();
        scanInline(text.slice(i + open.mark.length, close), { ...active, [open.key]: true }, out);
        i = close + open.mark.length;
        continue;
      }
    }

    buf += text[i];
    i += 1;
  }
  flush();
}

// ── 줄 만들기 ────────────────────────────────────────────────────────────────

/**
 * 줄 하나를 이루는 토큰. 블록 표시(`#`, `- `, `> `)는 **첫 `plain` 토큰**에서만 읽는다 —
 * 줄이 인라인 코드로 시작하면 그 줄에는 블록 표시가 없다는 뜻이고, 그게 맞다:
 * `` `- ` 는 목록이다` `` 는 목록이 아니다.
 */
type Tok =
  | { kind: 'plain'; text: string }
  | { kind: 'code'; code: string }
  | { kind: 'fence'; code: string; lang: string | null };

/**
 * `splitCode` 의 조각 목록을 **줄 목록**으로 바꾼다.
 *
 * 이 변환이 필요한 이유가 요점이다: `plain` 조각은 개행을 품고 있고 `inlineCode` 는 줄을
 * 가로지르지 않는다. 즉 한 줄이 여러 조각으로 쪼개져 있다(`- ` + `` `foo` `` + ` bar`).
 * 블록 구조는 줄 단위로만 읽을 수 있으므로 먼저 줄로 다시 꿰맨다.
 */
function toLines(segments: CodeSegment[]): Tok[][] {
  const lines: Tok[][] = [[]];
  const cur = () => lines[lines.length - 1]!;

  for (const seg of segments) {
    if (seg.kind === 'codeBlock') {
      // 펜스는 언제나 자기 줄을 독차지한다 — 앞뒤로 빈 줄을 만들어 블록 경계를 끊는다.
      if (cur().length) lines.push([]);
      cur().push({ kind: 'fence', code: seg.code, lang: seg.lang });
      lines.push([]);
      continue;
    }
    if (seg.kind === 'inlineCode') {
      cur().push({ kind: 'code', code: seg.code });
      continue;
    }
    const parts = seg.text.split('\n');
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part.length) cur().push({ kind: 'plain', text: part });
    });
  }
  return lines;
}

/** 그 줄의 토큰들을 인라인 조각으로 옮긴다. 코드는 지나가고 글자만 파서를 탄다. */
function inlineOf(toks: Tok[]): Inline[] {
  const out: Inline[] = [];
  for (const t of toks) {
    if (t.kind === 'plain') scanInline(t.text, PLAIN, out);
    else if (t.kind === 'code') out.push({ kind: 'code', code: t.code });
  }
  return out;
}

// ── 블록 ─────────────────────────────────────────────────────────────────────

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
/** 가로줄. 같은 기호 세 개 이상만 인정한다 — `--` 는 그냥 글자다. */
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
// 인용(`>`)의 정규식만 여기 없다 — `QUOTE_LINE`(@murmur/shared, #593)을 그대로 쓴다.
// 멘션 판정이 인용 줄을 빼는 데 **같은** 것을 봐야 하기 때문이다. 복사본을 두면 그리는
// 것과 부르는 것이 갈라져, 인용으로 그려진 줄이 몰래 알림을 보낸다.

/**
 * 한 줄의 토큰을 `|` 경계로 나눈다. **인라인 코드 안의 `|` 는 경계가 아니다** — 토큰이
 * 이미 나뉘어 온 덕분에 별도 예외가 아니라 순서에서 따라온다(`` `a|b` `` 는 한 칸이다).
 * `\|` 는 글자 `|` 로 남긴다.
 *
 * 양끝의 `|` 가 만든 빈 칸은 떼어 낸다 — GFM 처럼 `| a | b |` 와 `a | b` 를 같은 두 칸으로 읽는다.
 */
function splitCells(toks: Tok[]): Tok[][] {
  const cells: Tok[][] = [[]];
  const cur = () => cells[cells.length - 1]!;

  for (const t of toks) {
    if (t.kind !== 'plain') { cur().push(t); continue; }
    let buf = '';
    for (let i = 0; i < t.text.length; i += 1) {
      const ch = t.text[i]!;
      if (ch === '\\' && t.text[i + 1] === '|') { buf += '|'; i += 1; continue; }
      if (ch === '|') {
        if (buf) cur().push({ kind: 'plain', text: buf });
        buf = '';
        cells.push([]);
        continue;
      }
      buf += ch;
    }
    if (buf) cur().push({ kind: 'plain', text: buf });
  }

  if (cells.length > 1 && cells[0]!.length === 0) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]!.length === 0) cells.pop();
  return cells;
}

/** 칸 앞뒤의 여백만 떼어 낸다. 칸 안쪽 글자는 손대지 않는다. */
function trimCell(toks: Tok[]): Tok[] {
  const out: Tok[] = toks.map((t) => ({ ...t }));
  const first = out[0];
  if (first && first.kind === 'plain') first.text = first.text.replace(/^[ \t]+/, '');
  const last = out[out.length - 1];
  if (last && last.kind === 'plain') last.text = last.text.replace(/[ \t]+$/, '');
  return out.filter((t) => t.kind !== 'plain' || t.text.length > 0);
}

/** `|`(escape 되지 않은) 가 글자 토큰 안에 있는가. 표 후보인지 보는 값싼 앞잡이다. */
function hasPipe(toks: Tok[]): boolean {
  return toks.some((t) => t.kind === 'plain' && t.text.replace(/\\\|/g, '').includes('|'));
}

/** 표 구분줄의 칸. `-`, `---`, `:--`, `--:`, `:-:` 만 인정한다. */
const DELIM_CELL = /^:?-+:?$/;

/**
 * 이 줄이 표 구분줄이면 열별 정렬, 아니면 `null`.
 *
 * 칸 하나라도 구분줄 모양이 아니면 **표가 아니다.** 관대하게 넘기면 `a | b` 라고 쓴
 * 평범한 문장 두 줄이 표로 바뀌어 사람이 쓴 글이 격자 안으로 사라진다.
 */
function delimAligns(toks: Tok[]): Align[] | null {
  if (!toks.length || !hasPipe(toks)) return null;
  const out: Align[] = [];
  for (const cell of splitCells(toks)) {
    if (cell.length !== 1 || cell[0]!.kind !== 'plain') return null;
    const s = cell[0]!.text.trim();
    if (!DELIM_CELL.test(s)) return null;
    const l = s.startsWith(':');
    const r = s.endsWith(':');
    out.push(l && r ? 'center' : r ? 'right' : l ? 'left' : null);
  }
  return out.length ? out : null;
}

/**
 * `at` 줄에서 표가 시작하면 그 블록과 **다음에 볼 줄**을, 아니면 `null`.
 *
 * 줄의 첫 토큰이 글자인지 인라인 코드인지 보지 않는다 — 표 판정에 쓰는 것은 `|` 와 다음
 * 줄의 구분줄뿐이고, 그래서 `` `a` | b `` 로 시작하는 머리글도 같은 길을 지난다.
 */
function tryTable(lines: Tok[][], at: number): { block: Block; next: number } | null {
  const toks = lines[at]!;
  if (!hasPipe(toks)) return null;
  const head = splitCells(toks);
  const align = delimAligns(lines[at + 1] ?? []);
  if (!align || align.length !== head.length) return null;

  const rows: Row[] = [];
  let j = at + 2;
  // 표는 `|` 가 없는 줄에서 끝난다(빈 줄도 그렇다). 빈 줄까지만 보면 표 뒤에 바로 붙여 쓴
  // 문장이 표의 마지막 행으로 들어간다.
  while (j < lines.length && hasPipe(lines[j]!)) {
    rows.push(fitRow(splitCells(lines[j]!), align.length));
    j += 1;
  }
  return {
    block: { kind: 'table', align, head: head.map((c) => inlineOf(trimCell(c))), rows },
    next: j,
  };
}

/**
 * 행을 머리글의 열 수에 맞춘다. 넘치는 칸은 버리고 모자란 칸은 빈 칸으로 채운다 —
 * GFM 과 같은 규칙이고, `<td>` 어긋남을 파서에서 끝내려는 것이다.
 */
function fitRow(cells: Tok[][], width: number): Row {
  const out: Row = [];
  for (let c = 0; c < width; c += 1) out.push(inlineOf(trimCell(cells[c] ?? [])));
  return out;
}

interface RawItem {
  indent: number;
  ordered: boolean;
  start: number;
  toks: Tok[];
}

/** 들여쓰기 폭. 탭은 두 칸으로 센다 — 목록 깊이 판정에만 쓰는 상대값이다. */
function indentWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += ch === '\t' ? 2 : 1;
  return n;
}

/**
 * 첫 토큰의 접두사를 떼고 남은 토큰들. 표시를 뗀 나머지가 비어도 토큰 자체는 남긴다 —
 * `- ` 만 쓴 줄은 **빈 항목**이지 목록이 아닌 것이 아니다.
 */
function withoutPrefix(toks: Tok[], rest: string): Tok[] {
  const tail = toks.slice(1);
  return rest.length ? [{ kind: 'plain', text: rest }, ...tail] : tail;
}

/**
 * 연속한 목록 항목들을 **중첩된** 목록으로 접는다.
 *
 * 깊이를 `padding-left` 로만 흉내내지 않고 실제로 `<ul>` 을 겹치는 이유: 스크린리더는
 * 목록의 깊이와 항목 수를 읽어 준다. 시각적 들여쓰기만 주면 "3개 항목 중 2번째" 가
 * 사라지고, 그건 구조를 그린 게 아니라 구조처럼 보이게 칠한 것이다.
 */
function foldList(items: RawItem[], from: number, indent: number): { block: Block; next: number } {
  const ordered = items[from]!.ordered;
  const start = items[from]!.start;
  const out: ListItem[] = [];
  let i = from;

  while (i < items.length) {
    const it = items[i]!;
    if (it.indent < indent) break;
    if (it.indent > indent && out.length) {
      const nested = foldList(items, i, it.indent);
      out[out.length - 1]!.children.push(nested.block);
      i = nested.next;
      continue;
    }
    // 표시 종류가 바뀌면 다른 목록이다 — 글머리표와 번호를 한 `<ul>` 에 섞지 않는다.
    if (it.ordered !== ordered) break;
    out.push({ spans: inlineOf(it.toks), children: [] });
    i += 1;
  }
  return { block: { kind: 'list', ordered, start, items: out }, next: i };
}

/**
 * 본문을 블록 목록으로 읽는다. **여기 하나만** 호출부에 노출된다.
 *
 * 빈 결과를 내지 않는다: 아무 구조가 없는 한 줄짜리 본문도 문단 하나로 돌아온다.
 * 호출부가 "구조가 있으면 이렇게, 없으면 저렇게" 두 갈래를 갖게 되면 그 두 갈래가
 * 갈라진다 — 한쪽만 고쳐지고 다른 쪽은 조용히 뒤처진다.
 */
export function parseBlocks(segments: CodeSegment[]): Block[] {
  const lines = toLines(segments);
  const blocks: Block[] = [];

  // 문단·인용은 여러 줄이 한 블록이다. 줄 사이에 개행 조각을 넣어 `pre-wrap` 이 그대로
  // 부드러운 줄바꿈으로 그리게 한다 — 줄마다 블록을 만들면 간격이 두 배로 벌어진다.
  let run: { kind: 'paragraph' | 'quote'; spans: Inline[] } | null = null;
  const flushRun = () => {
    if (run && run.spans.length) blocks.push({ kind: run.kind, spans: run.spans });
    run = null;
  };
  const pushRun = (kind: 'paragraph' | 'quote', spans: Inline[]) => {
    if (run && run.kind !== kind) flushRun();
    if (!run) run = { kind, spans: [] };
    else run.spans.push({ kind: 'text', text: '\n', ...PLAIN });
    run.spans.push(...spans);
  };
  /**
   * **빈 줄은 문단을 끊지 않는다.**
   *
   * 마크다운 표준은 빈 줄에서 문단을 나누고 문단 사이 여백을 스타일로 준다. 여기서 그렇게
   * 하면 `whitespace-pre-wrap` 이 이미 만들고 있는 여백에 문단 여백이 **한 번 더** 붙어
   * 간격이 두 배가 되고, 더 나쁜 것은 그 빈 줄의 개행 글자가 사라진다는 것이다 —
   * `test/bodyCode.test.tsx` 의 "개행도 글자 하나도 잃지 않는다" 가 잡는 바로 그 손실이다.
   * 채팅에서 줄을 비워 쓴 사람은 그 빈 줄이 그대로 보이기를 기대한다.
   *
   * 인용은 다르다. 빈 줄은 인용의 **끝**이다 — 이어 붙이면 인용이 아닌 문장이 인용 안으로
   * 끌려 들어간다.
   */
  const blankLine = () => {
    if (!run) return;
    if (run.kind === 'quote') { flushRun(); return; }
    run.spans.push({ kind: 'text', text: '\n', ...PLAIN });
  };

  let i = 0;
  while (i < lines.length) {
    const toks = lines[i]!;
    const head = toks[0];

    if (!head) { blankLine(); i += 1; continue; }

    if (head.kind === 'fence') {
      flushRun();
      blocks.push({ kind: 'code', code: head.code, lang: head.lang });
      i += 1;
      continue;
    }

    if (head.kind !== 'plain') {
      // 줄이 인라인 코드로 시작한다 — 블록 표시가 없다. 표만 예외다: 표는 첫 글자가 아니라
      // `|` 와 다음 줄의 구분줄로 판정하므로 첫 토큰의 종류와 무관하다.
      const t = tryTable(lines, i);
      if (t) {
        flushRun();
        blocks.push(t.block);
        i = t.next;
        continue;
      }
      pushRun('paragraph', inlineOf(toks));
      i += 1;
      continue;
    }

    const text = head.text;

    // 가로줄을 목록보다 먼저 본다. `---` 는 `- ` 가 아니라 줄이다.
    if (RULE.test(text) && toks.length === 1) {
      flushRun();
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    const h = HEADING.exec(text);
    if (h) {
      flushRun();
      blocks.push({
        kind: 'heading',
        level: h[1]!.length,
        spans: inlineOf(withoutPrefix(toks, h[2]!)),
      });
      i += 1;
      continue;
    }

    const q = QUOTE_LINE.exec(text);
    if (q) {
      pushRun('quote', inlineOf(withoutPrefix(toks, q[1]!)));
      i += 1;
      continue;
    }

    /**
     * 표. **구분줄이 바로 다음 줄에 있을 때만** 표다.
     *
     * 앞 줄만 보고는 표의 머리글과 `a | b` 라고 쓴 문장을 구별할 수 없다. 열 수까지 같기를
     * 요구하는 것도 같은 이유다 — 여기서 관대해지면 사람이 쓴 문단이 격자 안으로 끌려
     * 들어가고, 그건 "안 그려진 문법" 보다 나쁘다(내용이 바뀐다).
     */
    const tbl = tryTable(lines, i);
    if (tbl) {
      flushRun();
      blocks.push(tbl.block);
      i = tbl.next;
      continue;
    }

    if (BULLET.test(text) || ORDERED.test(text)) {
      flushRun();
      // 연속한 항목 줄을 모두 모은 뒤 한 번에 접는다. 중첩 판정은 이웃 항목의 들여쓰기를
      // 봐야 하므로 줄 하나만 보고는 만들 수 없다.
      const raw: RawItem[] = [];
      while (i < lines.length) {
        const t = lines[i]!;
        const h0 = t[0];
        if (!h0 || h0.kind !== 'plain') break;
        const b = BULLET.exec(h0.text);
        if (b) {
          raw.push({ indent: indentWidth(b[1]!), ordered: false, start: 1, toks: withoutPrefix(t, b[3]!) });
          i += 1;
          continue;
        }
        const o = ORDERED.exec(h0.text);
        if (o) {
          raw.push({ indent: indentWidth(o[1]!), ordered: true, start: Number(o[2]), toks: withoutPrefix(t, o[3]!) });
          i += 1;
          continue;
        }
        break;
      }
      let at = 0;
      while (at < raw.length) {
        const folded = foldList(raw, at, raw[at]!.indent);
        blocks.push(folded.block);
        at = folded.next;
      }
      continue;
    }

    pushRun('paragraph', inlineOf(toks));
    i += 1;
  }
  flushRun();

  return blocks;
}
