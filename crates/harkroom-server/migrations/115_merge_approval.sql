-- 머지 1회 승인(스레드 1b75d7a0, jaebin 결정 #task 3a506eb4 — "사람의 명시 승인이 마지막 말").
--
-- 거절 카드(`merge_denial`)에서 소유자가 **이 PR 하나를 이 head 로, 이 gh 계정으로 한 번** 머지해도 된다고 승인한 기록이다.
-- grant(7일)와 달리 저장소 권한을 주지 않는다 — (에이전트, 저장소, PR, head, 채널, 스레드)에 묶인 한 번짜리다.
-- `checkMerge` 는 이 기록이 있으면 grant·사람 턴(F3·F4) 판정 대신 이것을 인정한다. F1 임대·F2 저장소 모양은 그대로 본다.
--
-- - 승인은 소유자 사람 **세션** REST 로만 만든다(ask 선택지·거울 카드·에이전트·오퍼레이터 토큰 불가 — 라우트가 막는다).
-- - `gh_user`: 래퍼가 머지에 쓸 gh 계정. 래퍼는 이 계정만 쓴다(fallback 없음).
-- - `relax_checks`: 래퍼의 harkroom 쪽 CI·CLEAN 판정을 GitHub 판정에 맡긴다. 래퍼 인자가 아니라 이 칸으로만 켠다.
-- - `used_at`: 1회 소모 — `used_at is null` 을 조건으로 단 한 문장 update 로만 쓴다.
alter table merge_denial add column reason text not null default 'not_granted'
  check (reason in ('not_granted', 'cause_not_human'));

create table merge_approval (
  id              uuid primary key default gen_random_uuid(),
  denial_id       uuid not null unique references merge_denial(id) on delete cascade,
  agent_id        uuid not null references account(id) on delete cascade,
  scope           text not null,
  pr_number       integer not null,
  head_sha        text not null,
  gh_user         text not null,
  relax_checks    boolean not null default false,
  channel_id      uuid not null,
  thread_root_id  uuid not null,
  approved_by     uuid not null references account(id) on delete cascade,
  approved_at     timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz,
  used_lease_id   uuid
);

create index merge_approval_open on merge_approval (agent_id, thread_root_id) where used_at is null;

-- 1회 승인은 권한 요청 카드(`permission_request`, kind=merge)의 결정 하나로 받는다 — 머지 거절 카드(`message.ask` 의
-- `mergeDenialId`)는 이미 권한 요청 카드로 선다. 그 요청이 어느 거절 기록에서 왔는지 묶어 두어야 PR·head 를 기록에서 가져온다.
alter table permission_request add column denial_id uuid references merge_denial(id) on delete set null;
alter table permission_request drop constraint permission_request_status_check;
alter table permission_request add constraint permission_request_status_check
  check (status in ('pending', 'granted', 'denied', 'approved_once'));
