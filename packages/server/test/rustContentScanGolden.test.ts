// Rust 쓰기 검사(`crates/harkroom-server/src/core/content_scan.rs`, S5.3 C4b W4)의 정본은 `contentScan.ts` 다. 골든
// (`golden/content_scan.json`)은 `scripts/genRustContentScanGolden.ts` 가 만들어 커밋한 것이고, 이 시험은 **읽어서 대조만** 한다 —
// TS 규칙을 고치고 골든을 안 고치면 여기서 빨개지고, Rust 가 따라오는지는 cargo test 가 본다(규칙 원문 대조 포함).
// 고칠 때: `pnpm --filter @harkroom/server exec tsx scripts/genRustContentScanGolden.ts` 를 돌리고 두 시험을 함께 본다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCAN_RULES, scanWrite } from '../src/services/contentScan.js';
import { contentScanCases } from './helpers/contentScanGoldenInputs.js';

const G = JSON.parse(readFileSync(fileURLToPath(new URL('../../../crates/harkroom-server/golden/content_scan.json', import.meta.url)), 'utf8')) as {
  rules: { id: string; label: string; source: string; flags: string }[];
  cases: { parts: (string[] | null)[]; want: unknown }[];
};

describe('content_scan.json 이 TS 와 같다', () => {
  it('규칙 표(id·이유·원문·플래그)', () => {
    expect(G.rules).toEqual(SCAN_RULES.map((r) => ({ id: r.id, label: r.label, source: r.re.source, flags: r.re.flags })));
  });

  it('사례 입력이 지금 입력 목록과 같고, 판정도 같다', () => {
    const inputs = contentScanCases();
    expect(G.cases.length).toBe(inputs.length);
    G.cases.forEach((c, i) => {
      const parts = c.parts.map((p) => (p === null ? null : p.join('')));
      expect(parts).toEqual(inputs[i]);
      expect(scanWrite(...parts), JSON.stringify(parts)).toEqual(c.want);
    });
  });
});
