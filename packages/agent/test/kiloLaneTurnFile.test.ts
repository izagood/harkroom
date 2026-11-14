import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LANE_TURN_FILE_ENV, PROVIDER_LANE_ENV_KEYS } from '../src/providerLane.js';

/** a′: kilo lane 턴 파일은 `KILO_CONFIG` 다 — 그 파일에 다리 열쇠 칸을 합친다(opencode 는 `OPENCODE_CONFIG`). */
describe('lane 턴 파일 이름은 하네스를 따른다', () => {
  it('kilo → KILO_CONFIG, opencode → OPENCODE_CONFIG, 둘 다 lane 이 주는 env 이름이다', () => {
    expect(LANE_TURN_FILE_ENV.kilo).toBe('KILO_CONFIG');
    expect(LANE_TURN_FILE_ENV.opencode).toBe('OPENCODE_CONFIG');
    expect(PROVIDER_LANE_ENV_KEYS.kilo).toContain('KILO_CONFIG');
    expect(PROVIDER_LANE_ENV_KEYS.opencode).toContain('OPENCODE_CONFIG');
  });
  it('턴 열쇠 칸을 합칠 lane 파일을 그 이름으로 읽는다(mentionTurn)', () => {
    const src = readFileSync(new URL('../src/mentionTurn.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/laneTurnFile = providerEnv\?\.\[LANE_TURN_FILE_ENV\[def\.harness\] \?\? 'OPENCODE_CONFIG'\]/);
  });
});
