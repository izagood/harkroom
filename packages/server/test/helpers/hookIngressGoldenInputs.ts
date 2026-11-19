import { genericVars as genericVarsForGolden, matchGithub } from '../../src/services/automationIngress.js';

const matchGithubForGolden = (payload: Record<string, unknown>) =>
  matchGithub({ kind: 'github', repo: 'acme/app', event: 'push' } as never, 'push', payload);

// Rust hook 입구 골든(`crates/harkroom-server/golden/hook_ingress.json`)의 입력. 생성 스크립트(`scripts/genRustHookIngressGolden.ts`)와
// TS 시험이 같이 쓴다. P5 PR3b — generic 본문(JS `Object.entries` 순서·50칸 상한·`String(number)`)과 paths 글롭(UTF-16·줄 끝)의 경계를 짚는다.

/** `/hooks/generic/:id` 본문 원문(utf-8). TS 는 `JSON.parse` 뒤 `genericVars`, 깨지면 bad_json. */
export function genericBodies(): string[] {
  const many = (n: number, f: (i: number) => string) => `{${Array.from({ length: n }, (_, i) => f(i)).join(',')}}`;
  const nums = [
    '0', '-0', '1', '100', '1E2', '1e21', '1e20', '123456789012345678901', '9007199254740993', '0.1', '0.000001', '1e-7', '1.5e-7',
    '1.5e300', '5e-324', '2.2250738585072014e-308', '0.30000000000000004', '-12.5', '1.7976931348623157e308', '4.35', '123.456e10',
  ];
  return [
    '', '{}', '[]', '[1,2]', '"str"', 'null', '123', 'true', '{', '{"a":1,}', ' {"a":1} ', '\n{"a":"x"}\t',
    '{"a":1,"b":"x","c":true,"d":false,"e":null,"f":{"g":1},"h":[1]}',
    // 첨자 키는 숫자 순으로 먼저, 나머지는 처음 나온 순서. 2^32-2 까지가 첨자, 01·-1·1.0 은 아니다.
    '{"b":1,"2":2,"1":3,"a":4,"0":5}', '{"4294967294":1,"4294967295":2,"01":3,"-1":4,"1.0":5,"10":6,"9":7}',
    // 같은 키 — 자리는 처음 것, 값은 마지막 것.
    '{"a":1,"b":2,"a":3}', '{"a":{"x":1},"b":2,"a":"s"}', '{"a":"s","a":{"x":1}}',
    // 50칸 상한 — 잘못된 키·깊은 값도 칸을 먹는다.
    many(51, (i) => `"k${i}":${i}`), many(51, (i) => `"${i === 0 ? 'bad key' : `k${i}`}":${i}`), many(51, (i) => `"k${i}":${i < 3 ? '{}' : i}`),
    many(60, (i) => `"${60 - i}":${i}`), many(52, (i) => (i < 2 ? `"z${i}":${i}` : `"${i}":${i}`)),
    // 키 꼴: [\w.-]{1,64}(ASCII 만).
    `{"${'a'.repeat(64)}":1,"${'b'.repeat(65)}":2,"a.b-c_d":3,"가":4,"é":5,"":6,"a b":7,"\\u0041":8}`,
    // 숫자 → String(number).
    `{${nums.map((n, i) => `"n${i}":${n}`).join(',')}}`,
    // 문자열 → 줄바꿈 접기·@ 끊기·1000자 자르기·이스케이프.
    '{"s":"a\\nb\\r\\nc","m":"@forge hi <@x>","u":"\\u0040x","e":"😀가","t":"\\ud83d\\ude00"}',
    `{"long":"${'x'.repeat(1001)}","ok":"${'y'.repeat(1000)}","emo":"x${'😀'.repeat(600)}"}`,
    // 1000칸 자르기가 서로게이트 쌍 가운데에 걸리는 꼴(`'😀'.repeat(600)`)은 넣지 않는다 — TS 는 짝 없는 서로게이트를 jsonb 에 쓰다 500,
    // Rust 는 U+FFFD 로 바꿔 받는다 — Rust 가 정답(jaebin 11-19), `rustDecided` 의 surrogate_cut.
  ];
}

/** paths 글롭 대조 — [글롭, 경로]. TS 는 `globToRegExp(g).test(p)`. */
export function globPairs(): [string, string][] {
  return [
    ['src/**', 'src/a/b.ts'], ['src/**', 'src'], ['src/**', 'src/'], ['**/x.ts', 'x.ts'], ['**/x.ts', 'a/b/x.ts'], ['**/', 'a/'],
    ['**/*', 'a/b'], ['a/**/b?.c', 'a/q/r/b1.c'], ['a/*.c', 'a/q/b.c'], ['a/*.c', 'a/.c'], ['src/**/*.rs', 'src/main.rs'],
    ['?', '😀'], ['??', '😀'], ['?', '가'], ['문서/*.md', '문서/가.md'], ['문서/**', '문서/a/b'], ['é', 'é'], ['é', 'é'],
    ['**', 'a\nb'], ['*', 'a\nb'], ['**', 'a b'], ['**', 'a\rb'], ['?', '\n'], ['a.b', 'axb'], ['a.b', 'a.b'],
    ['[x]', '[x]'], ['[x]', 'x'], ['(a|b)', '(a|b)'], ['a+', 'aa'], ['a+', 'a+'], ['*.TS', 'a.ts'], ['\\d', '\\d'], ['a$', 'a$'],
    ['^a', '^a'], ['{a}', '{a}'], ['***', 'a/b'], ['*/**', 'a'], ['', ''], ['', 'a'], ['Ａ', 'ａ'],
  ];
}

/** P5 PR3c — push 의 path 가 문자열이 아닌 꼴. TS `matchGithub` 이 정본: 글롭은 `String(p)`, 중복은 `Set`(타입까지 본다), 표시는 `String(p ?? '')`. */
export function githubCases(): { name: string; trigger: Record<string, unknown>; event: string; payload: Record<string, unknown> }[] {
  const push = (commits: unknown[]) => ({ repository: { full_name: 'acme/app' }, ref: 'refs/heads/main', after: 'abc', commits });
  const t = (extra: Record<string, unknown> = {}) => ({ kind: 'github', repo: 'acme/app', event: 'push', ...extra });
  const odd = [1, '1', 1, true, 'true', null, 'null', 1.5, 1e21, -0, 0, [], ['a', null, ['b', 2]], {}, { a: 1 }, {}, 'x\ny', '@forge'];
  return [
    { name: 'paths 필터 없이 — 문자열 아닌 path 를 files 에', trigger: t(), event: 'push', payload: push([{ added: odd }]) },
    { name: '** 글롭 — 모두 맞음, 중복은 타입별', trigger: t({ paths: ['**'] }), event: 'push', payload: push([{ added: odd }]) },
    { name: '글롭 1 — 숫자 1 과 문자열 1', trigger: t({ paths: ['1'] }), event: 'push', payload: push([{ added: [1, '1', 1] }]) },
    { name: '글롭 null — null 은 표시가 빈 글자', trigger: t({ paths: ['null'] }), event: 'push', payload: push([{ modified: [null, 'null'] }]) },
    { name: '글롭 [object Object] — 객체는 저마다 다름', trigger: t({ paths: ['[object Object]'] }), event: 'push', payload: push([{ removed: [{}, {}, 'x'] }]) },
    { name: '배열 path 는 , 로 잇는다', trigger: t({ paths: ['a,,b,2'] }), event: 'push', payload: push([{ added: [['a', null, ['b', 2]]] }]) },
    { name: 'change 필터 + 숫자 path', trigger: t({ change: 'removed' }), event: 'push', payload: push([{ added: [3], removed: [3, 4.25] }]) },
    { name: '맞는 것 없음', trigger: t({ paths: ['src/**'] }), event: 'push', payload: push([{ added: [1, true, null] }]) },
    { name: 'commit 이 원시값·배열이면 건너뜀', trigger: t(), event: 'push', payload: push([3, 'c', [1], { added: 'notarray' }, { added: [7] }]) },
  ];
}

/**
 * TS·Rust 가 갈리는데 **Rust 가 정답**인 꼴(jaebin 결정 11-19, P5 PR3b 차이표 1·4·5). `ts()` 는 TS 가 지금 내는 것을 적는다 —
 * 골든에는 그 값과 Rust 정답(`rust`)이 같이 실린다. Rust 시험은 `rust` 를, TS 시험은 `ts` 가 그대로인지를 본다.
 */
export function rustDecided(): { id: string; hook: 'generic' | 'github'; raw: string; rust: unknown; ts: () => string }[] {
  const parses = (raw: string) => { try { JSON.parse(raw); return 'accepts'; } catch { return 'bad_json'; } };
  const deep = `${'['.repeat(129)}${']'.repeat(129)}`;
  const huge = '{"a":1e400}';
  const nullCommit = JSON.stringify({ repository: { full_name: 'acme/app' }, ref: 'refs/heads/main', commits: [null] });
  const cut = JSON.stringify({ s: '😀'.repeat(600) });
  return [
    // 1 — 깊이 128 초과·범위 밖 숫자: JS 는 받지만 Rust(serde_json)는 400 bad_json 이 정답.
    { id: 'depth_129', hook: 'generic', raw: deep, rust: 'bad_json', ts: () => parses(deep) },
    { id: 'number_1e400', hook: 'generic', raw: huge, rust: 'bad_json', ts: () => parses(huge) },
    // 4 — commits 안 null: TS 는 matchGithub 이 던져 500, Rust 는 400 bad_json.
    {
      id: 'commits_null', hook: 'github', raw: nullCommit, rust: 'bad_json',
      ts: () => { try { matchGithubForGolden(JSON.parse(nullCommit)); return 'matched'; } catch { return 'throws'; } },
    },
    // 5 — 1000자 자르기가 서로게이트 쌍 가운데: TS 는 짝 없는 서로게이트(→ jsonb 쓰기 500), Rust 는 U+FFFD 뒤 `…`.
    {
      id: 'surrogate_cut', hook: 'generic', raw: cut, rust: { 'payload.s': `${'😀'.repeat(499)}�…` },
      ts: () => (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(genericVarsForGolden(JSON.parse(cut))['payload.s'] ?? '') ? 'lone_surrogate' : 'ok'),
    },
  ];
}

/** TS `matchGithub` 의 결과 — 맞으면 변수 [키, 값] 쌍(키 순), 아니면 거절 이유. 생성 스크립트와 TS 시험이 같이 쓴다. */
export function githubWant(c: { trigger: Record<string, unknown>; event: string; payload: Record<string, unknown> }) {
  const m = matchGithub(c.trigger as never, c.event, c.payload);
  return m.match ? { vars: Object.entries(m.vars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) } : { reason: m.reason };
}
