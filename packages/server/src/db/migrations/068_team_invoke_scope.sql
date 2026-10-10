-- 팀의 호출 범위 — 에이전트(059)와 **같은 네 값·같은 규칙**을 팀에도 둔다(jaebin 결정 2026-09-28:
-- "에이전트와 마찬가지로 에이전트 팀도 동일하게 호출할 수 있는 권한과 스코프 권한을 가지도록").
--
-- 왜 필요했나: 059 의 게이트는 팀을 거쳐 온 부름을 `community` 에이전트만 통과시켰다. 팀원이
-- 나중에 owner 로 좁혀지면(개인 MCP 를 붙이면 화면이 invokeScope=owner 를 함께 보낸다) 그 팀의
-- 부름은 소유자가 불러도 **아무 흔적 없이** 사라졌다 — #ops 에서 `@ops-team` 네 번이 👀 없이
-- 끝난 사건. 팀 멘션은 사람이 이름을 붙여 둔 명단을 부르는 것이지 "소유자가 아닌 무언가"가
-- 부르는 것이 아니다 — 부른 사람은 그대로 작성자다.
--
-- 판정은 두 겹이다(`services/invokeGate.ts`): ① 팀의 범위로 "이 사람이 이 팀을 부를 수 있나",
-- ② 통과하면 팀원 각자의 범위로 "이 사람이 이 팀원을 부를 수 있나"(직접 멘션과 같은 판정).
-- ②가 있어서 팀이 팀원의 범위를 **넓히지 못한다** — owner 전용 에이전트를 community 팀에 넣어도
-- 남은 그 팀원을 깨우지 못한다.
--
-- backfill 은 **현행 동작 유지**: community. 소유자는 팀을 만든 사람(created_by)으로 채운다 —
-- owner 범위를 고를 때 가리킬 사람이 이미 있어야 하고, 036 이 그 사람을 이미 적어 두었다.
alter table agent_team
  add column invoke_scope text not null default 'community'
    check (invoke_scope in ('owner', 'list', 'channel', 'community')),
  add column owner_account_id uuid references account(id);

update agent_team set owner_account_id = created_by where owner_account_id is null;

-- invoke_scope = 'list' 의 명단(059 의 agent_invoker 와 같은 모양).
create table agent_team_invoker (
  team_id    uuid not null references agent_team(id) on delete cascade,
  account_id uuid not null references account(id) on delete cascade,
  primary key (team_id, account_id)
);
