-- 에이전트 권한 요청(스레드 f61af808, jaebin D1~D4 10-07).
--
-- 에이전트가 `permission.request` MCP 로 권한 하나(Claude Code allow 규칙 또는 머지 저장소)와 이유를 올리면 한 줄이 생기고,
-- 서버가 소유자 앞 카드를 세운다. **적용은 소유자의 사람 세션 REST 로만** 된다(`/agents/:id/permission-requests/:rid/approve`)
-- — 에이전트 토큰·PAT 로는 403 이다. 승인하면 `account_grant` 에 7일짜리 줄을 넣는다(D3):
--   kind=tool  → capability `tool.allow`, scope `tool:<channel_id>:<rule>` (요청한 채널에만 — D2)
--   kind=merge → capability `repo.merge`, scope `repo:<owner>/<name>`
-- 범위·기한은 이 줄과 서버 상수에서만 온다 — 승인 요청 본문은 읽지 않는다(merge_denial 의 C4 와 같다).
--
-- `expires_at` 은 이 **요청**에 답할 수 있는 시한이다(grant 의 기한이 아니다). 지나면 승인되지 않는다.
create table permission_request (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references account(id) on delete cascade,
  kind            text not null check (kind in ('tool', 'merge')),
  -- tool: 정규화한 규칙 원문 / merge: `repo:<owner>/<name>`
  target          text not null,
  reason          text not null,
  warnings        text[] not null default '{}',
  channel_id      uuid not null references channel(id) on delete cascade,
  thread_root_id  uuid not null,
  status          text not null default 'pending' check (status in ('pending', 'granted', 'denied')),
  card_message_id uuid references message(id) on delete set null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  decided_at      timestamptz,
  decided_by      uuid references account(id) on delete set null,
  grant_expires_at timestamptz
);

-- 같은 (에이전트, 종류, 대상, 스레드) 의 답 기다리는 요청은 하나 — 다시 요청하면 새 카드 대신 있던 카드를 가리킨다.
create index permission_request_pending on permission_request (agent_id, kind, target, thread_root_id) where status = 'pending';
-- 하루 상한을 셀 때.
create index permission_request_agent_created on permission_request (agent_id, created_at desc);
