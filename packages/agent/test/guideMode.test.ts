import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const SRC = readFileSync(path.resolve(__dirname, '../src/murmur.ts'), 'utf8');

/**
 * 2026-09-08 앵커 이탈 사고의 배선 회귀선.
 *
 * 서버는 두 판본을 갖게 됐지만(`server/src/mcp/guide.ts`), **러너가 옛 인자로 계속 부르면
 * 아무것도 달라지지 않는다** — 턴은 여전히 "inbox.poll 을 루프로 걸어라"를 받는다.
 * 소스를 보는 이유: 이 호출을 검증하려면 MCP 왕복을 세워야 하는데(private `call`),
 * 그 값을 치르고 얻는 것이 "인자 하나가 붙어 있다"뿐이다. 저장소에 이미 같은 결의
 * 소스 회귀선이 있다(`mainCredentialSites.test.ts`).
 */
describe('러너는 턴용 가이드를 받는다 (2026-09-08)', () => {
  it("workspace.guide 를 mode: 'turn' 으로 부른다", () => {
    expect(SRC).toMatch(/'workspace\.guide',\s*\{\s*mode:\s*'turn'\s*\}/);
  });

  it('인자 없이 부르는 옛 호출이 남아 있지 않다', () => {
    expect(SRC).not.toMatch(/call<[^>]*>\('workspace\.guide'\)/);
  });
});
