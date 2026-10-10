import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 에이전트 상세의 묶음(UX ⑨b, designer 사양 ⑨): **모델·Effort 는 "실행" 묶음**이다. 전에는 "권한" 묶음에 서
 * 있었다 — 바로 위 [하네스 기본값 / 이 에이전트만] 고르기(실행 묶음)와 그것이 여는 칸이 두 묶음으로 갈렸다.
 *
 * 화면 전체를 띄우는 대신 소스의 순서를 잰다 — 이 저장소가 배치 규칙을 지키는 방식이다(`accentBudget` 등).
 * 재는 것: 두 칸의 자리가 "실행" 제목 뒤이고 "권한" 제목 앞이다.
 */
const src = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'settings', 'AgentsSettings.tsx'), 'utf8');

describe('에이전트 상세 묶음 (UX ⑨b)', () => {
  it('Model·Effort 칸은 실행 묶음 안에 있다', () => {
    const run = src.indexOf("title={t('agents.run.title')}");
    const perm = src.indexOf("title={t('agents.permissions.title')}");
    const model = src.indexOf('<ModelPicker');
    const effort = src.indexOf("aria-label={t('agents.run.effort')}");
    expect(run).toBeGreaterThan(0);
    expect(perm).toBeGreaterThan(run);
    for (const at of [model, effort]) {
      expect(at).toBeGreaterThan(run);
      expect(at).toBeLessThan(perm);
    }
  });
});
