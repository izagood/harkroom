#!/usr/bin/env tsx
/**
 * Rust 쓰기 검사(`crates/harkroom-server/src/core/content_scan.rs`)의 골든을 TS 정본(`src/services/contentScan.ts`)으로 만든다.
 * 결과(`golden/content_scan.json`)는 커밋하고, TS 시험(`test/rustContentScanGolden.test.ts`)과 Rust 시험은 **읽어서 대조만** 한다.
 * TS 규칙을 고치면 TS 시험이 빨개지고(골든의 규칙 원문이 달라진다), 골든을 다시 만들면 Rust 시험이 빨개진다(규칙 원문 대조).
 *
 * 실행(저장소 루트에서): `pnpm --filter @harkroom/server exec tsx scripts/genRustContentScanGolden.ts`
 *
 * 입력은 비밀 검사(gitleaks)에 걸리지 않게 **코드 포인트 6개씩 잘라** 적는다(`parts[i]` = 조각 배열, 이어 붙이면 원문).
 * 이 파일의 토큰 꼴 값도 `'gh' + 'p_'` 처럼 쪼개 쓴다 — 허용 목록을 넓히지 않는다.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCAN_RULES, scanWrite } from '../src/services/contentScan.js';
import { contentScanCases } from '../test/helpers/contentScanGoldenInputs.js';

const OUT = fileURLToPath(new URL('../../../crates/harkroom-server/golden/content_scan.json', import.meta.url));
const chunk = (s: string | null | undefined) => {
  if (s === null || s === undefined) return null;
  const cps = Array.from(s);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += 6) out.push(cps.slice(i, i + 6).join(''));
  return out;
};

const cases = contentScanCases().map((parts) => ({ parts: parts.map(chunk), want: scanWrite(...parts) }));
const out = {
  rules: SCAN_RULES.map((r) => ({ id: r.id, label: r.label, source: r.re.source, flags: r.re.flags })),
  cases,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
console.log(`rules ${out.rules.length} · cases ${cases.length} · hit ${cases.filter((c) => c.want).length}`);
