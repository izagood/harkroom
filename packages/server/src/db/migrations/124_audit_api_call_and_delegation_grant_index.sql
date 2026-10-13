-- migrate: no-transaction
--
-- 쿼리 개선 Q5-b(2026-10-13). 질의는 그대로 두고 색인 둘을 더한다.
--
-- ① `reportApiCall`(apiCalls.ts) 은 래퍼 보고마다 그 임대의 「판정·보고」 줄을 audit_log 에서 센다:
--    action in ('api.call.checked', 'api.call.done') and target = $1 and detail->>'leaseId' = $2 …
--    지금 색인은 (action, id desc) 하나라 **그 두 action 의 줄 전부**를 훑고 걸렀다 — API 호출이 쌓일수록 느려진다.
--    audit_log 는 지우지 않는 표(append-only)라 줄이 줄지 않는다. 두 action 만 담는 부분 색인으로 (대상, 임대) 를 바로 찾는다.
-- ② `decideDelegation`(apiDelegation.ts) 은 위임 승인·거절 때 그 grant 를 실은 카드 메시지를
--    meta->'delegation'->>'grantId' = $1 로 찾아 고친다. 색인이 없어 message 를 통째로 훑었다(드문 경로지만 message 는 크다).
--    위임 카드만 담는 부분 식 색인이다.
--
-- 트랜잭션 밖에서 concurrently 로 만든다(#1331). 앞서 실패해 INVALID 로 남은 것이 있으면 먼저 걷는다.
drop index concurrently if exists audit_log_api_call_lease_idx;
create index concurrently if not exists audit_log_api_call_lease_idx
  on audit_log (target, (detail->>'leaseId'))
  where action in ('api.call.checked', 'api.call.done');
drop index concurrently if exists message_delegation_grant_idx;
create index concurrently if not exists message_delegation_grant_idx
  on message ((meta->'delegation'->>'grantId'))
  where meta->'delegation'->>'grantId' is not null;
