-- 위임(mandate) W2 — 위임장의 줄(line). 줄 하나 = 능력(cap) 하나 + 범위(scope) + 한도(limits).
-- 아직 **그림자만**: 머지 판정은 바뀌지 않고, 위임 판정(`mandate.shadow`)만 이 줄로 계산한다.
-- 7일 grant(account_grant)는 여기에 복사하지 않는다 — 읽을 때 상시 줄(via standing)로 펼친다(H2).
-- agent_ids 가 null 이면 위임 안의 같은 소유자 에이전트 모두에 적용된다(H3).
-- 새 표라 옛 파드에 무해하다(expand).
create table if not exists mandate_line (
  id uuid primary key default gen_random_uuid(),
  mandate_id uuid not null references mandate(id) on delete cascade,
  cap text not null check (cap in ('merge', 'tool', 'command', 'bypass')),
  scope text not null,
  limits jsonb not null default '{}'::jsonb,
  agent_ids uuid[] null,
  granted_by uuid not null references account(id) on delete cascade,
  via text not null check (via in ('button', 'chat', 'mirror', 'standing', 'system')),
  request_id uuid null references permission_request(id) on delete set null,
  used_count int not null default 0,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null
);
create index if not exists mandate_line_live_idx on mandate_line (mandate_id) where revoked_at is null;
-- permission_request 삭제 때 `on delete set null` 이 훑지 않게.
create index if not exists mandate_line_request_idx on mandate_line (request_id) where request_id is not null;
