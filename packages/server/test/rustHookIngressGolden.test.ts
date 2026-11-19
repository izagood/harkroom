// Rust hook 입구(`crates/harkroom-server/src/core/automation_hooks.rs`, P5 PR3b)의 정본은 `automationIngress.ts` 다. 골든
// (`golden/hook_ingress.json`)은 `scripts/genRustHookIngressGolden.ts` 가 만들어 커밋한 것이고, 이 시험은 **읽어서 대조만** 한다 —
// TS 를 고치고 골든을 안 고치면 여기서 빨개지고, Rust 가 따라오는지는 cargo test(`hook_ingress_golden`)가 본다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { genericVars, globToRegExp } from '../src/services/automationIngress.js';
import { genericBodies, githubCases, githubWant, globPairs, rustDecided } from './helpers/hookIngressGoldenInputs.js';

const G = JSON.parse(readFileSync(fileURLToPath(new URL('../../../crates/harkroom-server/golden/hook_ingress.json', import.meta.url)), 'utf8')) as {
  generic: { raw: string; want: [string, string][] | null }[];
  glob: { glob: string; path: string; want: boolean }[];
  github: { name: string; want: unknown }[];
  rustDecided: { id: string; ts: string }[];
};

function genericWant(raw: string): [string, string][] | null {
  let payload: unknown = {};
  if (raw.length > 0) {
    try { payload = JSON.parse(raw); } catch { return null; }
  }
  return Object.entries(genericVars(payload));
}

describe('hook_ingress.json 이 TS 와 같다', () => {
  it('generic 본문 → 변수(순서·50칸·숫자·문자열)', () => {
    expect(G.generic.map((c) => c.raw)).toEqual(genericBodies());
    for (const c of G.generic) expect(genericWant(c.raw), c.raw.slice(0, 80)).toEqual(c.want);
  });

  it('paths 글롭', () => {
    expect(G.glob.map((c) => [c.glob, c.path])).toEqual(globPairs());
    for (const c of G.glob) expect(globToRegExp(c.glob).test(c.path), `${c.glob} ~ ${c.path}`).toBe(c.want);
  });

  it('push path 가 문자열이 아닌 꼴(matchGithub)', () => {
    const cases = githubCases();
    expect(G.github.map((c) => c.name)).toEqual(cases.map((c) => c.name));
    cases.forEach((c, i) => expect(githubWant(c), c.name).toEqual(G.github[i]!.want));
  });

  // Rust 가 정답인 꼴(jaebin 11-19) — TS 가 아직 그렇게 갈리는지만 본다. 바뀌면 골든을 다시 만들고 결정을 다시 본다.
  it('rustDecided 의 TS 쪽 동작', () => {
    expect(G.rustDecided.map((c) => [c.id, c.ts])).toEqual(rustDecided().map((c) => [c.id, c.ts()]));
  });
});
