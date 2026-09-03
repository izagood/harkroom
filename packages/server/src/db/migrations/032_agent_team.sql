-- 에이전트 팀 (#172). 팀은 에이전트 집합을 이름을 붙여 저장한 것이다.
-- 같은 팀 이름을 여러 운영자가 같은 워크스페이스에 만들 수는 없다.
create table agent_team (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_by uuid not null references account(id),
  created_at timestamptz not null default now()
);

-- 팀원. 에이전트만 넣을 수 있다 — 팀원이 된 계정이 에이전트가 아니면 routes 단에서 400 을 반환한다.
create table agent_team_member (
  team_id uuid not null references agent_team(id) on delete cascade,
  agent_account_id uuid not null references account(id),
  primary key (team_id, agent_account_id)
);

-- 팀 소유자는 팀을 삭제할 수 있다 — 만들었다면 다른 admin 도 삭제할 수 있다.
-- created_by 는 감사 로그에서 '누가 만들었는가'를 기록하기 위한 것이지,
-- 특별 권한을 주는 것이 아니다.