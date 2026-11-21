-- 「정확한 명령」 승인(권한 요청 H②, 스레드 8769dbf7, jaebin H 선택 10-08).
--
-- 에이전트가 `permission.request` kind=command 로 **명령 하나 그대로**를 청하면 소유자가 카드에서
-- 「이번 한 번」(once) 또는 「이 스레드 1시간」(hour) 으로 승인한다. 승인은 소유자의 사람 세션만 만든다(111 과 같은 길).
-- 오퍼레이터의 PreToolUse hook 이 이 줄과 **정확히 같은 명령**(shared `validateExactCommand` 정규형)일 때만 allow 를 낸다.
-- account_grant 와 따로 두는 이유: 범위가 스레드이고, 1회짜리를 원자적으로 소모해야 하며(`used_at`), 쓸 때마다 센다.
alter table permission_request drop constraint permission_request_kind_check;
alter table permission_request add constraint permission_request_kind_check check (kind in ('tool', 'merge', 'command'));
alter table permission_request add column grant_mode text check (grant_mode in ('once', 'hour'));

create table command_grant (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references account(id) on delete cascade,
  channel_id      uuid not null references channel(id) on delete cascade,
  thread_root_id  uuid not null,
  -- 정규형(shared validateExactCommand). 셸 문법·따옴표는 들어올 수 없다.
  command         text not null,
  single_use      boolean not null,
  expires_at      timestamptz not null,
  -- 1회짜리는 이것이 차면 끝이다. 여러 번짜리는 첫 사용 시각.
  used_at         timestamptz,
  use_count       integer not null default 0,
  granted_by      uuid references account(id) on delete set null,
  request_id      uuid references permission_request(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index command_grant_live on command_grant (agent_id, thread_root_id, command);
