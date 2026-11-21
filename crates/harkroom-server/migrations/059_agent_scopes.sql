-- 호출·자격증명 스코프 — 스펙 2026-09-20 §6. `owner_account_id` 하나가 겸하던 셋(설정 소유·
-- 배정 소유·"누가 깨울 수 있나")에서 뒤의 것을 갈라 낸다.
--
-- backfill 은 **현행 동작 유지**(확정): invoke_scope=community, credential_scope=none. 오늘
-- 에이전트에 붙은 개인 MCP 는 없으므로 none 이 정확하다. 추측 소유자 backfill 은 안 한다(008 판례).
--
-- 양방향 불변식(personal ⟺ owner)과 넓히기 금지는 DB 가 아니라 서비스가 지킨다 — 넓히기
-- 금지는 이전 값이 필요해서 check 로 못 적는다(`services/agents.ts::validateScopeChange`).
alter table agent_config
  add column invoke_scope text not null default 'community'
    check (invoke_scope in ('owner', 'list', 'channel', 'community')),
  add column credential_scope text not null default 'none'
    check (credential_scope in ('personal', 'community', 'none'));

-- invoke_scope = 'list' 의 명단. 소유자·admin 이 관리한다.
create table agent_invoker (
  agent_id   uuid not null references account(id) on delete cascade,
  account_id uuid not null references account(id) on delete cascade,
  primary key (agent_id, account_id)
);
