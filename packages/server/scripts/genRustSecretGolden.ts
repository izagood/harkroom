#!/usr/bin/env tsx
/**
 * Rust 비밀 열기(`crates/harkroom-server/src/secrets/`)의 골든을 TS 정본(`secretKeyring.ts`·`secretLeakGuard.ts`)으로 **한 번** 만든다.
 * 결과(`golden/secret_keyring.json`·`secret_leak.json`)는 커밋하고, TS 시험(`test/rustSecretGolden.test.ts`)과 Rust 시험은 그 파일을
 * **읽어서 대조만** 한다 — 봉인에 난수(salt·iv)가 들어가므로 시험이 매번 다시 쓰면 대조가 되지 않는다.
 *
 * 실행(저장소 루트에서): `pnpm --filter @harkroom/server exec tsx scripts/genRustSecretGolden.ts`
 *
 * 시험 키는 고정 바이트 패턴(`{ from }` → from, from+1, …)이고 파일에는 만드는 법만 적는다(비밀 검사 허용 목록을 넓히지 않는다).
 * 「의도된 차이」(`intended`) 칸은 Rust 가 일부러 더 엄격한 곳이다 — TS 가 만든 봉투에서는 나오지 않는 모양이다:
 *   b = 봉투 칸은 표준 base64(패딩 있음)만. 칸 길이(salt 16·iv 12·tag 16바이트)는 TS·Rust 가 같이 고정한다.
 */
import { createCipheriv, hkdfSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createSecretKeyring, keyCheckValue, loadSecretKeys, parseKey, type SecretAad } from '../src/services/secretKeyring.js';
import { collectStrings, createSecretLeakGuard, LEAK_MIN_CHARS, needlesFor, SECRET_IN_BODY } from '../src/services/secretLeakGuard.js';
import {
  buildLoadDir, keyText, patternKey, valueBytes,
  type KeyTextSpec, type LoadCase, type PatternKey, type ValueSpec,
} from '../test/helpers/secretGoldenInputs.js';

const OUT = (f: string) => fileURLToPath(new URL(`../../../crates/harkroom-server/golden/${f}`, import.meta.url));
const write = (f: string, v: unknown) => writeFileSync(OUT(f), `${JSON.stringify(v, null, 2)}\n`);

// ── 키 파일 내용 ─────────────────────────────────────────────────────────────────────────────
const K0: PatternKey = { from: 0 };
const parseCases: { name: string; input: KeyTextSpec }[] = [
  { name: 'hex 소문자', input: { key: K0, enc: 'hex' } },
  { name: 'hex 대문자', input: { key: K0, enc: 'hexUpper' } },
  { name: 'hex 섞임', input: { key: K0, enc: 'hexMixed' } },
  { name: 'hex 앞뒤 줄바꿈·공백', input: { key: K0, enc: 'hex', pre: '\n  ', post: '\n' } },
  { name: 'hex 앞 BOM — JS trim 은 지운다', input: { key: K0, enc: 'hex', pre: '﻿' } },
  { name: 'hex 앞 NBSP·뒤 LS', input: { key: K0, enc: 'hex', pre: ' ', post: ' ' } },
  { name: 'hex 뒤 NEL — JS trim 은 남긴다', input: { key: K0, enc: 'hex', post: '\u0085' } },
  { name: 'hex 62자', input: { key: K0, enc: 'hex', cut: 62 } },
  { name: 'hex 66자', input: { key: K0, enc: 'hex', add: '00' } },
  { name: 'hex 가운데 공백', input: { key: K0, enc: 'hex', replace: ['00', '0 '] } },
  { name: 'base64 44자', input: { key: { from: 0x10 }, enc: 'b64' } },
  { name: 'base64 뒤 줄바꿈', input: { key: { from: 0x10 }, enc: 'b64', post: '\r\n' } },
  { name: 'base64 버려지는 비트가 켜짐', input: { key: { from: 0x10 }, enc: 'b64', bumpLast: true } },
  { name: 'base64 43자(패딩 없음)', input: { key: { from: 0x10 }, enc: 'b64', cut: 43 } },
  { name: 'base64 45자', input: { key: { from: 0x10 }, enc: 'b64', add: '=' } },
  { name: 'base64 url-safe 글자', input: { key: { from: 0x10 }, enc: 'b64', replace: ['E', '-'] } },
  { name: 'base64 33바이트', input: { key: { from: 0x10, len: 33 }, enc: 'b64' } },
  { name: 'base64 31바이트', input: { key: { from: 0x10, len: 31 }, enc: 'b64' } },
  { name: '빈 파일', input: { text: '' } },
  { name: '글자', input: { text: 'not a key file at all, just words' } },
];
const parseKeyOut = parseCases.map((c) => {
  const got = parseKey(keyText(c.input));
  if (got && !got.equals(patternKey(c.input.key!))) throw new Error(`parseKey ${c.name}: 다른 키`);
  return { ...c, ok: got !== null };
});

const kcvOut = [K0, { from: 0x40 }, { from: 0xf0 }].map((key) => ({ key, kcvHex: keyCheckValue(patternKey(key)).toString('hex') }));

// ── 키 디렉터리 읽기 ─────────────────────────────────────────────────────────────────────────
const KA: PatternKey = { from: 0x20 };
const KB: PatternKey = { from: 0x60 };
const hexOf = (key: PatternKey): KeyTextSpec => ({ key, enc: 'hex', post: '\n' });
const loadCases: Omit<LoadCase, 'expect'>[] = [
  { name: 'env 없음 → 꺼짐', dir: 'unset' },
  { name: 'env 공백 → 꺼짐', dir: 'blank' },
  { name: '없는 디렉터리', dir: 'missing' },
  { name: '빈 디렉터리', dir: 'dir', entries: [] },
  { name: '점 파일만', dir: 'dir', entries: [{ name: '.keep', content: { text: 'x' } }] },
  { name: '키 하나 · 활성 생략', dir: 'dir', entries: [{ name: 'k1', content: hexOf(KA) }] },
  { name: '키 하나 · 활성 공백', dir: 'dir', entries: [{ name: 'k1', content: hexOf(KA) }], active: '  ' },
  { name: '키 둘 · 활성 생략', dir: 'dir', entries: [{ name: 'k1', content: hexOf(KA) }, { name: 'k2', content: { key: KB, enc: 'b64' } }] },
  { name: '키 둘 · 활성 k2(앞뒤 공백)', dir: 'dir', entries: [{ name: 'k1', content: hexOf(KA) }, { name: 'k2', content: { key: KB, enc: 'b64' } }], active: ' k2\n' },
  { name: '활성 kid 없음', dir: 'dir', entries: [{ name: 'k1', content: hexOf(KA) }], active: 'k3' },
  { name: '키가 아닌 파일', dir: 'dir', entries: [{ name: 'k1', content: hexOf(KA) }, { name: 'k2', content: { text: 'junk' } }], active: 'k1' },
  { name: '점 파일은 건너뜀', dir: 'dir', entries: [{ name: '.junk', content: { text: 'junk' } }, { name: 'k1', content: hexOf(KA) }] },
  { name: '하위 디렉터리', dir: 'dir', entries: [{ name: 'k1', content: hexOf(KA) }, { name: 'sub', dir: true }], active: 'k1' },
  {
    name: 'k8s 볼륨 꼴(..data 디렉터리 + 심링크)',
    dir: 'dir',
    entries: [
      { name: '..2026_11_16_00_00_00.000000001', dir: true },
      { name: '..2026_11_16_00_00_00.000000001/k1', content: hexOf(KA) },
      { name: '..2026_11_16_00_00_00.000000001/k2', content: { key: KB, enc: 'b64', post: '\n' } },
      { name: '..data', link: '..2026_11_16_00_00_00.000000001' },
      { name: 'k1', link: '..data/k1' },
      { name: 'k2', link: '..data/k2' },
    ],
    active: 'k2',
  },
  { name: 'kid 꼴이 아닌 파일 이름도 읽기는 됨', dir: 'dir', entries: [{ name: 'K_Upper', content: hexOf(KA) }] },
  { name: 'BOM 붙은 키 파일', dir: 'dir', entries: [{ name: 'k1', content: { key: KA, enc: 'hex', pre: '﻿' } }] },
];

function errCode(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'ENOENT') return 'io_not_found';
  if (err.code === 'EISDIR') return 'not_a_file';
  if (/32바이트 키/.test(err.message)) return 'bad_key_file';
  if (/키 파일이 없다/.test(err.message)) return 'no_keys';
  if (/HARKROOM_SECRET_KEY_ID 로 활성 kid/.test(err.message)) return 'need_active_kid';
  if (/활성 kid '.*' 의 키가 없다/.test(err.message)) return 'active_missing';
  if (/는 \[a-z0-9_-\] 32자 이내/.test(err.message)) return 'bad_kid';
  throw new Error(`분류 못 한 오류: ${err.message}`);
}

const loadOut = loadCases.map((c) => {
  try {
    const got = loadSecretKeys(buildLoadDir(c as LoadCase), c.active);
    if (!got) return { ...c, expect: { none: true } };
    const keys: Record<string, PatternKey> = {};
    for (const [kid, key] of got.keys) {
      const p = [KA, KB].find((k) => patternKey(k).equals(key));
      if (!p) throw new Error(`${c.name}: 모르는 키`);
      keys[kid] = p;
    }
    return { ...c, expect: { kids: [...got.keys.keys()].sort(), active: got.activeKid, keys } };
  } catch (e) {
    return { ...c, expect: { error: errCode(e) } };
  }
});

const keyringCases: { name: string; kids: string[]; active: string }[] = [
  { name: '보통', kids: ['k1', 'k2'], active: 'k1' },
  { name: '32자 kid', kids: ['a'.repeat(32)], active: 'a'.repeat(32) },
  { name: '33자 kid', kids: ['a'.repeat(33)], active: 'a'.repeat(33) },
  { name: '대문자 kid', kids: ['K1'], active: 'K1' },
  { name: '- 로 시작', kids: ['-k'], active: '-k' },
  { name: '_ 로 시작', kids: ['_k'], active: '_k' },
  { name: '점이 든 kid', kids: ['k.1'], active: 'k.1' },
  { name: '빈 kid', kids: [''], active: '' },
  { name: '숫자로 시작·_- 섞임', kids: ['0k_-9'], active: '0k_-9' },
  { name: '활성 kid 가 목록에 없음', kids: ['k1'], active: 'k2' },
];
const keyringOut = keyringCases.map((c) => {
  try {
    createSecretKeyring(new Map(c.kids.map((k, i) => [k, patternKey({ from: i })])), c.active);
    return { ...c, expect: 'ok' };
  } catch (e) {
    return { ...c, expect: errCode(e) };
  }
});

// ── 봉투 열기 ───────────────────────────────────────────────────────────────────────────────
const OPEN_KEYS: Record<string, PatternKey> = { k1: { from: 0x80 }, k2: { from: 0xc0 } };
const keysMap = new Map(Object.entries(OPEN_KEYS).map(([k, p]) => [k, patternKey(p)]));
const ring1 = createSecretKeyring(keysMap, 'k1');
const ring2 = createSecretKeyring(keysMap, 'k2');
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

/** TS seal 과 같은 식으로, 길이만 바꿔 봉인한다(길이 고정 경우용). */
function sealWith(kid: string, plain: Buffer, a: SecretAad, saltLen: number, ivLen: number): string {
  const aad = Buffer.from(`harkroom-secret-v2|${a.secretId}|${a.version}|${a.kind}|${kid}`, 'utf8');
  const salt = Buffer.alloc(saltLen, 0x5a);
  const iv = Buffer.alloc(ivLen, 0xa5);
  const key = Buffer.from(hkdfSync('sha256', keysMap.get(kid)!, salt, aad, 32));
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ['v2', kid, salt.toString('base64'), iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

const field = (s: string, i: number, f: (b: Buffer) => string) => {
  const p = s.split('.');
  p[i] = f(Buffer.from(p[i]!, 'base64'));
  return p.join('.');
};
const flip = (s: string, i: number) => field(s, i, (b) => { const c = Buffer.from(b); c[0]! ^= 1; return c.toString('base64'); });

const aText1: SecretAad = { secretId: ID1, version: 1, kind: 'text' };
const aText2: SecretAad = { secretId: ID1, version: 2, kind: 'text' };
const aFile: SecretAad = { secretId: ID2, version: 7, kind: 'file' };
const vText1 = valueBytes({ text: 'golden-value-one' });
const vText2 = valueBytes({ text: '비밀값 ✓ 두 번째 판' });
const vFile = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const s1 = ring1.seal(vText1, aText1);
const s2 = ring1.seal(vText2, aText2);
const sEmpty = ring1.seal(Buffer.alloc(0), aText1);
const sFile = ring2.seal(vFile, aFile);

type OpenCase = { name: string; sealed: string; aad: SecretAad; intended?: 'b' };
const openCases: OpenCase[] = [
  { name: '글자 값', sealed: s1, aad: aText1 },
  { name: '유니코드 값 · 판 2', sealed: s2, aad: aText2 },
  { name: '빈 값', sealed: sEmpty, aad: aText1 },
  { name: '파일 값 · 다른 kid', sealed: sFile, aad: aFile },
  { name: 'AAD secretId 다름', sealed: s1, aad: { ...aText1, secretId: ID2 } },
  { name: 'AAD version 다름', sealed: s1, aad: { ...aText1, version: 2 } },
  { name: 'AAD kind 다름', sealed: s1, aad: { ...aText1, kind: 'file' } },
  { name: 'kid 칸만 바꿈', sealed: s1.replace('v2.k1.', 'v2.k2.'), aad: aText1 },
  { name: '모르는 kid', sealed: s1.replace('v2.k1.', 'v2.k9.'), aad: aText1 },
  { name: 'v1 머리', sealed: s1.replace(/^v2\./, 'v1.'), aad: aText1 },
  { name: 'V2 대문자 머리', sealed: s1.replace(/^v2\./, 'V2.'), aad: aText1 },
  { name: '칸 다섯', sealed: s1.split('.').slice(0, 5).join('.'), aad: aText1 },
  { name: '칸 일곱', sealed: `${s1}.AA==`, aad: aText1 },
  { name: '빈 글자', sealed: '', aad: aText1 },
  { name: 'salt 1비트', sealed: flip(s1, 2), aad: aText1 },
  { name: 'iv 1비트', sealed: flip(s1, 3), aad: aText1 },
  { name: 'tag 1비트', sealed: flip(s1, 4), aad: aText1 },
  { name: 'ct 1비트', sealed: flip(s1, 5), aad: aText1 },
  { name: 'tag 12바이트로 자름', sealed: field(s1, 4, (b) => b.subarray(0, 12).toString('base64')), aad: aText1 },
  { name: 'tag 4바이트로 자름', sealed: field(s1, 4, (b) => b.subarray(0, 4).toString('base64')), aad: aText1 },
  { name: 'iv 16바이트로 봉인', sealed: sealWith('k1', vText1, aText1, 16, 16), aad: aText1 },
  { name: 'iv 8바이트로 봉인', sealed: sealWith('k1', vText1, aText1, 16, 8), aad: aText1 },
  { name: 'ct 를 패딩 없는 base64 로', sealed: field(s1, 5, (b) => b.toString('base64').replace(/=+$/, '')), aad: aText1, intended: 'b' },
  { name: 'ct 를 base64url 로', sealed: field(s2, 5, (b) => b.toString('base64url')), aad: aText2, intended: 'b' },
  { name: 'salt 에 공백', sealed: field(s1, 2, (b) => ` ${b.toString('base64')}`), aad: aText1, intended: 'b' },
  { name: 'salt 17바이트로 봉인', sealed: sealWith('k1', vText1, aText1, 17, 12), aad: aText1 },
  { name: 'salt 0바이트로 봉인', sealed: sealWith('k1', vText1, aText1, 0, 12), aad: aText1 },
  { name: '길이는 맞게 봉인(대조용)', sealed: sealWith('k1', vText1, aText1, 16, 12), aad: aText1 },
];
const openOut = openCases.map((c) => {
  const ts = ring1.open(c.sealed, c.aad);
  const tsHex = ts ? ts.toString('hex') : null;
  if (c.intended && tsHex === null) throw new Error(`${c.name}: 의도된 차이인데 TS 도 못 연다`);
  return { ...c, ts: tsHex, rust: c.intended ? null : tsHex };
});

write('secret_keyring.json', {
  _: 'TS secretKeyring.ts 가 낸 결과 — scripts/genRustSecretGolden.ts 로 만들고 TS·Rust 시험은 읽어서 대조만 한다. 키는 { from } 바이트 패턴.',
  intended: { b: '봉투 칸은 표준 base64(패딩 있음)만' },
  parseKey: parseKeyOut,
  kcv: kcvOut,
  load: loadOut,
  keyring: keyringOut,
  open: { keys: OPEN_KEYS, cases: openOut },
});

// ── 누출 검사 ───────────────────────────────────────────────────────────────────────────────
const PEM = '-----BEGIN TEST BLOCK-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldY\r\nshort line\n  fifteen-chars!  \nsixteen-chars-ok\nlone\rcarriage return line\n-----END TEST BLOCK-----\n';
const needleValues: { name: string; value: ValueSpec }[] = [
  { name: '7바이트 — 하한 아래', value: { text: 'short7!' } },
  { name: '8바이트 — 하한', value: { text: 'exactly8' } },
  { name: '한글 9바이트 · UTF-16 3칸', value: { text: '가나다' } },
  { name: '앞뒤 공백', value: { text: '  padded value  ' } },
  { name: '앞 BOM', value: { text: '﻿bom-led value' } },
  { name: '뒤 NEL', value: { text: 'nel trailing value\u0085' } },
  { name: '공백만', value: { text: '        \t ' } },
  { name: 'URL 특수 글자', value: { text: "a b&c=d/e?f+g~h*i'j(k)l!m-n_o.p" } },
  { name: '이모지 넷 · UTF-16 8칸', value: { text: '🔑🔑🔑🔑' } },
  { name: '이모지 셋 · UTF-16 6칸', value: { text: '🔑🔑🔑' } },
  { name: '여러 줄(줄 하한 16)', value: { text: PEM } },
  { name: '잘못된 UTF-8', value: { hex: 'fffefdfcfbfaf9f8f7' } },
  { name: '이진 256바이트', value: { hex: Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i)).toString('hex') } },
];
const needlesOut = needleValues.map((c) => ({ ...c, needles: needlesFor(valueBytes(c.value)) }));

const deep = (n: number, i = 0): unknown => (i >= n ? `leaf${i}` : [`d${i}`, deep(n, i + 1)]);
const deepObj = (n: number, i = 0): unknown => (i >= n ? `leaf${i}` : { [`k${i}`]: deepObj(n, i + 1), [`s${i}`]: `v${i}` });
const collectCases: { name: string; json: unknown }[] = [
  { name: '글자 하나', json: 'just a string' },
  { name: '숫자·null·참거짓', json: [1, null, true, 2.5, 'x'] },
  { name: '객체 키도 모음', json: { alpha: 'one', beta: [{ gamma: 'two' }, 'three'], delta: { '': 'empty-key' } } },
  { name: '배열 깊이 40', json: deep(40) },
  { name: '객체 깊이 40', json: deepObj(40) },
];
const collectOut = collectCases.map((c) => ({ ...c, strings: collectStrings(c.json) }));

type LeakSecretSpec = { id: string; name: string; value: ValueSpec };
const S = (n: number, value: ValueSpec): LeakSecretSpec => ({ id: `0000000${n}-0000-4000-8000-00000000000${n}`, name: `test-secret-${n}`, value });
const vPlain = S(1, { text: 'golden leak value one' });
const vShort = S(2, { text: 'short7!' });
const vPem = S(3, { text: PEM });
const vBin = S(4, { hex: 'fffefdfcfbfaf9f8f7f6' });
const vUni = S(5, { text: '가나다라마바사아' });
const b64 = (s: LeakSecretSpec) => valueBytes(s.value).toString('base64');
const textCases: { name: string; secrets: LeakSecretSpec[]; texts: string[] }[] = [
  { name: '평문 그대로', secrets: [vPlain], texts: ['before golden leak value one after'] },
  { name: '걸리지 않음', secrets: [vPlain], texts: ['nothing to see here at all'] },
  { name: 'base64', secrets: [vPlain], texts: [`x ${b64(vPlain)} y`] },
  { name: 'base64 패딩 없음', secrets: [vPlain], texts: [`x${b64(vPlain).replace(/=+$/, '')}y`] },
  { name: 'base64url', secrets: [vBin], texts: [`id=${valueBytes(vBin.value).toString('base64url')}`] },
  { name: 'URL 인코딩', secrets: [vUni], texts: [`q=${encodeURIComponent('가나다라마바사아')}`] },
  { name: '한글 평문', secrets: [vUni], texts: ['앞 가나다라마바사아 뒤'] },
  { name: '여러 줄 값의 한 줄', secrets: [vPem], texts: ['line: QUJDREVGR0hJSktMTU5PUFFSU1RVVldY'] },
  { name: '15자 줄은 바늘 아님', secrets: [vPem], texts: ['line: fifteen-chars!'] },
  { name: '16자 줄은 바늘', secrets: [vPem], texts: ['line: sixteen-chars-ok'] },
  { name: '외톨이 CR 은 줄을 나누지 않음', secrets: [vPem], texts: ['carriage return line only'] },
  { name: '7바이트 값은 보지 않음', secrets: [vShort], texts: ['short7! short7! short7!'] },
  { name: '8칸 미만 글은 보지 않음', secrets: [vPlain], texts: ['short'] },
  { name: '여럿 중 둘', secrets: [vPlain, vShort, vUni], texts: ['zzz', `${b64(vUni)}`, 'golden leak value one'] },
];
const bytesCases: { name: string; secrets: LeakSecretSpec[]; bytes: ValueSpec }[] = [
  { name: '이진 값 그대로', secrets: [vBin], bytes: { hex: `00${'fffefdfcfbfaf9f8f7f6'}00` } },
  { name: '이진 값의 base64 글자', secrets: [vBin], bytes: { text: `blob:${valueBytes(vBin.value).toString('base64')}` } },
  { name: '평문 값 바이트', secrets: [vPlain], bytes: { text: 'file body golden leak value one end' } },
  { name: '8바이트 미만 첨부', secrets: [vPlain], bytes: { text: 'tiny' } },
  { name: '7바이트 값은 그대로 들어 있어도 안 봄', secrets: [vShort], bytes: { text: 'xx short7! xx' } },
  { name: '걸리지 않음', secrets: [vBin, vPlain], bytes: { hex: '0102030405060708090a' } },
];

async function hits(secrets: LeakSecretSpec[], run: (g: NonNullable<ReturnType<typeof createSecretLeakGuard>>) => Promise<{ id: string }[]>) {
  const rows = secrets.map((s) => ({ id: s.id, name: s.name, kind: 'text' as const, version: 1, sealed: ring1.seal(valueBytes(s.value), { secretId: s.id, version: 1, kind: 'text' }) }));
  const pool = { query: async () => ({ rows }) } as unknown as Pool;
  return (await run(createSecretLeakGuard(pool, ring1)!)).map((h) => h.id);
}
const textsOut = await Promise.all(textCases.map(async (c) => ({ ...c, hits: await hits(c.secrets, (g) => g.findInTexts('agent', c.texts)) })));
const bytesOut = await Promise.all(bytesCases.map(async (c) => ({ ...c, hits: await hits(c.secrets, (g) => g.findInBytes('agent', valueBytes(c.bytes))) })));

write('secret_leak.json', {
  _: 'TS secretLeakGuard.ts 가 낸 결과 — scripts/genRustSecretGolden.ts 로 만들고 TS·Rust 시험은 읽어서 대조만 한다. 값은 시험용 글자.',
  minChars: LEAK_MIN_CHARS,
  lineMinChars: 16,
  refusal: SECRET_IN_BODY,
  needles: needlesOut,
  collect: collectOut,
  texts: textsOut,
  bytes: bytesOut,
});
console.log('golden written');
