// Rust 앞단이 자기가 답하는 응답에 붙이는 CORS 값의 정본은 TS 다(`buildServer.ts` 의 `cors` 등록). 앞단은
// `crates/harkroom-server/golden/cors.json` 을 읽고, 이 시험이 그 파일이 TS 값과 같은지 본다 — TS 에 노출 머리를 더하고 골든을 안
// 고치면 여기서 빨개진다(앞단만 옛 값을 내는 일을 막는다. 11-14 「Load failed」 장애의 재발 방지).
// 고칠 때: `UPDATE_RUST_CORS_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustCorsGolden.test.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS, CORS_METHODS, CORS_PREFLIGHT_MAX_AGE_SEC } from '../src/buildServer.js';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/cors.json', import.meta.url));

it('Rust 앞단의 CORS 값이 TS 정본과 같다', () => {
  const text = `${JSON.stringify({
    methods: CORS_METHODS, allowedHeaders: CORS_ALLOWED_HEADERS, exposedHeaders: CORS_EXPOSED_HEADERS, maxAge: CORS_PREFLIGHT_MAX_AGE_SEC,
  }, null, 2)}\n`;
  if (process.env.UPDATE_RUST_CORS_GOLDEN === '1') writeFileSync(GOLDEN, text);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(text);
});
