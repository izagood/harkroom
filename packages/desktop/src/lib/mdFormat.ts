import { toggleCode } from './codeMarks';
/**
 * 입력창 서식 단축키가 초안 문자열을 어떻게 바꾸는가(입력창 개편 P1 — ⌘B·⌘I·⌘⇧X·⌘⇧7/8/9,
 * 목록 Shift+Enter, 코드 블록 Enter).
 *
 * `toggleCode`(⌘E)·`toggleLink`(⌘K)와 같은 꼴이다: 문자열과 선택 범위를 받아 **새 문자열과
 * 새 선택 범위**를 돌려준다. 편집기는 그 결과를 넣기만 한다 — 원문이 마크다운 그대로라
 * 서식을 켜고 끄는 것은 기호를 넣고 빼는 일이고, 그건 편집기 없이 시험할 수 있다.
 *
 * 기호는 메시지 렌더러(`markdown.ts`)가 읽는 것만 쓴다. 기울임은 대개 `*` 다 — `_` 는 앞 글자가
 * 영숫자면 열리지 않아서(`snake_case` 보호) `abc` 뒤에 붙인 기울임이 보낸 뒤에 기호 그대로 남는다.
 * 다만 굵게와 맞닿으면 `_` 다: `***중요***` 를 렌더러는 `**` 부터 짝지어 `*중요` 를 굵게 그린다.
 * `**_중요_**` 는 그 모호함이 없다.
 */

export interface FormatEdit {
  text: string;
  start: number;
  end: number;
}

export type InlineMark = '**' | '*' | '~~';

/** `at` 에서 왼쪽(`dir = -1`)·오른쪽(`dir = 1`)으로 같은 글자가 몇 개 이어지는가. */
function runOf(text: string, at: number, ch: string, dir: 1 | -1): number {
  let n = 0;
  for (let i = dir === 1 ? at : at - 1; i >= 0 && i < text.length && text[i] === ch; i += dir) n += 1;
  return n;
}

/**
 * 고른 범위의 바로 바깥을 감싼 기호. 없으면 `null`. `*` 는 굵게(`**`)와 글자가 같아서 개수로 가른다 —
 * 기울임은 홀수 개(`*`·`***`), 굵게는 둘 이상. 기울임은 `_` 짝도 본다.
 */
function wrapper(text: string, from: number, to: number, mark: InlineMark): string | null {
  if (mark === '*') {
    if (text[from - 1] === '_' && text[to] === '_') return '_';
    return runOf(text, from, '*', -1) % 2 === 1 && runOf(text, to, '*', 1) % 2 === 1 ? '*' : null;
  }
  const ch = mark[0]!;
  return runOf(text, from, ch, -1) >= 2 && runOf(text, to, ch, 1) >= 2 ? mark : null;
}

/** 실제로 넣을 기호. 기울임이 `*` 와 맞닿으면 `_` 로 바꾼다(머리 주석). */
function markFor(text: string, from: number, to: number, mark: InlineMark): string {
  if (mark !== '*') return mark;
  const touchesStar = text[from - 1] === '*' || text[to] === '*' || text[from] === '*' || text[to - 1] === '*';
  const alnumAround = /[A-Za-z0-9]/.test(text[from - 1] ?? '') || /[A-Za-z0-9]/.test(text[to] ?? '');
  return touchesStar && !alnumAround ? '_' : '*';
}

/**
 * ⌘B·⌘I·⌘⇧X — 고른 글을 감싸거나, 이미 감싸여 있으면 벗긴다.
 *
 * - 고른 것이 없으면 빈 짝을 열고 커서를 **안에** 둔다(`toggleCode` 와 같은 이유: 밖에 두면
 *   이어 치는 글자가 서식 밖에 쌓인다). 빈 짝 안에서 다시 누르면 짝을 거둔다.
 * - 여러 줄이면 줄마다 따로 감싼다 — 렌더러의 강조는 개행을 넘지 않는다.
 * - 고른 글 앞뒤의 공백은 기호 밖에 둔다 — `** 굵게**` 는 렌더러가 강조로 읽지 않는다.
 */
export function toggleInline(text: string, from: number, to: number, kind: InlineMark): FormatEdit {
  const found = wrapper(text, from, to, kind);
  if (found) {
    const len = found.length;
    return {
      text: text.slice(0, from - len) + text.slice(from, to) + text.slice(to + len),
      start: from - len,
      end: to - len,
    };
  }
  const mark = markFor(text, from, to, kind);
  const len = mark.length;
  if (from === to) {
    return { text: `${text.slice(0, from)}${mark}${mark}${text.slice(to)}`, start: from + len, end: from + len };
  }
  const selected = text.slice(from, to);
  const lines = selected.split('\n').map((line) => {
    const m = /^(\s*)(.*?)(\s*)$/.exec(line)!;
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : line;
  });
  const body = lines.join('\n');
  if (!selected.includes('\n')) {
    const lead = /^\s*/.exec(selected)![0].length;
    const trail = /\s*$/.exec(selected)![0].length;
    return { text: text.slice(0, from) + body + text.slice(to), start: from + lead + len, end: to - trail + len };
  }
  return { text: text.slice(0, from) + body + text.slice(to), start: from, end: from + body.length };
}

export type LineKind = 'ordered' | 'bullet' | 'quote';

const PREFIX: Record<LineKind, RegExp> = {
  ordered: /^(\s*)\d+[.)] /,
  bullet: /^(\s*)[-*+] /,
  quote: /^(\s*)> ?/,
};
/** 목록끼리는 서로 바뀐다 — 글머리 목록에서 ⌘⇧7 은 번호 목록이 되어야지 두 겹이 되면 안 된다. */
const ANY_LIST = /^(\s*)(?:\d+[.)]|[-*+]) /;

/**
 * ⌘⇧7(번호 목록)·⌘⇧8(글머리 목록)·⌘⇧9(인용) — 고른 범위가 걸친 줄 전부에 줄머리 기호를
 * 붙이거나, 이미 모든 줄이 그 기호면 뗀다. 빈 줄은 건너뛴다(빈 항목을 만들지 않는다).
 */
export function toggleLinePrefix(text: string, from: number, to: number, kind: LineKind): FormatEdit {
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const nl = text.indexOf('\n', to);
  const lineEnd = nl === -1 ? text.length : nl;
  const lines = text.slice(lineStart, lineEnd).split('\n');
  const filled = lines.filter((l) => l.trim() !== '');
  const all = filled.length > 0 && filled.every((l) => PREFIX[kind].test(l));

  let n = 0;
  const next = lines.map((line) => {
    if (all) return line.replace(PREFIX[kind], '$1');
    if (line.trim() === '' && lines.length > 1) return line;
    n += 1;
    const mark = kind === 'ordered' ? `${n}. ` : kind === 'bullet' ? '- ' : '> ';
    const bare = kind === 'quote' ? line : line.replace(ANY_LIST, '$1');
    const indent = /^\s*/.exec(bare)![0];
    return `${indent}${mark}${bare.slice(indent.length)}`;
  });
  const body = next.join('\n');
  const out = text.slice(0, lineStart) + body + text.slice(lineEnd);
  // 한 줄이면 커서를 같은 글자 앞에 그대로 둔다(기호 길이만큼 민다). 여러 줄이면 바뀐 줄 전체를 고른다.
  if (lines.length === 1) {
    const delta = body.length - lines[0]!.length;
    const clamp = (p: number) => Math.max(lineStart, p + delta);
    return { text: out, start: clamp(from), end: clamp(to) };
  }
  return { text: out, start: lineStart, end: lineStart + body.length };
}

/**
 * 목록 줄에서 Shift+Enter — 다음 항목의 기호를 이어 준다(번호는 하나 올린다).
 * 비어 있는 항목에서 누르면 목록을 끝낸다: 기호만 지우고 줄은 늘리지 않는다.
 * 목록 줄이 아니면 `null`(편집기가 그냥 줄을 바꾼다).
 */
export function continueList(text: string, caret: number): FormatEdit | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const nl = text.indexOf('\n', caret);
  const line = text.slice(lineStart, nl === -1 ? text.length : nl);
  const m = /^(\s*)(?:(\d+)([.)])|([-*+])) /.exec(line);
  if (!m) return null;
  if (caret < lineStart + m[0].length) return null;
  if (line.slice(m[0].length).trim() === '') {
    const out = text.slice(0, lineStart) + m[1] + text.slice(lineStart + m[0].length);
    const at = lineStart + m[1]!.length;
    return { text: out, start: at, end: at };
  }
  const mark = m[2] ? `${Number(m[2]) + 1}${m[3]} ` : `${m[4]} `;
  const insert = `\n${m[1]}${mark}`;
  const at = caret + insert.length;
  return { text: text.slice(0, caret) + insert + text.slice(caret), start: at, end: at };
}

/**
 * 커서가 코드 블록(``` 펜스) 안에 있는가. 닫히지 않은 펜스도 안으로 본다 — 지금 쓰고 있는
 * 블록이 그 꼴이고, 그때 Enter 가 보내기면 첫 줄만 치고 블록이 날아간다.
 */
export function inFence(text: string, caret: number): boolean {
  const lines = text.slice(0, caret).split('\n');
  const current = lines.pop()!;
  let open = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) open = !open;
  }
  // 커서가 여는 펜스 줄 끝에 있으면(``` 를 막 친 자리) 그 Enter 는 블록을 여는 줄바꿈이다.
  return open || /^\s*```/.test(current);
}

export type FormatShortcut = { kind: 'inline'; mark: InlineMark } | { kind: 'line'; line: LineKind };

interface KeyLike { code: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }

/**
 * 열쇠 → 서식. ⌘(맥)·Ctrl(그 밖) 둘 다 받는다 — ⌘E·⌘K 와 같다. `code` 로 본다: 한글 입력
 * 상태의 `key` 는 자모이고, ⇧ 와 숫자의 `key` 는 기호다.
 */
export function formatShortcut(e: KeyLike): FormatShortcut | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (!e.shiftKey) {
    if (e.code === 'KeyB') return { kind: 'inline', mark: '**' };
    if (e.code === 'KeyI') return { kind: 'inline', mark: '*' };
    return null;
  }
  if (e.code === 'KeyX') return { kind: 'inline', mark: '~~' };
  if (e.code === 'Digit7') return { kind: 'line', line: 'ordered' };
  if (e.code === 'Digit8') return { kind: 'line', line: 'bullet' };
  if (e.code === 'Digit9') return { kind: 'line', line: 'quote' };
  return null;
}

/**
 * 코드 블록(도구줄 `{ }` 단추). 고른 줄들을 펜스로 감싼다 — 한 줄만 골랐거나 아무것도 고르지
 * 않아도 블록이다(⌘E 는 한 줄이면 인라인 코드로 감싼다, 그 차이가 단추가 따로 있는 이유다).
 * 이미 펜스 안이면 `toggleCode` 가 벗긴다.
 */
export function toggleFence(text: string, from: number, to: number): FormatEdit {
  if (inFence(text, from)) {
    const t = toggleCode(text, from, to);
    return { text: t.text, start: t.start, end: t.end };
  }
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const nl = text.indexOf('\n', to);
  const lineEnd = nl === -1 ? text.length : nl;
  const body = text.slice(lineStart, lineEnd);
  const open = '```\n';
  const next = text.slice(0, lineStart) + open + body + '\n```' + text.slice(lineEnd);
  return { text: next, start: lineStart + open.length, end: lineStart + open.length + body.length };
}
