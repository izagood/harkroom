/**
 * 뒤처진 러너 판정의 회귀선.
 *
 * ## 왜 판정을 함수 하나로 뽑았나
 *
 * 이 판정을 읽는 화면이 둘이다 — 프로필의 한 에이전트, 설정의 전체 재기동. 두 곳이
 * 각자 비교하면 한쪽만 고치는 사고가 나고, 그 사고는 조용하다: 사람은 "전체 재기동"이
 * 고른 대상과 프로필이 경고하는 대상이 어긋난 것을 알 방법이 없다.
 *
 * ## `unknown` 을 뒤처짐과 가른 것이 이 파일의 핵이다
 *
 * `runnerVersion` 은 러너가 `AGENT_VERSION` 으로 알려 준 값이다(마이그레이션 013).
 * 그 환경변수를 못 받은 러너는 `'unknown'` 을 보고하고, 서버는 그것을 그대로 적는다.
 * **모르는 것을 뒤처졌다고 단정하면 거짓 신호다**(docs/design.md §4) — 최신 러너인데도
 * 재기동 대상에 들어가고, 재기동해도 여전히 `unknown` 이라 영원히 대상에 남는다.
 * 그래서 모르는 것은 **따로 센다**: 화면이 "버전을 모르는 러너 M대"라고 말하고, 사람이
 * 개별 재기동으로 그 값을 채우게 한다.
 */
import { describe, expect, it } from 'vitest';
import { staleRunners } from '../src/lib/runnerVersions';

const live = (...ids: string[]) => new Set(ids);

describe('staleRunners — 뒤처진 러너를 고른다', () => {
  it('살아 있고 버전이 앱과 다른 러너만 고른다', () => {
    const result = staleRunners({
      agents: [
        { id: 'old', runnerVersion: '0.1.6' },
        { id: 'current', runnerVersion: '0.1.15' },
      ],
      live: live('old', 'current'),
      appVersion: '0.1.15',
    });

    expect(result.stale).toEqual(['old']);
    expect(result.unknown).toEqual([]);
  });

  it('버전을 모르는 러너는 뒤처짐이 아니라 따로 센다', () => {
    const result = staleRunners({
      agents: [
        { id: 'mystery', runnerVersion: 'unknown' },
        { id: 'never-reported', runnerVersion: null },
        { id: 'old', runnerVersion: '0.1.6' },
      ],
      live: live('mystery', 'never-reported', 'old'),
      appVersion: '0.1.15',
    });

    expect(result.stale).toEqual(['old']);
    expect(result.unknown).toEqual(['mystery', 'never-reported']);
  });

  it('러너가 없는 에이전트는 어느 쪽에도 넣지 않는다 — 재기동할 것이 없다', () => {
    const result = staleRunners({
      agents: [
        { id: 'sleeping', runnerVersion: '0.1.6' },
        { id: 'awake', runnerVersion: '0.1.6' },
      ],
      live: live('awake'),
      appVersion: '0.1.15',
    });

    expect(result.stale).toEqual(['awake']);
    expect(result.unknown).toEqual([]);
  });

  it('앱 버전을 모르면 아무것도 뒤처졌다고 하지 않는다', () => {
    const result = staleRunners({
      agents: [{ id: 'old', runnerVersion: '0.1.6' }],
      live: live('old'),
      appVersion: null,
    });

    // 비교할 기준이 없다. 그때 "뒤처졌다"고 말하는 것은 근거 없는 단정이다 —
    // 대신 "모른다"로 넘겨 사람이 판단하게 한다.
    expect(result.stale).toEqual([]);
    expect(result.unknown).toEqual(['old']);
  });
});
