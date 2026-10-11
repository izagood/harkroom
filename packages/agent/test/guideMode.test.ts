import { describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { avcsGuideFlag } from '../src/avcsGuideFlag.js';
import { HarkroomAgentClient } from '../src/harkroom.js';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const SRC = readFileSync(path.resolve(__dirname, '../src/harkroom.ts'), 'utf8');

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
    expect(SRC).toMatch(/'workspace\.guide',\s*\{\s*mode:\s*'turn'[,\s}]/);
  });

  it('인자 없이 부르는 옛 호출이 남아 있지 않다', () => {
    expect(SRC).not.toMatch(/call<[^>]*>\('workspace\.guide'\)/);
  });
});

/**
 * avcs 플래그(2026-10-10). 서버는 정확히 `avcs: false` 일 때만 avcs 절을 뺀다(server #1284). 러너가 **모르는데 false 를
 * 보내면** avcs 를 쓰는 에이전트가 「읽기 전용 요청엔 avcs 오브젝트를 만들지 않는다」 경계를 잃는다 — 그래서 잴 수 없으면
 * 인자를 아예 싣지 않는다.
 */
describe('avcs 플래그 — 하네스가 물려받을 PATH 로 잰다 (2026-10-10)', () => {
  it('PATH 가 없거나 비었으면 잴 수 없다 — undefined(보내지 않음)', () => {
    const resolve = vi.fn(() => null);
    expect(avcsGuideFlag(undefined, resolve)).toBeUndefined();
    expect(avcsGuideFlag('', resolve)).toBeUndefined();
    expect(avcsGuideFlag(path.delimiter, resolve)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('PATH 의 디렉터리에 실행 가능한 avcs 가 있으면 true, 없으면 false (실제 파일)', () => {
    const withAvcs = mkdtempSync(path.join(tmpdir(), 'avcs-flag-'));
    const without = mkdtempSync(path.join(tmpdir(), 'avcs-flag-'));
    try {
      const bin = path.join(withAvcs, 'avcs');
      writeFileSync(bin, '#!/bin/sh\n');
      chmodSync(bin, 0o755);
      expect(avcsGuideFlag([without, withAvcs].join(path.delimiter))).toBe(true);
      expect(avcsGuideFlag(without)).toBe(false);
      // 실행 권한이 없으면 MCP 를 띄울 수 없다.
      chmodSync(bin, 0o644);
      expect(avcsGuideFlag(withAvcs)).toBe(false);
    } finally {
      rmSync(withAvcs, { recursive: true, force: true });
      rmSync(without, { recursive: true, force: true });
    }
  });

  it('guide() 는 플래그가 undefined 면 avcs 인자를 싣지 않는다 — 서버는 그때 전문을 준다', async () => {
    const call = vi.fn(async () => ({ guide: 'g' }));
    const client = Object.create(HarkroomAgentClient.prototype) as HarkroomAgentClient;
    (client as unknown as { call: typeof call }).call = call;
    await client.guide();
    await client.guide({ avcs: undefined });
    await client.guide({ avcs: true });
    await client.guide({ avcs: false });
    expect(call.mock.calls.map((c) => (c as unknown[])[1])).toStrictEqual([
      { mode: 'turn' }, { mode: 'turn' }, { mode: 'turn', avcs: true }, { mode: 'turn', avcs: false },
    ]);
  });

  it('러너는 기동 때 자기 PATH 로 잰 플래그를 guide 에 싣는다', () => {
    const MAIN = readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
    expect(MAIN).toMatch(/harkroom\.guide\(\{\s*avcs:\s*avcsGuideFlag\(process\.env\.PATH\)\s*\}\)/);
  });
});
