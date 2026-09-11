/**
 * 협업 탭(레일 다섯째 칸). 이 시험이 지키는 것은 모양이 아니라 **판단 넷**이다:
 *
 * 1. **모름을 0 으로 그리지 않는다** — 못 읽었을 때 "제안 없음" 이 뜨면 사람은 아무도 일하지
 *    않는 줄 안다. `unknown` 은 사유와 함께 서고, 서버가 없을 때는 또 다른 문장이다.
 * 2. **정렬은 서버가 준 순서 그대로** — 막는 순(결정 필요 → 검증 실패 → 열림 → 승인)을
 *    화면에서 다시 매기면 같은 규칙이 두 곳에 생긴다.
 * 3. 저장소 하나를 못 읽어도 나머지는 선다. 그 저장소는 **빈 목록이 아니라 사유**를 낸다.
 * 4. 파급 칩은 **선언된 것만** — 선언하지 않은 것과 "없다" 는 다르다.
 *
 * 줄은 글자가 아니라 `data-testid` 로 집는다(로케일 기본값이 바뀌면 이유 없이 빨개진다).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { CollabProposal, CollabProposalsView, CollabRepoView } from '@harkroom/shared';
import { Collab } from '../src/components/Collab';
import { countFor, matchesFilter } from '../src/lib/collabProposals';

afterEach(cleanup);

const proposal = (over: Partial<CollabProposal> & { intentOid: string }): CollabProposal => ({
  title: '제안',
  ownerKeyId: 'human:jaebin',
  lastLogIndex: 1,
  ops: [],
  decisions: [],
  state: 'open',
  conflicts: [],
  effects: null,
  ...over,
});

const repo = (over: Partial<CollabRepoView> & { repo: string }): CollabRepoView => ({
  channelIds: ['c1'],
  error: null,
  proposals: [],
  reducedAt: { cursor: 42, materializer: 'avcs-reduce/1', treeHash: 'tree_a' },
  ...over,
});

function view(over: Partial<CollabProposalsView> = {}): CollabProposalsView {
  return { baseUrl: 'http://avcs.test', repos: [], actors: {}, ...over };
}

function show(v: CollabProposalsView, filter: 'open' | 'accepted' | 'all' = 'open'): void {
  render(
    <Collab
      snapshot={{ kind: 'known', view: v }}
      filter={filter}
      onFilterChange={() => {}}
      handleOf={(id) => (id === 'acct-jaebin' ? 'jaebin' : id)}
      onOpenChannel={() => {}}
    />,
  );
}

describe('협업 탭', () => {
  it('서버가 준 순서 그대로 줄을 세운다 — 막는 것이 위다', () => {
    show(view({
      repos: [repo({
        repo: 'izagood/harkroom',
        proposals: [
          proposal({ intentOid: 'i_need', state: 'needs_decision', title: '인덱스를 다시 깐다' }),
          proposal({ intentOid: 'i_quar', state: 'check_failed', title: '첨부 미리보기' }),
          proposal({ intentOid: 'i_open', state: 'open', title: '008 을 되돌린다' }),
        ],
      })],
    }));

    const rows = screen.getAllByTestId(/^collab-row-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'collab-row-i_need', 'collab-row-i_quar', 'collab-row-i_open',
    ]);
  });

  it('물었지만 못 받았으면 사유와 함께 "모름" 이다 — 빈 목록이 아니다', () => {
    render(
      <Collab
        snapshot={{ kind: 'unknown', reason: 'fetch failed: ECONNREFUSED' }}
        filter="open"
        onFilterChange={() => {}}
        handleOf={(id) => id}
        onOpenChannel={() => {}}
      />,
    );

    expect(within(screen.getByTestId('collab-unknown')).getByText(/ECONNREFUSED/)).toBeTruthy();
    expect(screen.queryByTestId('collab-empty')).toBeNull();
  });

  it('보고 있는 avcs 서버가 없으면 "제안 없음" 과 다른 문장을 낸다', () => {
    show(view({ baseUrl: null }));

    expect(screen.getByTestId('collab-no-server')).toBeTruthy();
    expect(screen.queryByTestId('collab-empty')).toBeNull();
  });

  it('저장소 하나를 못 읽어도 나머지는 서고, 그 저장소는 사유를 낸다', () => {
    show(view({
      repos: [
        repo({ repo: 'izagood/avcs', error: 'unreachable', reducedAt: null }),
        repo({ repo: 'izagood/harkroom', proposals: [proposal({ intentOid: 'i1' })] }),
      ],
    }));

    expect(screen.getByTestId('collab-repo-error-izagood/avcs')).toBeTruthy();
    expect(screen.getByTestId('collab-row-i1')).toBeTruthy();
  });

  it('파급 칩은 선언된 것만 그린다', () => {
    show(view({
      repos: [repo({
        repo: 'r',
        proposals: [
          proposal({ intentOid: 'i_declared', effects: { changesBehavior: true, breaksPublicApi: false } }),
          proposal({ intentOid: 'i_silent' }),
        ],
      })],
    }));

    expect(screen.getByTestId('collab-effect-behavior-i_declared')).toBeTruthy();
    expect(screen.queryByTestId('collab-effect-api-i_declared')).toBeNull();
    // 선언하지 않은 제안에는 칩이 아예 없다 — "파급 없음" 이라고 말하지 않는다.
    expect(screen.queryByTestId('collab-effect-behavior-i_silent')).toBeNull();
  });

  it('어느 시점의 판정인지 저장소마다 말한다 — 환원 평면이 없으면 그 줄도 없다', () => {
    show(view({
      repos: [
        repo({ repo: 'with', proposals: [proposal({ intentOid: 'i1' })] }),
        repo({ repo: 'without', reducedAt: null, proposals: [proposal({ intentOid: 'i2', state: 'unknown' })] }),
      ],
    }));

    expect(screen.getByTestId('collab-reduced-with').textContent).toContain('42');
    expect(screen.queryByTestId('collab-reduced-without')).toBeNull();
    // 상태는 글자가 아니라 속성으로 본다(로케일 기본값과 무관해야 한다).
    expect(screen.getByTestId('collab-row-i2').dataset.state).toBe('unknown');
  });

  it('거르개는 저장소를 가로질러 세고, 승인됨을 고르면 열린 것이 빠진다', () => {
    const repos = [repo({
      repo: 'r',
      proposals: [
        proposal({ intentOid: 'i_open', state: 'open' }),
        proposal({ intentOid: 'i_need', state: 'needs_decision' }),
        proposal({ intentOid: 'i_done', state: 'accepted' }),
      ],
    })];

    expect(countFor(repos, 'open')).toBe(2);
    expect(countFor(repos, 'accepted')).toBe(1);
    expect(countFor(repos, 'all')).toBe(3);

    show(view({ repos }), 'accepted');
    expect(screen.getByTestId('collab-row-i_done')).toBeTruthy();
    expect(screen.queryByTestId('collab-row-i_open')).toBeNull();
  });

  it('상태를 모르는 제안은 "끝난 것" 이 아니라 열린 쪽에 남는다', () => {
    const p = proposal({ intentOid: 'i_unknown', state: 'unknown' });
    expect(matchesFilter(p, 'open')).toBe(true);
    expect(matchesFilter(p, 'accepted')).toBe(false);
  });

  it('거르개를 누르면 그 값을 위로 올린다', () => {
    const picked: string[] = [];
    render(
      <Collab
        snapshot={{ kind: 'known', view: view() }}
        filter="open"
        onFilterChange={(f) => picked.push(f)}
        handleOf={(id) => id}
        onOpenChannel={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('collab-filter-all'));
    expect(picked).toEqual(['all']);
  });
});
