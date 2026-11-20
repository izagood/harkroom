-- migrate: no-transaction
--
-- 쿼리 개선 s39 E-4(2026-11-20). 질의는 그대로 두고 색인 하나를 더한다.
--
-- 머지 래퍼의 결과 보고(`reportMerge` — TS mergeGrants.ts, Rust merge_checks.rs 의 TRAIL_SQL·POST_TRAIL_SQL)는
-- 보고마다 그 임대의 머지 기록을 audit_log 에서 찾는다:
--   action in ('repo.merge.checked', 'repo.merge.merged', 'repo.merge.queued', 'repo.merge.failed')
--   and target = $1 and detail->>'leaseId' = $2 and (detail->>'number')::int = $3 and detail->>'headSha' = $4
-- 지금 색인은 (action, id desc) 하나라 **그 네 action 의 줄 전부**를 훑고 걸렀다. audit_log 는 지우지 않는 표라
-- 머지가 쌓일수록 느려진다(운영 앞단 쓰기 역할에서 한 번 평균 약 3초). 124 의 api.call 색인과 같은 꼴로
-- 네 action 만 담는 부분 색인을 두고 (대상, 임대) 로 바로 찾는다.
--
-- 트랜잭션 밖에서 concurrently 로 만든다(#1331). 앞서 실패해 INVALID 로 남은 것이 있으면 먼저 걷는다.
drop index concurrently if exists audit_log_merge_trail_idx;
create index concurrently if not exists audit_log_merge_trail_idx
  on audit_log (target, (detail->>'leaseId'))
  where action in ('repo.merge.checked', 'repo.merge.merged', 'repo.merge.queued', 'repo.merge.failed');
