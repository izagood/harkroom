import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { MEMORY_CLEANUP_NAME, MEMORY_CLEANUP_TOOLS, memoryCleanupBody, memoryCleanupTrigger } from '../src/memoryCleanup.js';

// 메모리 C3 — 주간 정리 자동화 본문. 서버·러너를 읽어 본문이 실제로 있는 도구·절차를 부르는지 고정한다.
// 서버·러너는 Rust 다(TS 백엔드는 11-21 지웠다) — 도구 표는 `core/mcp/mod.rs` 의 `t("이름", …)`, 지시문은 러너 `prompt_system.rs`.
const root = path.resolve(__dirname, '../../..');
const mcp = readFileSync(path.join(root, 'crates/harkroom-server/src/core/mcp/mod.rs'), 'utf8');
const prompt = readFileSync(path.join(root, 'crates/harkroom-runner/src/prompt_system.rs'), 'utf8');

describe('memoryCleanupBody', () => {
  const body = memoryCleanupBody('forge');

  it('맨 앞이 그 에이전트 멘션이다 — 맨 앞 멘션만 턴을 띄운다', () => {
    expect(body.startsWith('@forge ')).toBe(true);
    expect(body.match(/@[\w-]+/g)).toEqual(['@forge']);
  });

  it('채널 전체 토큰을 맨몸으로 쓰지 않는다(mem/channel-token-broadcast)', () => {
    expect(body).not.toMatch(/(^|[^`])@(channel|here|everyone)\b/);
  });

  it('부르는 도구는 전부 서버에 등록돼 있고, 본문에도 나온다', () => {
    for (const tool of MEMORY_CLEANUP_TOOLS) {
      expect(mcp, tool).toContain(`t("${tool}",`);
      expect(body, tool).toContain(`\`${tool}\``);
    }
  });

  it('지시문의 「정리하는 법」을 부른다 — 그 절이 지시문에 있어야 한다', () => {
    expect(body).toContain('「정리하는 법」');
    expect(prompt).toContain('**정리하는 법**');
  });

  it('순서: 임대 → audit → 읽기 → 합치기·보관 → 임대 놓기 → 보고', () => {
    const at = (s: string) => body.indexOf(s);
    expect(at('`memory.lease`')).toBeLessThan(at('`memory.audit`'));
    expect(at('`memory.audit`')).toBeLessThan(at('`memory.get`'));
    expect(at('`memory.get`')).toBeLessThan(at('`memory.merge`'));
    expect(at('`memory.archive`')).toBeLessThan(at('release'));
    expect(at('release')).toBeLessThan(at('`message.post`'));
  });

  it('발화 상한 안이고, 이름은 automation 이름 상한(100) 안이다', () => {
    expect(body.length).toBeLessThan(8000);
    expect(MEMORY_CLEANUP_NAME('a'.repeat(64)).length).toBeLessThanOrEqual(100);
  });

  it('트리거는 automation.propose 의 주간 schedule 모양이다', () => {
    // 시간대는 부르는 쪽이 준다 — 한 설치의 시간대를 기본값으로 박지 않는다.
    expect(memoryCleanupTrigger('Europe/Berlin')).toEqual({ kind: 'schedule', freq: 'weekly', weekdays: [1], time: '09:00', tz: 'Europe/Berlin' });
    expect(memoryCleanupTrigger('UTC').tz).toBe('UTC');
    expect(mcp).toContain('t("automation.propose",');
  });
});
