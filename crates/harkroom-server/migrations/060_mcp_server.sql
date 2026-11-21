-- MCP 레지스트리 — 스펙 2026-09-20 §6. **이름만 서버에 둔다.** 정의(명령·인자)와 토큰은 서버 DB 를
-- 지나지 않는다 — 오퍼레이터가 자기 머신에서 그 이름의 정의를 꺼내 생성 mcp.json 에 합친다.
-- 서버가 아는 것은 "그 이름이 무슨 자격증명을 쓰나"(community|personal)뿐이고, 에이전트의
-- mcp_servers 는 이 이름들의 부분집합이다. personal 이름이 하나라도 있으면 그 에이전트의
-- credential_scope 는 personal 이어야 한다(서비스가 검사한다).
create table mcp_server (
  name            text primary key check (name ~ '^[a-z0-9-]{1,32}$'),
  credential_kind text not null check (credential_kind in ('community', 'personal')),
  created_by      uuid references account(id) on delete set null,
  created_at      timestamptz not null default now()
);

create table agent_mcp_server (
  agent_id uuid not null references account(id) on delete cascade,
  name     text not null references mcp_server(name) on delete cascade,
  primary key (agent_id, name)
);
