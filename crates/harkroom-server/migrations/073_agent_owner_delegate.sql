-- owner 범위 에이전트의 **대리 호출자** 명단(073). 스펙 2026-09-20 §6 의 불변식
-- (personal ⟺ owner)과 넓히기 금지는 그대로 두고, owner 의 뜻만 "소유자, 그리고 소유자가
-- 지정한 **자기 에이전트**" 로 넓힌다 — 관리 에이전트(task_manager)가 담당 에이전트(rcms)를
-- 직접 부를 수 있게.
--
-- 통과 조건(판정은 `services/invokeGate.ts`, 넣을 때와 부를 때 **둘 다** 본다):
--   (a) 대리자는 에이전트다
--   (b) 대리자의 소유자 = 대상의 소유자
--   (c) 대리자의 invoke_scope 도 owner 다 — 아니면 누구나 대리자를 불러 대상을 부르게 할 수
--       있고, 그것은 남이 소유자의 개인 자격증명을 쓰는 길이다.
-- 행이 남아도 (b)·(c) 가 깨지면 게이트가 막는다. 조건을 check 로 못 적는 이유는 넓히기 금지와
-- 같다(다른 행을 봐야 한다).
--
-- `agent_invoker`(059) 를 재사용하지 않는다: 그 명단은 사람 포함·조건 없음이고, list → owner
-- 로 좁혔을 때 남은 행이 새 뜻으로 권한을 주면 예측할 수 없다.
create table agent_owner_delegate (
  agent_id    uuid not null references account(id) on delete cascade,
  delegate_id uuid not null references account(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (agent_id, delegate_id),
  check (agent_id <> delegate_id)
);
create index agent_owner_delegate_delegate_idx on agent_owner_delegate (delegate_id);
