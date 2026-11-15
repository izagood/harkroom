// Rust memory.search 순수 판정(`crates/harkroom-server/src/core/mem_search.rs`, S5.3 C4b B1c)의 정본은 `services/memory.ts` 다. 골든
// (`golden/memory_search.json`)은 `scripts/genRustMemorySearchGolden.ts` 가 만들어 커밋한 것이고, 이 시험은 **읽어서 대조만** 한다 —
// TS 낱말 규칙을 고치고 골든을 안 고치면 여기서 빨개지고, Rust 가 따라오는지는 cargo test 가 본다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { memorySearchGolden } from './helpers/memorySearchGolden.js';

const G = JSON.parse(readFileSync(fileURLToPath(new URL('../../../crates/harkroom-server/golden/memory_search.json', import.meta.url)), 'utf8'));

describe('memory_search.json 이 TS 와 같다', () => {
  it('낱말 목록·이름 제외·낱말 뽑기·thread 상태 이름·recall 순위', () => {
    expect(G).toEqual(memorySearchGolden());
  });
});
