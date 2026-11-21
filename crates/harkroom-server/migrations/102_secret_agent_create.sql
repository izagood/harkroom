-- 에이전트가 비밀을 만든다(102) — 계획 harkroom 스레드 1a08d0cf, jaebin「전부 추천대로」, security 조건부 OK(F1~F4).
--
-- - 소유자는 **그 에이전트의 소유자(사람)** 다(D-a). 에이전트 소유로 두면 에이전트를 지울 때 cascade 로 비밀이
--   사라지고, 부여는 소유자만(D4)·소유자 자신의 에이전트에게만(#1156) 규칙이 그대로 지켜지지 않는다.
--   만든 에이전트와 그 턴을 띄운 메시지는 아래 두 칸에 남긴다(화면의 "값을 @x 가 정함" 배지, L2).
-- - 회전 권한(F3)은 이 칸이 아니라 **최신 판의 created_by**(secret_version, 이미 있다)와 부여 줄로 판정한다.
alter table secret
  add column created_by_agent_id uuid null references account(id) on delete set null,
  add column created_cause_message_id uuid null;
create index secret_created_by_agent_idx on secret (created_by_agent_id) where created_by_agent_id is not null;

-- 접근 기록에 만들기·회전을 같은 줄로 남긴다(값도 해시도 넣지 않는 규칙은 그대로).
alter table secret_access_log drop constraint secret_access_log_result_check;
alter table secret_access_log add constraint secret_access_log_result_check
  check (result in ('granted', 'denied', 'created', 'rotated'));
