import { describe, expect, it } from 'vitest';
import { OPENCODE_LANE_VERSIONS } from '@harkroom/shared/providerLane';
import { translator } from '../src/i18n';
import { laneCodeKey, laneCodeText } from '../src/lib/laneCodes';

// 러너 판 관문과 문장이 같은 상수를 본다 — 관문을 넓히면 문장의 받는 줄도 같이 바뀐다.
describe('harness_version 문장', () => {
  it.each(['ko', 'en'] as const)('%s: 받는 버전을 상수(목록)에서 끼워 넣는다', (locale) => {
    const text = laneCodeText(translator(locale), 'harness_version');
    expect(laneCodeKey('harness_version')).toBe('lane.code.harness_version');
    for (const v of OPENCODE_LANE_VERSIONS) expect(text).toContain(v);
    expect(text).toContain(`opencode ${locale === 'en' ? "isn't" : '버전이'}`);
    expect(text).not.toMatch(/\{version\}/);
  });
});
