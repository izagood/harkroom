// Rust 비밀 열기 골든(`crates/harkroom-server/golden/secret_keyring.json`·`secret_leak.json`)의 입력을 글자 그대로가 아니라
// **만드는 법**으로 적는다 — 시험 키를 hex·base64 로 파일에 적으면 비밀 검사(gitleaks)에 걸리고, 허용 목록을 넓히지 않기로 했다.
// 생성 스크립트(`scripts/genRustSecretGolden.ts`)·TS 대조 시험(`test/rustSecretGolden.test.ts`)이 이 파일을 같이 쓰고, Rust 시험은
// 같은 규칙을 Rust 로 다시 짠다(`crates/harkroom-server/src/secrets/golden.rs`).
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 시험 키: `from, from+1, …` 바이트(256 에서 돈다). 실제 키와 무관한 고정 패턴. */
export interface PatternKey { from: number; len?: number }

export function patternKey(k: PatternKey): Buffer {
  const len = k.len ?? 32;
  return Buffer.from(Array.from({ length: len }, (_, i) => (k.from + i) & 0xff));
}

/**
 * 키 파일 내용을 만드는 법. `text` 가 있으면 그 글자 그대로, 아니면 `key` 를 `enc` 로 적은 뒤
 * `replace`(첫 자리 하나)·`bumpLast`(마지막 base64 글자의 남는 비트를 켬)·`cut`(앞 n 자)·`add`(뒤에 붙임)·`pre`/`post` 를 차례로 건다.
 */
export interface KeyTextSpec {
  text?: string;
  key?: PatternKey;
  enc?: 'hex' | 'hexUpper' | 'hexMixed' | 'b64';
  replace?: [string, string];
  bumpLast?: boolean;
  cut?: number;
  add?: string;
  pre?: string;
  post?: string;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function keyText(s: KeyTextSpec): string {
  if (s.text !== undefined) return s.text;
  const k = patternKey(s.key!);
  let t: string;
  switch (s.enc) {
    case 'hexUpper': t = k.toString('hex').toUpperCase(); break;
    case 'hexMixed': t = [...k.toString('hex')].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join(''); break;
    case 'b64': t = k.toString('base64'); break;
    default: t = k.toString('hex');
  }
  if (s.replace) t = t.replace(s.replace[0], s.replace[1]);
  if (s.bumpLast) {
    // 32바이트의 base64 는 43자 + `=` — 43번째 글자의 아래 2비트는 버려지는 비트다. 1 을 켜도 같은 32바이트로 풀린다(Node 는 받는다).
    const i = t.length - 2;
    t = t.slice(0, i) + B64[B64.indexOf(t[i]!) | 1] + t.slice(i + 1);
  }
  if (s.cut !== undefined) t = t.slice(0, s.cut);
  if (s.add) t += s.add;
  return `${s.pre ?? ''}${t}${s.post ?? ''}`;
}

/** 키 디렉터리 항목. `dir` 은 하위 디렉터리, `link` 는 심링크(대상은 디렉터리 안의 상대 경로). */
export interface DirEntrySpec { name: string; content?: KeyTextSpec; dir?: boolean; link?: string }

export interface LoadCase {
  name: string;
  /** `unset` = env 없음, `blank` = 공백만, `missing` = 없는 경로, `dir` = 아래 항목으로 만든 디렉터리. */
  dir: 'unset' | 'blank' | 'missing' | 'dir';
  entries?: DirEntrySpec[];
  active?: string;
  expect: { none: true } | { error: string } | { kids: string[]; active: string; keys: Record<string, PatternKey> };
}

/** 시험마다 새 임시 디렉터리에 항목을 만든다. 항목은 순서대로 만든다(심링크 대상 디렉터리를 먼저 둔다). */
export function buildLoadDir(c: LoadCase): string | undefined {
  if (c.dir === 'unset') return undefined;
  if (c.dir === 'blank') return '   ';
  const root = mkdtempSync(join(tmpdir(), 'hr-secret-golden-'));
  if (c.dir === 'missing') return join(root, 'nope');
  for (const e of c.entries ?? []) {
    const p = join(root, e.name);
    if (e.dir) mkdirSync(p, { recursive: true });
    else if (e.link) symlinkSync(e.link, p);
    else writeFileSync(p, keyText(e.content!), 'utf8');
  }
  return root;
}

/** 비밀 값: 글자(`text`) 또는 바이트(`hex`, 시험 값 — 키가 아니다). */
export interface ValueSpec { text?: string; hex?: string; repeat?: number }

export function valueBytes(v: ValueSpec): Buffer {
  const one = v.text !== undefined ? Buffer.from(v.text, 'utf8') : Buffer.from(v.hex ?? '', 'hex');
  return v.repeat ? Buffer.concat(Array.from({ length: v.repeat }, () => one)) : one;
}
