-- 사람 집합을 한 handle 로 부르기(#230).
--
-- 에이전트 계정을 집합에 넣으려 하면 400 이다 — 화면에서만 막으면 안 되고
-- 서버가 강제해야 한다. 같은 경로로 에이전트 생성을 막아도 이미 만들어진
-- 에이전트를 뒤늦게 집합에 넣을 수 있으므로, 추가 시점에도 확인한다.
--
-- on delete cascade: 집합이 사라지면 명단은 뜻이 없다. 메시지와 달리 독립적 가치를
-- 갖는 것이 아니다 — "@team 이라고 불린 메시지"가 아니라 "그때 그 people"이
-- 중요하고, people 이 사라진 뒤의 추적은 의미가 없다.
create table handle_group (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);
create table handle_group_member (
  group_id uuid not null references handle_group(id) on delete cascade,
  account_id uuid not null references account(id),
  primary key (group_id, account_id)
);
create index handle_group_member_account_idx on handle_group_member (account_id);