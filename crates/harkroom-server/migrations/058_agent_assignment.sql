-- 배정(스펙 2026-09-20-operator-and-permissions §3): 이 에이전트는 어느 오퍼레이터가 도는가.
-- 에이전트당 하나 — 같은 에이전트에 러너가 둘이면 멘션을 나눠 집어 간다(design.md §1).
-- 능력(무엇을 돌릴 수 있나)은 여기 없다: 그것은 오퍼레이터가 살아 있을 때의 사실이라
-- 허브가 인메모리로 든다. 배정은 사람의 결정이라 기록이다.
create table agent_assignment (
  agent_id     uuid primary key references account(id) on delete cascade,
  operator_id  uuid not null references operator(id) on delete cascade,
  assigned_by  uuid not null references account(id),
  assigned_at  timestamptz not null default now()
);
create index agent_assignment_operator_idx on agent_assignment (operator_id);
