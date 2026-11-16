#!/usr/bin/env tsx
/**
 * Rust memory.search 순수 판정(`crates/harkroom-server/src/core/mem_search.rs`)의 골든을 TS 정본(`src/services/memory.ts`)으로 만든다.
 * 결과(`golden/memory_search.json`)는 커밋하고, TS 시험(`test/rustMemorySearchGolden.test.ts`)과 Rust 시험은 **읽어서 대조만** 한다.
 *
 * 실행(저장소 루트에서): `pnpm --filter @harkroom/server exec tsx scripts/genRustMemorySearchGolden.ts`
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { memorySearchGolden } from '../test/helpers/memorySearchGolden.js';

const OUT = fileURLToPath(new URL('../../../crates/harkroom-server/golden/memory_search.json', import.meta.url));
const g = memorySearchGolden();
writeFileSync(OUT, `${JSON.stringify(g, null, 1)}\n`);
console.log(`terms ${g.terms.length} · rank ${g.rank.length} · threadState ${g.threadState.length}`);
