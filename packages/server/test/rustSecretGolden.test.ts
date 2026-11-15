// Rust 비밀 열기(`crates/harkroom-server/src/secrets/`, S5.3)의 정본은 `secretKeyring.ts`·`secretLeakGuard.ts` 다. 골든
// (`golden/secret_keyring.json`·`secret_leak.json`)은 `scripts/genRustSecretGolden.ts` 가 **한 번** 만들어 커밋한 것이고, 이 시험은
// 그 파일을 **읽어서 대조만** 한다 — TS 규칙을 고치고 골든을 안 고치면 여기서 빨개지고, Rust 가 따라오는지는 cargo test 가 본다.
// 고칠 때: 생성 스크립트를 다시 돌리고(`pnpm --filter @harkroom/server exec tsx scripts/genRustSecretGolden.ts`) 두 시험을 함께 본다.
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createSecretKeyring, keyCheckValue, loadSecretKeys, parseKey, type SecretAad } from '../src/services/secretKeyring.js';
import { collectStrings, createSecretLeakGuard, LEAK_MIN_CHARS, needlesFor, SECRET_IN_BODY } from '../src/services/secretLeakGuard.js';
import { buildLoadDir, keyText, patternKey, valueBytes, type LoadCase, type PatternKey, type ValueSpec } from './helpers/secretGoldenInputs.js';

const read = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../crates/harkroom-server/golden/${f}`, import.meta.url)), 'utf8'));
const K = read('secret_keyring.json');
const L = read('secret_leak.json');

function errCode(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'ENOENT') return 'io_not_found';
  if (err.code === 'EISDIR') return 'not_a_file';
  if (/32바이트 키/.test(err.message)) return 'bad_key_file';
  if (/키 파일이 없다/.test(err.message)) return 'no_keys';
  if (/HARKROOM_SECRET_KEY_ID 로 활성 kid/.test(err.message)) return 'need_active_kid';
  if (/활성 kid '.*' 의 키가 없다/.test(err.message)) return 'active_missing';
  if (/는 \[a-z0-9_-\] 32자 이내/.test(err.message)) return 'bad_kid';
  return `unknown: ${err.message}`;
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('secret_keyring.json 이 TS 와 같다', () => {
  it('parseKey', () => {
    for (const c of K.parseKey) {
      const got = parseKey(keyText(c.input));
      expect(got !== null, c.name).toBe(c.ok);
      if (got) expect(got.equals(patternKey(c.input.key)), c.name).toBe(true);
    }
  });

  it('keyCheckValue', () => {
    for (const c of K.kcv) expect(keyCheckValue(patternKey(c.key)).toString('hex')).toBe(c.kcvHex);
  });

  it('loadSecretKeys', () => {
    for (const c of K.load as LoadCase[]) {
      const dir = buildLoadDir(c);
      if (c.dir === 'dir' || c.dir === 'missing') dirs.push(c.dir === 'missing' ? dir!.replace(/\/nope$/, '') : dir!);
      let got: unknown;
      try {
        const r = loadSecretKeys(dir, c.active);
        if (!r) got = { none: true };
        else {
          const keys: Record<string, PatternKey> = {};
          for (const [kid, key] of r.keys) {
            const want = (c.expect as { keys?: Record<string, PatternKey> }).keys?.[kid];
            keys[kid] = want && patternKey(want).equals(key) ? want : { from: -1 };
          }
          got = { kids: [...r.keys.keys()].sort(), active: r.activeKid, keys };
        }
      } catch (e) {
        got = { error: errCode(e) };
      }
      expect(got, c.name).toEqual(c.expect);
    }
  });

  it('createSecretKeyring 의 kid·활성 검사', () => {
    for (const c of K.keyring as { name: string; kids: string[]; active: string; expect: string }[]) {
      let got = 'ok';
      try { createSecretKeyring(new Map(c.kids.map((k, i) => [k, patternKey({ from: i })])), c.active); } catch (e) { got = errCode(e); }
      expect(got, c.name).toBe(c.expect);
    }
  });

  it('open — 의도된 차이(b) 칸은 Rust 만 엄격하다', () => {
    const keys = new Map(Object.entries(K.open.keys as Record<string, PatternKey>).map(([k, p]) => [k, patternKey(p)]));
    const ring = createSecretKeyring(keys, 'k1');
    for (const c of K.open.cases as { name: string; sealed: string; aad: SecretAad; ts: string | null; rust: string | null; intended?: string }[]) {
      const got = ring.open(c.sealed, c.aad);
      expect(got ? got.toString('hex') : null, c.name).toBe(c.ts);
      if (c.intended) expect([c.ts !== null, c.rust], c.name).toEqual([true, null]);
      else expect(c.rust, c.name).toBe(c.ts);
    }
    expect(new Set((K.open.cases as { intended?: string }[]).map((c) => c.intended).filter(Boolean))).toEqual(new Set(['b']));
  });
});

describe('secret_leak.json 이 TS 와 같다', () => {
  it('상수·거절 문장', () => {
    expect(L.minChars).toBe(LEAK_MIN_CHARS);
    expect(L.refusal).toEqual(SECRET_IN_BODY);
  });

  it('needlesFor', () => {
    for (const c of L.needles) expect(needlesFor(valueBytes(c.value)), c.name).toEqual(c.needles);
  });

  it('collectStrings', () => {
    for (const c of L.collect) expect(collectStrings(c.json), c.name).toEqual(c.strings);
  });

  type Spec = { id: string; name: string; value: ValueSpec };
  const ring = createSecretKeyring(new Map([['k1', patternKey({ from: 0x80 })]]), 'k1');
  const guard = (secrets: Spec[]) => {
    const rows = secrets.map((s) => ({ id: s.id, name: s.name, kind: 'text' as const, version: 1, sealed: ring.seal(valueBytes(s.value), { secretId: s.id, version: 1, kind: 'text' }) }));
    return createSecretLeakGuard({ query: async () => ({ rows }) } as unknown as Pool, ring)!;
  };

  it('findInTexts', async () => {
    for (const c of L.texts) expect((await guard(c.secrets).findInTexts('agent', c.texts)).map((h) => h.id), c.name).toEqual(c.hits);
  });

  it('findInBytes', async () => {
    for (const c of L.bytes) expect((await guard(c.secrets).findInBytes('agent', valueBytes(c.bytes))).map((h) => h.id), c.name).toEqual(c.hits);
  });
});
