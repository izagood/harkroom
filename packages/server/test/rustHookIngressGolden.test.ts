// Rust hook 입구(`crates/harkroom-server/src/core/automation_hooks.rs`, P5 PR3b)의 정본은 `automationIngress.ts` 다. 골든
// (`golden/hook_ingress.json`)은 `scripts/genRustHookIngressGolden.ts` 가 만들어 커밋한 것이고, 이 시험은 **읽어서 대조만** 한다 —
// TS 를 고치고 골든을 안 고치면 여기서 빨개지고, Rust 가 따라오는지는 cargo test(`hook_ingress_golden`)가 본다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { genericVars, globToRegExp } from '../src/services/automationIngress.js';
import { genericBodies, globPairs } from './helpers/hookIngressGoldenInputs.js';

const G = JSON.parse(readFileSync(fileURLToPath(new URL('../../../crates/harkroom-server/golden/hook_ingress.json', import.meta.url)), 'utf8')) as {
  generic: { raw: string; want: [string, string][] | null }[];
  glob: { glob: string; path: string; want: boolean }[];
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
});
