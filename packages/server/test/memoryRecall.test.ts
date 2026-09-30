import { describe, expect, it } from 'vitest';
import { rankRecall, searchTerms, type RecallCandidate } from '../src/services/memory.js';

// recall P1 의 순수 부분 — pg 없이 돈다. 정답 세트(fixture) 회귀도 이 자리에 붙인다.
describe('searchTerms', () => {
  it('옛 동작: 조사를 떼고 12개에서 자른다', () => {
    expect(searchTerms('캐시가 치명적이다')).toEqual(['캐시', '치명적이다']);
  });

  it('활용 어미를 떼되 어간이 두 글자 이상 남을 때만', () => {
    expect(searchTerms('조사해 측정했다 구현한다 권한 제한')).toEqual(['조사', '측정', '구현', '권한', '제한']);
  });

  it('recall 모드: @handle·주소·계정 이름·상투어·id 조각을 먼저 거르고 12개를 센다', () => {
    const exclude = new Set(['jaebin', 'task_manager', 'task', 'manager']);
    const noise = '@harkroom @qa_manager task_manager: jaebin 결정 #task 경유 지시 harkroom://message/ad09ce28-46e5-4661-8a20-54d502395667 ';
    const words = '하나 둘셋 넷다섯 여섯 일곱 여덟 아홉 열개 열하나 열둘 열셋 열넷';
    const terms = searchTerms(noise + words, { exclude });
    expect(terms).toEqual(['결정', '하나', '둘셋', '넷다섯', '여섯', '일곱', '여덟', '아홉', '열개', '열하나', '열둘', '열셋']);
  });

  it('exclude 가 없으면(에이전트가 직접 찾을 때) 이름도 찾는다', () => {
    expect(searchTerms('jaebin 결정')).toEqual(['jaebin', '결정']);
  });
});

const row = (slug: string, description: string | null, value: string, kind: RecallCandidate['kind'] = 'topic'): RecallCandidate =>
  ({ slug, description, value, kind, updatedAt: new Date(0) });

describe('rankRecall', () => {
  it('이름·요약 일치가 없으면 본문이 아무리 걸려도 싣지 않는다', () => {
    const hits = rankRecall(['캐시', '러너'], [row('mem/x', null, '캐시 러너 캐시')], 5);
    expect(hits).toEqual([]);
  });

  it('journal·core 는 뺀다', () => {
    const hits = rankRecall(['캐시'], [row('core', '캐시', '캐시'), row('mem/j', '캐시', '캐시', 'journal')], 5);
    expect(hits).toEqual([]);
  });

  it('동점은 이름 일치 수 → 본문 출현 수 → slug 로 가른다(최근 수정 순이 아니다)', () => {
    const rows = [
      row('mem/b', '캐시', '러너 러너'), // 3 + 1 = 4, 이름 1
      row('mem/a', '캐시', '러너'), // 4, 이름 1, 출현 적음
      row('mem/c', null, '캐시 러너'), // 이름 0 → 빠짐
      row('mem/d-러너', '캐시', ''), // 6, 이름 2
    ];
    rows[1]!.updatedAt = new Date(); // 더 최근이어도 순서를 못 바꾼다
    expect(rankRecall(['캐시', '러너'], rows, 5).map((h) => [h.slug, h.score, h.nameHits])).toEqual([
      ['mem/d-러너', 6, 2], ['mem/b', 4, 1], ['mem/a', 4, 1],
    ]);
  });
});
