import { describe, expect, it } from 'vitest';
import { CODEX_LANE_VERSIONS, KILO_LANE_VERSIONS, OMP_LANE_VERSIONS, OPENCODE_LANE_VERSIONS, PI_LANE_VERSIONS } from '@harkroom/shared/providerLane';
import { translator } from '../src/i18n';
import { laneCodeKey, laneCodeText } from '../src/lib/laneCodes';

// 러너 판 관문과 문장이 같은 상수를 본다 — 관문을 넓히면 문장의 받는 줄도 같이 바뀐다.
describe('harness_version 문장', () => {
  it.each(['ko', 'en'] as const)('%s: 받는 버전을 상수(목록)에서 끼워 넣는다', (locale) => {
    const text = laneCodeText(translator(locale), 'harness_version');
    expect(laneCodeKey('harness_version')).toBe('lane.code.harness_version');
    for (const v of OPENCODE_LANE_VERSIONS) expect(text).toContain(`opencode ${v}`);
    for (const v of CODEX_LANE_VERSIONS) expect(text).toContain(`codex ${v}`);
    // 판 관문이 있는 하네스는 모두 싣는다(designer C 4 — omp 가 빠져 있었다).
    for (const v of OMP_LANE_VERSIONS) expect(text).toContain(`omp ${v}`);
    for (const v of KILO_LANE_VERSIONS) expect(text).toContain(`kilo ${v}`);
    for (const v of PI_LANE_VERSIONS) expect(text).toContain(`pi ${v}`);
    expect(text).not.toMatch(/\{versions?\}/);
  });
});

// designer n1: 하네스를 알면(설정 화면) 그 하네스의 판만 — 다른 하네스 판은 싣지 않는다.
describe('harness_version 문장 — 하네스를 알 때', () => {
  it.each(['ko', 'en'] as const)('%s: codex 면 codex 판만, opencode 면 opencode 판만', (locale) => {
    const t = translator(locale);
    const codex = laneCodeText(t, 'harness_version', 'codex');
    for (const v of CODEX_LANE_VERSIONS) expect(codex).toContain(`codex ${v}`);
    expect(codex).not.toContain('opencode');
    const opencode = laneCodeText(t, 'harness_version', 'opencode');
    for (const v of OPENCODE_LANE_VERSIONS) expect(opencode).toContain(`opencode ${v}`);
    expect(opencode).not.toContain('codex');
    // 판 관문이 없는 하네스·모름은 모두 늘어놓는다.
    for (const h of ['claude-code', null, undefined]) expect(laneCodeText(t, 'harness_version', h)).toContain(`codex ${CODEX_LANE_VERSIONS[0]}`);
  });
});

// designer n3·n5: 하네스 이름을 박지 않은 모델 문장, 보호 이름 목록에 `.codex`.
describe('bad_model·workspace_protected 문장', () => {
  it.each(['ko', 'en'] as const)('%s', (locale) => {
    const t = translator(locale);
    expect(laneCodeText(t, 'bad_model')).not.toMatch(/opencode/i);
    expect(laneCodeText(t, 'workspace_protected')).toContain('.codex');
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

  // designer C D2: 하네스를 알면 그 자리만, 모르면(실패 카드) 아는 자리를 모두 「또는」으로 잇는다.
  it.each([['ko', '<스레드>', ' 또는 '], ['en', '<thread>', ' or ']] as const)('%s: pi 면 pi 자리만, 모르면 codex·pi 둘 다', (locale, thread, join) => {
    const t = translator(locale);
    const pi = laneCodeText(t, 'harness_login_present', 'pi');
    expect(pi).toContain(`pi-provider-lane/threads/${thread}/auth.json`);
    expect(pi).not.toContain('codex-provider-lane');
    const codex = laneCodeText(t, 'harness_login_present', 'codex');
    expect(codex).toContain('codex-provider-lane/auth.json');
    expect(codex).not.toContain('pi-provider-lane');
    const any = laneCodeText(t, 'harness_login_present');
    expect(any).toContain(`codex-provider-lane/auth.json${join}pi-provider-lane/threads/${thread}/auth.json`);
    expect(any).not.toMatch(/\{home\}|\{thread\}/);
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
