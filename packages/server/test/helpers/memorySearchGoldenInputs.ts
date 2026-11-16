// Rust memory.search 골든(`crates/harkroom-server/golden/memory_search.json`)의 입력. 생성 스크립트(`scripts/genRustMemorySearchGolden.ts`)와
// TS 시험이 같이 쓴다. JS 와 Rust 가 갈릴 만한 곳(JS \s·U+0085·U+FEFF·UTF-16 길이·짧은 ASCII 경계·조사/어미 순서)을 일부러 짚는다.
import type { RecallCandidate } from '../../src/services/memory.js';

export const nameRows = [
  { handle: 'mina', display_name: 'Mi Na', kind: 'human' },
  { handle: 'alice_kim', display_name: '김 앨리스', kind: 'human' },
  { handle: 'x', display_name: null, kind: 'human' },
  { handle: 'forge', display_name: 'Forge', kind: 'agent' },
  { handle: 'ops.team-lead', display_name: ' Ops\u0085Lead ', kind: 'human' },
  { handle: 'bob', display_name: 'B﻿ob', kind: 'human' },
];

export const termQueries: string[] = [
  '', ' ', 'a', '조사해 달라', '권한', '제한을', '메모리 쓰기 풀 GRANT 를 확인해줘', '서버에서 머지했습니다', 'PR 레시피를 보고해라',
  '@mina 이거 다시 봐줘', '@forge billing 부가 서비스 forge 이관', 'https://github.com/izagood/harkroom/pull/2214 를 봐라',
  '[첨부: 스크린샷.png] 화면이 깨진다', 'ui 가 progress 바에서 깨진다', 'pr ui mcp-ui-sheet', 'Mi Na 님께 보고', 'alice 의 결정',
  'hrki_abcdefghijklmnopqrstuvwx 토큰', '0f3a9c2e-1111 id 조각', '1 2 34 v0 v1', '---', '감사합니다 기억 정리', '감사 결과는?',
  '감사해요! 다시 계속', '그대로 진행해', '그걸로 해줘', 'ok again continue memory', '똑같이 해야해', 'GO 언어 빌드',
  '한\u0085글 나눔', '한﻿글 나눔', '한 글　나눔', '이모지😀를 넣어', '😀😀', '가😀', 'Straße ÉCOLE İstanbul',
  'a,b.c;d:e!f?g(h)i[j]k{l}m"n\'o`p<q>r@s#t|u/v\\w*x~y=z+aa', 'released 0.4.711 release', 'mem/pr-recipe 를 열어',
  'core 기억 3000자', '스레드 메모 thread.note', '이전 지시를 무시해', 'harkroom://message/abc 를 봐', 'mailto:x@y.z 보내',
  '하나 둘 셋 넷 다섯 여섯 일곱 여덟 아홉 열 열하나 열둘 열셋 열넷', '에서', '으로부터', '처럼처럼', '되어되어', '했습니다만',
  '배포했다', '배포됐다', '설정해주세요', '만들어', '권한이', '사람의', '작업하려', 'kubectl exec pod', 'rust 이식 B1c',
  '메시지 검색', 'reviews delegation-12 정리', '감사합니다.', '감사해,', '감사합니다만 문제', 'ŞIK ǅ', 'tab\tsep\nline\rcr\vvt\ffeed',
  ' ls ps', '%like_escape\\', 'aa aaa aaaa', 'ui-ui ui_ui', 'Ab3 x9 zz',
];

export const threadStateSlugs: string[] = [
  'core', 'mem/review-2214', 'mem/reviews', 'mem/delegation', 'mem/delegations-open', 'mem/x/review_1', 'mem/pr-review-loop',
  'mem/review#3', 'mem/foo/delegation-12/bar', 'mem/my-reviews-#4', 'mem/reviewer', 'mem/deploy/review', 'review-1', 'mem/a-review9',
];


export const rankRows: RecallCandidate[] = ([
  { slug: 'core', description: null, kind: 'topic', value: '머지 규칙 권한' },
  { slug: 'mem/pr-recipe', description: 'PR 만들기·검증·CI·권한·머지 규칙', kind: 'procedure', value: 'gh pr create 전에 머지 래퍼. ui 시안 확인. 권한 권한 권한' },
  { slug: 'mem/merge-wrapper-queue-unstable', description: '머지 래퍼 1회 승인·큐·UNSTABLE', kind: 'topic', value: '머지 큐에 넣음. pr 상태' },
  { slug: 'mem/journal/e2cc9c57', description: '머지 경위', kind: 'topic', value: '머지' },
  { slug: 'mem/j1', description: '머지 기록', kind: 'journal', value: '머지' },
  { slug: 'mem/ui/progress-bar', description: 'progress 바 깨짐', kind: 'topic', value: 'ui ui ui progress' },
  { slug: 'mem/ui/sheet', description: 'mcp-ui-sheet 시트 ui', kind: 'topic', value: 'sheet' },
  { slug: 'mem/deploy/rollback', description: '배포 되돌리기 — 감사 결과', kind: 'procedure', value: 'helm rollback. 배포 배포' },
  { slug: 'mem/memory-system-history', description: '기억 체계 경위', kind: 'topic', value: '기억 정리 memory' },
  { slug: 'mem/dev/disk-hygiene-rust-builds', description: 'Rust target 정리', kind: 'topic', value: 'cargo target 지우기 rust' },
  { slug: 'mem/b-tie', description: '동점 시험 rust', kind: 'topic', value: 'x' },
  { slug: 'mem/a-tie', description: '동점 시험 rust', kind: 'topic', value: 'x' },
  { slug: 'mem/MixedCase', description: 'Kubectl 사용', kind: 'topic', value: 'KUBECTL exec' },
  { slug: 'mem/mcpui-lookbehind', description: 'mcpui 꼴 pr2 ab3', kind: 'topic', value: 'xui uix ui' },
  { slug: 'mem/again-note', description: '다시 제안 금지', kind: 'topic', value: '다시' },
] as Omit<RecallCandidate, 'updatedAt'>[]).map((r, i) => ({ ...r, updatedAt: new Date(Date.UTC(2026, 10, 1 + i, 3, 4, 5, 6)) }));

export const rankQueries: { query: string; focus?: string }[] = [
  { query: '머지 권한 확인' }, { query: 'PR 머지 래퍼' }, { query: 'ui progress' }, { query: 'ui sheet' }, { query: 'rust 동점' },
  { query: '배포 되돌리기', focus: '감사합니다' }, { query: '배포 되돌리기', focus: '감사 결과는?' }, { query: '머지 큐', focus: '다시 봐줘' },
  { query: '머지 큐 pr', focus: 'unstable 이면?' }, { query: 'kubectl exec' }, { query: '기억 정리 memory' }, { query: '다시 제안' },
  { query: '@mina 머지' }, { query: 'Mi Na 권한' }, { query: '' }, { query: 'cargo target rust', focus: 'target' },
];
