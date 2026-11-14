/**
 * codex code mode 기록에서 지금 도는 셸 호출을 꺼낸다 — Rust `crates/harkroom-operator/src/codex_code_mode.rs` 와 같은 판정.
 *
 * code mode 에서 셸 명령은 `custom_tool_call`(name `exec`)의 JS 코드 안 `tools.exec_command({...})` 로 돈다. hook 이 받는
 * `tool_use_id`(`exec-…`)는 명령이 끝난 뒤에야 기록에 남으므로, **이 턴에서 출력이 아직 없는 exec 셀 하나**를 지금 호출로 본다.
 * 코드는 아래 꼴과 정확히 맞을 때만 읽고 그 밖은 모두 거절한다:
 * - `[await ]tools.exec_command({ … })` 또는 `text(await tools.exec_command({ … }))`, 앞뒤 공백과 끝 `;` 하나만.
 * - `{ … }` 안은 `cmd`(필수, 비지 않음)와 `workdir`(선택) — 맨 이름이나 큰따옴표 이름, 값은 큰따옴표 문자열만, 같은 키 두 번은 거절.
 * - 문자열은 JSON 규칙으로 푼다(`\uXXXX` 포함). JSON 에 없는 이스케이프·날 제어문자·짝 없는 서로게이트는 거절. 공백은 ASCII 공백·탭·CR·LF 만.
 */

export type ExecCall = { cmd: string; workdir?: string };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

class P {
  i = 0;
  constructor(readonly s: string) {}
  ws(): void {
    while (this.i < this.s.length && ' \t\n\r'.includes(this.s[this.i]!)) this.i++;
  }
  lit(t: string): boolean {
    if (!this.s.startsWith(t, this.i)) return false;
    this.i += t.length;
    return true;
  }
  /** 낱말 뒤에 이름 글자가 붙지 않아야 한다(`awaitx` 를 `await` 로 읽지 않게). */
  word(t: string): boolean {
    const save = this.i;
    if (this.lit(t) && !/[A-Za-z0-9_$]/.test(this.s[this.i] ?? '')) return true;
    this.i = save;
    return false;
  }
  /** JSON 문자열(큰따옴표). 원문 그대로 JSON.parse 로 푼다 — JSON 규칙 밖이면 실패. */
  string(): string | null {
    if (this.s[this.i] !== '"') return null;
    const start = this.i++;
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) return null;
      if (c === '"') { this.i++; break; }
      this.i += c === '\\' ? 2 : 1;
    }
    if (this.i > this.s.length) return null;
    let v: unknown;
    try { v = JSON.parse(this.s.slice(start, this.i)); } catch { return null; }
    if (typeof v !== 'string' || LONE_SURROGATE.test(v)) return null;
    return v;
  }
  key(): 'cmd' | 'workdir' | null {
    for (const k of ['cmd', 'workdir'] as const) if (this.word(k)) return k;
    const save = this.i;
    const s = this.string();
    if (s === 'cmd' || s === 'workdir') return s;
    this.i = save;
    return null;
  }
  object(): ExecCall | null {
    if (!this.lit('{')) return null;
    const got: { cmd?: string; workdir?: string } = {};
    for (;;) {
      this.ws();
      if (this.lit('}')) break;
      const k = this.key();
      if (!k) return null;
      this.ws();
      if (!this.lit(':')) return null;
      this.ws();
      const v = this.string();
      if (v === null) return null;
      if (got[k] !== undefined) return null; // 같은 키 두 번 — JS 는 마지막 값을 쓴다.
      got[k] = v;
      this.ws();
      if (this.lit(',')) continue;
      this.ws();
      if (!this.lit('}')) return null;
      break;
    }
    if (!got.cmd) return null;
    return got.workdir === undefined ? { cmd: got.cmd } : { cmd: got.cmd, workdir: got.workdir };
  }
  call(): ExecCall | null {
    if (!this.lit('tools.exec_command')) return null;
    this.ws();
    if (!this.lit('(')) return null;
    this.ws();
    const c = this.object();
    if (!c) return null;
    this.ws();
    return this.lit(')') ? c : null;
  }
}

/** 꼴 ③의 이름으로 받지 않는 낱말 — 가림·바꿔치기 꼴을 원천 차단한다(security 01:28 조건 2). */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['text', 'tools', 'globalThis', 'await', 'async', 'arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield']);

/** ASCII 식별자 하나. 예약 이름이면 null. */
function ident(p: P): string | null {
  const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(p.s.slice(p.i));
  if (!m) return null;
  if (RESERVED_NAMES.has(m[0])) return null;
  p.i += m[0].length;
  return m[0];
}

/** 꼴 ③: `(const|let) <이름> = await tools.exec_command({…});` + `text(<같은 이름>);` 정확히 두 문장. */
function declThenText(p: P): ExecCall | null {
  if (!p.word('const') && !p.word('let')) return null;
  const before = p.i;
  p.ws();
  if (p.i === before) return null;
  const name = ident(p);
  if (!name) return null;
  p.ws();
  if (!p.lit('=')) return null;
  p.ws();
  if (!p.word('await')) return null;
  p.ws();
  const call = p.call();
  if (!call) return null;
  p.ws();
  if (p.lit(';')) p.ws();
  if (!p.word('text')) return null;
  p.ws();
  if (!p.lit('(')) return null;
  p.ws();
  if (!p.word(name)) return null;
  p.ws();
  return p.lit(')') ? call : null;
}

/** exec 셀의 코드 전체가 허용한 꼴 하나일 때만 그 호출을 돌려준다. */
export function parseExecCell(code: string): ExecCall | null {
  const p = new P(code);
  p.ws();
  let call: ExecCall | null;
  if (p.s.startsWith('const', p.i) || p.s.startsWith('let', p.i)) {
    call = declThenText(p);
    if (!call) return null;
  } else if (p.word('text')) {
    p.ws();
    if (!p.lit('(')) return null;
    p.ws();
    if (!p.word('await')) return null;
    p.ws();
    call = p.call();
    if (!call) return null;
    p.ws();
    if (!p.lit(')')) return null;
  } else {
    if (p.word('await')) p.ws();
    call = p.call();
    if (!call) return null;
  }
  p.ws();
  if (p.lit(';')) p.ws();
  return p.i === code.length ? call : null;
}

type Rec = { type?: unknown; payload?: { type?: unknown; call_id?: unknown; name?: unknown; input?: unknown; item?: { id?: unknown } } };

/**
 * 기록 꼬리(줄들)에서 이 턴의 출력 없는 exec 셀 하나를 찾아 그 코드를 돌려준다. `toolUseId` 가 이미 끝난 명령이면 null.
 * 이 턴의 시작은 꼬리 안 마지막 `turn_context`(또는 `task_started`)다 — 없으면 null.
 */
export function pendingExecCode(lines: string[], toolUseId: string): string | null {
  const recs: Rec[] = [];
  for (const l of lines) {
    try {
      const r = JSON.parse(l) as unknown;
      if (r && typeof r === 'object' && !Array.isArray(r)) recs.push(r as Rec);
    } catch { /* 깨진 줄은 건너뛴다 */ }
  }
  const pty = (r: Rec) => (r.payload && typeof r.payload === 'object' ? r.payload.type : undefined);
  // 이미 끝난 명령의 id 면 지금 호출이 아니다(꼬리 전체에서 본다).
  if (recs.some((r) => pty(r) === 'item_completed' && r.payload?.item?.id === toolUseId)) return null;
  let start = -1;
  recs.forEach((r, i) => {
    if (r.type === 'turn_context' || (r.type === 'event_msg' && pty(r) === 'task_started')) start = i;
  });
  if (start < 0) return null;
  const pending: [string, string][] = [];
  for (const r of recs.slice(start + 1)) {
    if (r.type !== 'response_item') continue;
    const p = r.payload;
    if (!p || typeof p !== 'object') return null;
    const id = typeof p.call_id === 'string' ? p.call_id : undefined;
    if (p.type === 'custom_tool_call' && p.name === 'exec') {
      if (typeof p.input !== 'string' || id === undefined) return null;
      pending.push([id, p.input]);
    } else if (p.type === 'custom_tool_call_output' && id !== undefined) {
      for (let k = pending.length - 1; k >= 0; k--) if (pending[k]![0] === id) pending.splice(k, 1);
    }
  }
  return pending.length === 1 ? pending[0]![1] : null;
}
