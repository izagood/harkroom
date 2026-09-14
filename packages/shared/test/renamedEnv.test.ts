/**
 * 이름이 바뀐 환경변수의 **폴백 회귀선**(`MURMUR_*` → `HARKROOM_*`).
 *
 * 이것이 없으면 개명하는 순간 **저장소 밖에서 env 를 넣는 러너들이 조용히 안 뜬다** —
 * 사람이 손으로 만든 LaunchAgent plist 와 손으로 치는 `pnpm … start` 가 그 자리다.
 * 앱이 띄우는 러너는 데스크탑→데몬→러너로 env 를 내부에서 넘기므로 저절로 맞지만,
 * 그 둘은 앱과 같이 갱신되지 않는다.
 *
 * **되돌려 RED**: `renamedEnv` 에서 폴백 한 줄을 지우면 "옛 이름만 있으면 그것을 읽는다"가
 * 빨개진다.
 */
import { describe, it, expect } from 'vitest';
import { renamedEnv } from '../src/index';

describe('renamedEnv', () => {
  it('새 이름이 있으면 그것을 읽는다', () => {
    expect(renamedEnv({ HARKROOM_PAT: 'new', MURMUR_PAT: 'old' }, 'HARKROOM_PAT')).toBe('new');
  });

  it('옛 이름만 있으면 그것을 읽는다 — 이것이 이 파일의 존재 이유다', () => {
    expect(renamedEnv({ MURMUR_PAT: 'old' }, 'HARKROOM_PAT')).toBe('old');
  });

  it('둘 다 없으면 undefined', () => {
    expect(renamedEnv({}, 'HARKROOM_PAT')).toBeUndefined();
  });

  /**
   * **빈 문자열은 "안 준 것"이 아니다.** `HARKROOM_PAT=` 로 지운 흔적이 있으면 그것이 답이고,
   * 옛 이름으로 몰래 내려가면 사람이 지웠다고 믿는 값이 되살아난다.
   */
  it('새 이름이 빈 문자열이면 그대로 빈 문자열이다', () => {
    expect(renamedEnv({ HARKROOM_PAT: '', MURMUR_PAT: 'old' }, 'HARKROOM_PAT')).toBe('');
  });

  it('새 접두사가 아닌 이름에는 폴백이 없다', () => {
    expect(renamedEnv({ MURMUR_PAT: 'old' }, 'PATH')).toBeUndefined();
    expect(renamedEnv({ PATH: '/bin' }, 'PATH')).toBe('/bin');
  });
});
