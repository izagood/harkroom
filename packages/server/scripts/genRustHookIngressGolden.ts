#!/usr/bin/env tsx
/**
 * Rust hook 입구(`crates/harkroom-server/src/core/automation_hooks.rs`)의 골든을 TS 정본(`src/services/automationIngress.ts`)으로 만든다.
 * 결과(`golden/hook_ingress.json`)는 커밋하고, TS 시험(`test/rustHookIngressGolden.test.ts`)과 Rust 시험은 **읽어서 대조만** 한다.
 *
 * 실행(저장소 루트에서): `pnpm --filter @harkroom/server exec tsx scripts/genRustHookIngressGolden.ts`
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { genericVars, globToRegExp } from '../src/services/automationIngress.js';
import { genericBodies, githubCases, githubWant, globPairs, rustDecided } from '../test/helpers/hookIngressGoldenInputs.js';

const OUT = fileURLToPath(new URL('../../../crates/harkroom-server/golden/hook_ingress.json', import.meta.url));

/** TS hooks 범위의 `parse` + `genericVars`. 깨진 JSON 은 null(bad_json). 순서를 지키려고 [키, 값] 쌍으로 적는다. */
export function genericWant(raw: string): [string, string][] | null {
  let payload: unknown = {};
  if (raw.length > 0) {
    try { payload = JSON.parse(raw); } catch { return null; }
  }
  return Object.entries(genericVars(payload));
}

const out = {
  generic: genericBodies().map((raw) => ({ raw, want: genericWant(raw) })),
  glob: globPairs().map(([glob, path]) => ({ glob, path, want: globToRegExp(glob).test(path) })),
  github: githubCases().map((c) => ({ ...c, want: githubWant(c) })),
  // TS 와 Rust 가 갈리고 jaebin 이 Rust 를 정답으로 정한 꼴(11-19). `ts` 는 TS 가 지금 하는 일(시험이 그대로인지 본다), `rust` 가 정답.
  rustDecided: rustDecided().map((c) => ({ ...c, ts: c.ts() })),
};
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
console.log(`generic ${out.generic.length} · glob ${out.glob.length} · github ${out.github.length} · rustDecided ${out.rustDecided.length}`);
