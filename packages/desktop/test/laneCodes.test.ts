import { describe, expect, it } from 'vitest';
import { CODEX_LANE_VERSIONS, OPENCODE_LANE_VERSIONS } from '@harkroom/shared/providerLane';
import { translator } from '../src/i18n';
import { laneCodeKey, laneCodeText } from '../src/lib/laneCodes';

// 러너 판 관문과 문장이 같은 상수를 본다 — 관문을 넓히면 문장의 받는 줄도 같이 바뀐다.
describe('harness_version 문장', () => {
  it.each(['ko', 'en'] as const)('%s: 받는 버전을 상수(목록)에서 끼워 넣는다', (locale) => {
    const text = laneCodeText(translator(locale), 'harness_version');
    expect(laneCodeKey('harness_version')).toBe('lane.code.harness_version');
    for (const v of OPENCODE_LANE_VERSIONS) expect(text).toContain(`opencode ${v}`);
    for (const v of CODEX_LANE_VERSIONS) expect(text).toContain(`codex ${v}`);
    expect(text).not.toMatch(/\{versions?\}/);
  });
});

describe('harness_login_present 문장', () => {
  it.each(['ko', 'en'] as const)('%s: 자기 문장이 있다(알 수 없음으로 접지 않는다)', (locale) => {
    expect(laneCodeKey('harness_login_present')).toBe('lane.code.harness_login_present');
    // 사람이 치울 자리를 알게 상태 폴더 안 상대 경로를 싣는다 — 절대 경로·사용자명은 싣지 않는다.
    const text = laneCodeText(translator(locale), 'harness_login_present');
    expect(text).toContain('codex-provider-lane/auth.json');
    expect(text).not.toMatch(/\/Users\/|~\//);
  });
});

describe('lane_setup 문장', () => {
  it.each(['ko', 'en'] as const)('%s: 러너 재시작 버튼 이름을 끼워 넣고 「셸」 낱말을 쓰지 않는다', (locale) => {
    const t = translator(locale);
    const text = laneCodeText(t, 'lane_setup');
    expect(text).toContain(t('agents.restart.action'));
    expect(text).not.toMatch(/\{action\}|셸|shell/i);
  });
});
