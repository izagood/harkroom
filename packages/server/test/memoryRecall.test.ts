import { describe, expect, it } from 'vitest';
import { excludedNamesFrom, focusTermsOf, rankRecall, searchTerms, type RecallCandidate } from '../src/services/memory.js';

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

  it('recall 모드: 비밀값처럼 생긴 조각·[첨부: …]·기호 덩어리는 낱말로 받지 않는다(로그에 남으므로)', () => {
    const terms = searchTerms('hrki_w7G6Vl65h6NkKoAhkhKjxzXmwEdfiPf 초대 토큰 [첨부: shot.png (id 51e5)] --- 서빙해야해', { exclude: new Set() });
    expect(terms).toEqual(['초대', '토큰', '서빙']);
  });

  it('exclude 가 없으면(에이전트가 직접 찾을 때) 이름도 찾는다', () => {
    expect(searchTerms('jaebin 결정')).toEqual(['jaebin', '결정']);
  });
});

// G 후속(qa 10-03): 후속 턴 되받는 말은 focus 낱말이 못 된다 — 게이트를 여는 열쇠가 '다시' 였다.
describe('focusTermsOf', () => {
  it('되받는 말(다시·계속·그대로·그걸로·좋아 그렇게…)은 focus 에서 빠진다', () => {
    for (const q of ['다시 봐 줘', '그대로 진행해', '응 그걸로 해 줘', '계속 해', '다시 한번 확인해 줘', '좋아 그렇게 해', '이어서 해 줘', '마저 해', 'ok 해줘']) {
      expect([q, focusTermsOf(q, new Set())]).toEqual([q, []]);
    }
  });

  it('주제어는 남는다 — 되받는 말과 섞여도', () => {
    expect(focusTermsOf('다시 배포 되돌림 봐 줘', new Set())).toEqual(['배포', '되돌림']);
    expect(focusTermsOf('jaebin 캐시 계속 봐 줘', new Set(['jaebin']))).toEqual(['캐시']);
  });

  it('첫 턴 질의(searchTerms)에는 걸지 않는다 — "다시 제안 금지" 를 주제로 찾을 수 있다', () => {
    expect(searchTerms('다시 제안 금지', { exclude: new Set() })).toContain('다시');
  });

  it('qa 재현: 요약에 "다시" 가 든 기억은 "다시 봐 줘" 후속 턴에 게이트를 못 지난다', () => {
    const rows = [row('mem/team-phase3-done', '거부된 설계 — 다시 제안 금지', ''), row('mem/deploy', '배포 절차', '')];
    const terms = ['다시', '배포'];
    expect(rankRecall(terms, rows, 5, { focus: new Set(focusTermsOf('다시 봐 줘', new Set())) })).toEqual([]);
    expect(rankRecall(terms, rows, 5, { focus: new Set(['다시']) }).map((h) => h.slug)).toEqual(['mem/team-phase3-done']);
  });
});

describe('excludedNamesFrom', () => {
  it('사람만 조각까지 뺀다 — 에이전트·팀 이름(rcms·forge·server)은 주제어라 남긴다', () => {
    const names = excludedNamesFrom([
      { handle: 'jaebin', display_name: 'Jaebin Lee', kind: 'human' },
      { handle: 'rcms', display_name: 'rcms', kind: 'agent' },
      { handle: 'avcs-server', display_name: 'AVCS Server', kind: 'agent' },
      { handle: 'core-team', display_name: null, kind: 'group' },
    ]);
    expect([...names].sort()).toEqual(['jaebin', 'jaebin lee', 'lee']);
  });
});

const row = (slug: string, description: string | null, value: string, kind: RecallCandidate['kind'] = 'topic'): RecallCandidate =>
  ({ slug, description, value, kind, updatedAt: new Date(0) });

describe('rankRecall', () => {
  // G: 후속 턴 게이트 — 새 말(focus) 낱말이 이름·요약에 하나도 안 걸린 것은 루트 낱말만으로는 싣지 않는다.
  it('focus 를 주면 focus 낱말이 이름·요약에 걸린 것만 남고, termHits 로 무엇에 걸렸는지 말한다', () => {
    const rows = [
      row('mem/deploy-recipe', '배포 절차', ''),   // 루트 낱말(배포)만
      row('mem/deploy-rollback', '배포 되돌림', ''), // 루트 + 새 말(되돌림)
      row('mem/rollback-db', '되돌림 DB', ''),       // 새 말만
    ];
    const terms = ['되돌림', '배포'];
    const all = rankRecall(terms, rows, 5);
    expect(all.map((h) => h.slug)).toEqual(['mem/deploy-rollback', 'mem/deploy-recipe', 'mem/rollback-db']);
    expect(all[0]!.termHits).toEqual(['되돌림', '배포']);
    const gated = rankRecall(terms, rows, 5, { focus: new Set(['되돌림']) });
    // 루트 낱말은 순위만 돕는다 — 둘 다 걸린 것이 위.
    expect(gated.map((h) => h.slug)).toEqual(['mem/deploy-rollback', 'mem/rollback-db']);
  });

  it('focus 가 비어 있으면(새 말에 낱말이 없다) 아무것도 싣지 않는다', () => {
    expect(rankRecall(['배포'], [row('mem/deploy-recipe', '배포 절차', '')], 5, { focus: new Set() })).toEqual([]);
  });

  it('이름·요약 일치가 없으면 본문이 아무리 걸려도 싣지 않는다', () => {
    const hits = rankRecall(['캐시', '러너'], [row('mem/x', null, '캐시 러너 캐시')], 5);
    expect(hits).toEqual([]);
  });

  it('journal·core 는 뺀다', () => {
    const hits = rankRecall(['캐시'], [row('core', '캐시', '캐시'), row('mem/j', '캐시', '캐시', 'journal')], 5);
    expect(hits).toEqual([]);
  });

  it('이름이 mem/journal/ 이면 kind 가 topic 이어도 뺀다', () => {
    expect(rankRecall(['캐시'], [row('mem/journal/e2cc9c57', '캐시', '')], 5)).toEqual([]);
  });

  it('3자 이하 영문은 경계에서만 맞춘다 — pr 이 progress 에 걸리지 않는다', () => {
    const rows = [row('mem/mcp-ui-phase1-progress', null, ''), row('mem/pr-recipe', null, 'pr 만들기')];
    expect(rankRecall(['pr'], rows, 5).map((h) => [h.slug, h.score])).toEqual([['mem/pr-recipe', 4]]);
  });

  it('회귀(qa 09-30): 에이전트 이름이 주제어인 질의가 그 에이전트의 기억을 찾는다', () => {
    const exclude = excludedNamesFrom([
      { handle: 'jaebin', display_name: 'jaebin', kind: 'human' },
      { handle: 'rcms', display_name: 'rcms', kind: 'agent' },
      { handle: 'forge', display_name: 'forge', kind: 'agent' },
    ]);
    const terms = searchTerms('rcms 부가 서비스 forge 이관', { exclude });
    const rows = [
      row('mem/forge-side-services', null, ''), row('mem/rcms-deploy-pipeline', null, ''),
      row('mem/rcms-frontend-dev', null, ''), row('mem/unrelated', null, 'rcms forge'),
    ];
    const slugs = rankRecall(terms, rows, 5).map((h) => h.slug);
    expect(slugs).toContain('mem/forge-side-services');
    expect(slugs).not.toContain('mem/unrelated');
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
