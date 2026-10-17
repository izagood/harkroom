-- CI 실패 무시 1회 승인(스레드 1fccc9a5, jaebin 지시 10-17 — "내가 명시적으로 승인하면 CI 조건 없이도 머지").
--
-- 7일 grant 가 있어도 래퍼가 CI 때문에(`ci_not_green`·`not_mergeable` UNSTABLE) 거절하면 서버가 거절 기록을 남겨 카드를 세운다.
-- 기록은 **같은 임대로 `checkMerge` 를 통과한 그 repo·PR·head** 의 실패 보고(`/agent/merge-results` 의 `ciRefusal`)에서만 생긴다.
-- 기록은 권한을 주지 않는다 — 소유자 사람 세션의 [이번 한 번 머지] 승인만 연다. 그 승인은
-- - 7일 grant 로 바꿀 수 없다(400) — 권한은 이미 있다. relaxChecks 는 언제나 true 다(false 면 400).
-- - **쓰는 턴도 사람이 띄운 것**이어야 한다(`ci_override` — wake·에이전트 위임 턴은 소모하지 못한다).
-- - `approved_checks`: 승인 때 카드가 보여 준 실패 체크. 머지 때 래퍼가 다시 읽은 목록이 이보다 늘었으면 시스템 줄에 표시한다.
alter table merge_denial drop constraint merge_denial_reason_check;
alter table merge_denial add constraint merge_denial_reason_check
  check (reason in ('not_granted', 'cause_not_human', 'ci_not_green'));
-- 래퍼가 보고한 초록 아닌 체크 이름(서버가 다시 거른 값 — 이름당 80자, 20개까지, 제어·bidi·Cf 문자 없음).
alter table merge_denial add column failed_checks text[] not null default '{}';

alter table merge_approval add column ci_override boolean not null default false;
alter table merge_approval add column approved_checks text[] not null default '{}';
