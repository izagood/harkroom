// 기억 목록의 판정 — 접기·검색·묶기(#139 4단계).
//
// 화면으로는 이 셋을 다 잴 수 없다. 묶임의 경계(둘은 안 묶고 셋부터 묶는다)와 검색이
// 묶음을 어떻게 쪼개는가는 화면을 세워서 보면 놓치기 쉬운 자리라, 순수 함수 쪽에서 직접
// 잰다. 화면이 이 결과를 그리는지는 `agentMemoryUi.test.tsx` 가 따로 본다.
import { describe, it, expect } from 'vitest';
import {
  memorySummary, memoryGroupKey, memoryRows, splitCore, MIN_GROUP_SIZE,
  type MemoryEntry,
} from '../src/lib/memoryList';

const at = (n: number) => new Date(Date.UTC(2026, 8, n)).toISOString();
const mem = (slug: string, value = `# ${slug}`, day = 1): MemoryEntry =>
  ({ slug, value, updatedAt: at(day) });

describe('memorySummary — 첫 줄을 제목처럼 쓴다', () => {
  it('마크다운 제목 표시를 뗀다', () => {
    expect(memorySummary('# 앱 기본 크기는 배율이 아니라 척도다\n\n본문')).toBe('앱 기본 크기는 배율이 아니라 척도다');
  });

  it('빈 줄을 건너뛰고 첫 글자 줄을 찾는다', () => {
    expect(memorySummary('\n\n   \n정본은 main 이다')).toBe('정본은 main 이다');
  });

  it('인용·목록·굵게 표시도 뗀다 — 접힌 줄에서는 자리만 먹는다', () => {
    expect(memorySummary('> **주의**: 이것은 인용이다')).toBe('주의: 이것은 인용이다');
    expect(memorySummary('- 첫 항목')).toBe('첫 항목');
  });

  it('값이 비면 빈 문자열이다 — 요약이 없다고 화면이 깨지면 안 된다', () => {
    expect(memorySummary('')).toBe('');
    expect(memorySummary('\n \n')).toBe('');
  });

  /**
   * 줄바꿈 없는 8,000자 값 하나가 그대로 들어오면 접은 보람이 없다. 자르는 것은 서식이
   * 아니라 안전장치이고, 말줄임 자체는 CSS 가 한다.
   */
  it('아주 긴 한 줄은 잘라서 낸다', () => {
    expect(memorySummary('가'.repeat(8000))).toHaveLength(200);
  });
});

describe('memoryGroupKey — mem/ 다음 첫 `-` 토큰', () => {
  it('접두어를 뽑는다', () => {
    expect(memoryGroupKey('mem/pr-703-progress-not-a-reply')).toBe('mem/pr-');
    expect(memoryGroupKey('mem/codex-inject-too-early')).toBe('mem/codex-');
  });

  it('core 와 `-` 없는 slug 는 묶이지 않는다', () => {
    expect(memoryGroupKey('core')).toBeNull();
    expect(memoryGroupKey('mem/search')).toBeNull();
    // 토큰이 비면 묶을 이름이 없다.
    expect(memoryGroupKey('mem/-x')).toBeNull();
  });

  /** `mem/` 아래만 묶는다 — 그 밖의 slug 는 문법이 보장되지 않는다. */
  it('mem/ 으로 시작하지 않으면 null 이다', () => {
    expect(memoryGroupKey('deploy-notes')).toBeNull();
  });
});

describe('splitCore — core 는 목록에 서지 않는다', () => {
  it('core 를 떼어 내고 나머지만 남긴다', () => {
    const { core, rest } = splitCore([mem('mem/a-1'), mem('core'), mem('mem/b-1')]);
    expect(core?.slug).toBe('core');
    expect(rest.map((e) => e.slug)).toEqual(['mem/a-1', 'mem/b-1']);
  });

  it('core 가 없으면 null 이다 — 없는 것을 지어내지 않는다', () => {
    expect(splitCore([mem('mem/a-1')]).core).toBeNull();
  });
});

describe('memoryRows — 묶고, 고르고, 줄로 편다', () => {
  const pr = (n: number, day: number) => mem(`mem/pr-${n}-x`, `# PR ${n}`, day);

  it(`같은 접두어가 ${MIN_GROUP_SIZE}개 이상이면 한 줄로 접는다`, () => {
    const rows = memoryRows([pr(1, 1), pr(2, 2), pr(3, 3), mem('mem/search', '# 검색', 4)]);
    expect(rows.map((r) => (r.kind === 'group' ? r.group.key : r.item.slug)))
      .toEqual(['mem/search', 'mem/pr-']);
    const group = rows.find((r) => r.kind === 'group');
    expect(group?.kind === 'group' && group.group.items).toHaveLength(3);
  });

  /** 둘은 감추는 값이 누르는 비용을 넘지 못한다 — 그대로 두 줄로 선다. */
  it('둘뿐이면 묶지 않는다', () => {
    const rows = memoryRows([pr(1, 1), pr(2, 2)]);
    expect(rows.every((r) => r.kind === 'item')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('기본 정렬은 수정순이다 — 최근 것이 위', () => {
    const rows = memoryRows([mem('mem/a-1', '#a', 1), mem('mem/b-1', '#b', 5), mem('mem/c-1', '#c', 3)]);
    expect(rows.map((r) => r.kind === 'item' && r.item.slug)).toEqual(['mem/b-1', 'mem/c-1', 'mem/a-1']);
  });

  it('이름순도 고를 수 있다', () => {
    const rows = memoryRows(
      [mem('mem/c-1', '#c', 5), mem('mem/a-1', '#a', 1), mem('mem/b-1', '#b', 3)],
      { sort: 'name' },
    );
    expect(rows.map((r) => r.kind === 'item' && r.item.slug)).toEqual(['mem/a-1', 'mem/b-1', 'mem/c-1']);
  });

  /**
   * 묶음을 목록 끝에 몰면 최근에 고친 `mem/pr-*` 가 맨 아래로 밀려 정렬을 수정순으로 둔
   * 뜻이 사라진다. 자리는 그 안에서 가장 앞서는 항목이 정한다.
   */
  it('묶음의 자리는 가장 최근 항목이 정한다', () => {
    const rows = memoryRows([
      mem('mem/zz-1', '#z', 2),
      pr(1, 9), pr(2, 8), pr(3, 7),
    ]);
    expect(rows[0]?.kind).toBe('group');
    expect(rows[1]?.kind === 'item' && rows[1].item.slug).toBe('mem/zz-1');
  });

  it('같은 시각이면 이름으로 가른다 — 순서가 렌더마다 흔들리면 안 된다', () => {
    const rows = memoryRows([mem('mem/b-1', '#b', 3), mem('mem/a-1', '#a', 3)]);
    expect(rows.map((r) => r.kind === 'item' && r.item.slug)).toEqual(['mem/a-1', 'mem/b-1']);
  });

  it('검색은 slug 와 본문 둘 다 본다', () => {
    const entries = [mem('mem/worktree-traps', '# 워크트리에서 데인 것'), mem('mem/search-ranking', '# 검색 순위')];
    expect(memoryRows(entries, { query: 'worktree' }).map((r) => r.kind === 'item' && r.item.slug))
      .toEqual(['mem/worktree-traps']);
    // 본문에만 있는 말도 찾는다.
    expect(memoryRows(entries, { query: '순위' }).map((r) => r.kind === 'item' && r.item.slug))
      .toEqual(['mem/search-ranking']);
  });

  it('대소문자를 가리지 않는다', () => {
    expect(memoryRows([mem('mem/PR-1-x')], { query: 'pr-1' })).toHaveLength(1);
  });

  /**
   * 걸러 낸 결과가 둘뿐인데 묶음 머리가 그대로 서 있으면 사람은 접힌 줄 뒤에 더 있다고
   * 읽는다 — 없는데 있다고 말하는 화면이 된다.
   */
  it('검색으로 묶음이 셋 미만이 되면 다시 낱줄로 편다', () => {
    const rows = memoryRows([pr(1, 1), pr(2, 2), pr(3, 3)], { query: 'PR 1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('item');
  });

  it('아무것도 안 걸리면 빈 목록이다', () => {
    expect(memoryRows([mem('mem/a-1')], { query: '없는말' })).toEqual([]);
  });

  it('빈 검색어는 거르지 않는다 — 공백만 친 것도 마찬가지다', () => {
    expect(memoryRows([mem('mem/a-1'), mem('mem/b-1')], { query: '   ' })).toHaveLength(2);
  });

  /** 받은 배열을 제자리에서 정렬하면 부르는 쪽의 상태가 조용히 바뀐다. */
  it('입력 배열을 건드리지 않는다', () => {
    const entries = [mem('mem/b-1', '#b', 1), mem('mem/a-1', '#a', 5)];
    memoryRows(entries);
    expect(entries.map((e) => e.slug)).toEqual(['mem/b-1', 'mem/a-1']);
  });
});
