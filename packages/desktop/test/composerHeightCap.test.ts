import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
  입력창 높이 상한(결정 8 + #1427): 칸 높이의 40%(`--composer-max`) **와 30rem 중 작은 쪽**.
  jsdom 은 배치가 없어 실제 키를 잴 수 없으므로 규칙 자체를 본다 — 30rem 이 빠지면 큰 모니터에서
  입력창이 화면을 덮는다.
*/
describe('입력창 높이 상한', () => {
  it('굴림 상자의 상한은 칸 높이 40% 와 30rem 중 작은 쪽', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    const rule = css.match(/\.composer-cm \.cm-scroller \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('max-height: min(var(--composer-max, 40vh), 30rem)');
    expect(rule).toContain('overflow-y: auto');
  });
});
