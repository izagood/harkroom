-- 머지 거절 기록 — 거절 카드의 [7일 주기](스레드 febe9ff8 P3, security C1~C6).
--
-- 래퍼의 `POST /agent/merge-checks` 가 `not_granted` 로 거절하고 **나머지 판정은 통과했을 때만**(임대가 맞고 저장소 이름이
-- 맞고 그 턴을 띄운 것이 사람 — C2) 한 줄을 남긴다. 그 id(`denialId`)를 에이전트가 `message.ask` 의 `mergeDenialId` 로
-- 실으면 서버가 이 줄의 값으로 카드의 권한 칸을 채운다(C1·C3). 소유자 사람 세션이 `POST /agents/:id/merge-denials/:id/grant`
-- 로 이 줄을 **한 번** 써서 7일짜리 grant 를 만든다(C4·C5). scope 와 기한은 요청 본문에서 받지 않는다 — 이 줄과 서버 상수다.
--
-- `expires_at` 은 이 거절 기록을 쓸 수 있는 시한이다(grant 의 기한이 아니다). 카드가 하루 한 장이라 하루로 둔다.
create table merge_denial (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references account(id) on delete cascade,
  scope           text not null,
  pr_number       integer not null,
  head_sha        text not null,
  channel_id      uuid not null,
  thread_root_id  uuid not null,
  lease_id        uuid not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  card_message_id uuid references message(id) on delete set null,
  used_at         timestamptz,
  used_by         uuid references account(id) on delete set null
);

create index merge_denial_agent_scope_thread on merge_denial (agent_id, scope, thread_root_id, created_at desc);
