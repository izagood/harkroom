/**
 * 뒤처진 러너 판정의 회귀선.
 *
 * ## 기준은 오퍼레이터다 (2026-09-29)
 *
 * 앞 판본은 보는 데스크탑의 버전(`appVersion`)과 `!==` 로 견줬다. 그래서 homelab·rowlol 처럼
 * 보는 앱보다 **새** 러너가 `0.3.45 · 뒤처짐` 으로 떴고, 어느 앱에서 보느냐에 따라 판정이 갈렸다.
 * 이제 기준은 그 에이전트가 배정된 오퍼레이터의 버전이다 — 러너에 `AGENT_VERSION` 을 심는 쪽이다.
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
import { baselineOf, operatorVersionMap, staleRunners } from '../src/lib/runnerVersions';

const live = (...ids: string[]) => new Set(ids);
const on = (operatorId: string) => ({ assignment: { operatorId } });

describe('staleRunners — 뒤처진 러너를 고른다', () => {
  it('살아 있고 버전이 자기 오퍼레이터와 다른 러너만 고른다', () => {
    const result = staleRunners({
      agents: [
        { id: 'old', runnerVersion: '0.1.6', ...on('op-a') },
        { id: 'current', runnerVersion: '0.1.15', ...on('op-a') },
      ],
      live: live('old', 'current'),
      operators: operatorVersionMap([{ id: 'op-a', version: '0.1.15' }]),
    });

    expect(result.stale).toEqual(['old']);
    expect(result.unknown).toEqual([]);
  });

  /**
   * **이번 버그의 회귀선**(2026-09-29). 러너가 보는 앱보다 새것이어도, 자기 오퍼레이터와 같으면
   * 최신이다 — 판정에 앱 버전이 들어갈 자리가 아예 없다(입력에 없다).
   */
  it('러너가 보는 앱보다 새것이어도 오퍼레이터와 같으면 최신이다', () => {
    const result = staleRunners({
      agents: [
        { id: 'homelab', runnerVersion: '0.3.45', ...on('op-homelab') },
        { id: 'rowlol', runnerVersion: '0.3.45', ...on('op-mac') },
      ],
      live: live('homelab', 'rowlol'),
      operators: operatorVersionMap([
        { id: 'op-homelab', version: '0.3.45' },
        { id: 'op-mac', version: '0.3.45' },
      ]),
    });

    expect(result.stale).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it('기준은 에이전트마다 자기 오퍼레이터다 — 같은 러너 버전도 오퍼레이터에 따라 갈린다', () => {
    const result = staleRunners({
      agents: [
        { id: 'on-new', runnerVersion: '0.3.44', ...on('op-new') },
        { id: 'on-old', runnerVersion: '0.3.44', ...on('op-old') },
      ],
      live: live('on-new', 'on-old'),
      operators: operatorVersionMap([
        { id: 'op-new', version: '0.3.47' },
        { id: 'op-old', version: '0.3.44' },
      ]),
    });

    // 오퍼레이터가 0.3.47 로 갱신됐는데 러너는 adopted 로 남은 옛 번들 — 재기동 대상이다.
    expect(result.stale).toEqual(['on-new']);
  });

  it('버전을 모르는 러너는 뒤처짐이 아니라 따로 센다', () => {
    const result = staleRunners({
      agents: [
        { id: 'mystery', runnerVersion: 'unknown', ...on('op-a') },
        { id: 'never-reported', runnerVersion: null, ...on('op-a') },
        { id: 'old', runnerVersion: '0.1.6', ...on('op-a') },
      ],
      live: live('mystery', 'never-reported', 'old'),
      operators: operatorVersionMap([{ id: 'op-a', version: '0.1.15' }]),
    });

    expect(result.stale).toEqual(['old']);
    expect(result.unknown).toEqual(['mystery', 'never-reported']);
  });

  it('러너가 없는 에이전트는 어느 쪽에도 넣지 않는다 — 재기동할 것이 없다', () => {
    const result = staleRunners({
      agents: [
        { id: 'sleeping', runnerVersion: '0.1.6', ...on('op-a') },
        { id: 'awake', runnerVersion: '0.1.6', ...on('op-a') },
      ],
      live: live('awake'),
      operators: operatorVersionMap([{ id: 'op-a', version: '0.1.15' }]),
    });

    expect(result.stale).toEqual(['awake']);
    expect(result.unknown).toEqual([]);
  });

  /**
   * **오퍼레이터 버전을 모르면 모른다** — 앱 버전으로 물러서지 않는다(그 물러섬이 이번 버그다).
   * 모르는 갈래는 넷이다: 목록을 못 읽음 · 미배정 · 목록에 없는 오퍼레이터 · 버전을 안 보내는 오퍼레이터.
   */
  it('오퍼레이터 버전을 모르면 아무것도 뒤처졌다고 하지 않는다', () => {
    const operators = operatorVersionMap([
      { id: 'op-silent', version: null },
      // 이 필드가 생기기 전 서버의 응답 — `version` 이 아예 없다.
      { id: 'op-old-server' },
    ]);
    const result = staleRunners({
      agents: [
        { id: 'unassigned', runnerVersion: '0.1.6', assignment: null },
        { id: 'no-field', runnerVersion: '0.1.6' },
        { id: 'invisible', runnerVersion: '0.1.6', ...on('op-not-listed') },
        { id: 'silent', runnerVersion: '0.1.6', ...on('op-silent') },
        { id: 'old-server', runnerVersion: '0.1.6', ...on('op-old-server') },
      ],
      live: live('unassigned', 'no-field', 'invisible', 'silent', 'old-server'),
      operators,
    });

    // 비교할 기준이 없다. 그때 "뒤처졌다"고 말하는 것은 근거 없는 단정이다 —
    // 대신 "모른다"로 넘겨 사람이 판단하게 한다.
    expect(result.stale).toEqual([]);
    expect(result.unknown).toEqual(['unassigned', 'no-field', 'invisible', 'silent', 'old-server']);

    const unread = staleRunners({
      agents: [{ id: 'old', runnerVersion: '0.1.6', ...on('op-a') }],
      live: live('old'),
      operators: null,
    });
    expect(unread).toEqual({ stale: [], unknown: ['old'] });
  });
});

describe('baselineOf — 비교 기준', () => {
  it('배정된 오퍼레이터의 버전이고, 모르면 null 이다', () => {
    const operators = operatorVersionMap([{ id: 'op-a', version: '0.3.47' }]);
    expect(baselineOf(on('op-a'), operators)).toBe('0.3.47');
    expect(baselineOf(on('op-b'), operators)).toBeNull();
    expect(baselineOf({ assignment: null }, operators)).toBeNull();
    expect(baselineOf(on('op-a'), null)).toBeNull();
  });
});
