-- 백그라운드 턴 G1 · BG1 서버 틀(설계 harkroom://message/4a44f18a, jaebin 카드 9a965f55).
--
-- 사람에게 보이는 앵커 없이, 채팅에 글도 쓰지 않는 에이전트 턴(증류·정리)의 일감 표.
-- - 서버 sweep 만 넣는다(사람·에이전트는 못 연다). 러너가 `bg.claim` 으로 집고 `bg.complete` 로 끝낸다.
-- - (에이전트, 종류, KST 날짜) 유일 → 하루 1회. 서버 전체 하루 상한은 env(HARKROOM_BACKGROUND_DAILY_MAX).
-- - 행 하나가 곧 Memory 탭 히스토리 한 줄이다(BG4). 채팅에는 아무것도 쓰지 않는다.
create table bg_job (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id) on delete cascade,
  kind text not null check (kind in ('distill', 'cleanup')),
  day date not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'skipped')),
  -- 입력(읽을 스레드 id 등). 서버 허용 목록이 message.read·thread.note 를 이 스레드로만 묶는다.
  input jsonb not null default '{}'::jsonb,
  summary text null check (summary is null or char_length(summary) <= 500),
  error text null check (error is null or char_length(error) <= 200),
  -- 회차당 기억 쓰기(set·archive·merge) 수. 상한 20 은 서버가 원자적으로 센다.
  writes int not null default 0,
  tokens int null,
  duration_ms int null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz null,
  finished_at timestamptz null,
  unique (account_id, kind, day)
);
create index bg_job_claim on bg_job (account_id, created_at) where status = 'queued';
create index bg_job_running on bg_job (claimed_at) where status = 'running';

-- 회차가 바꾼 기억. 새로 만든 것은 이전 판(revision)이 없으므로 여기 따로 남긴다 — 「이 회차 되돌리기」(BG4)의 재료.
create table bg_job_change (
  id bigserial primary key,
  run_id uuid not null references bg_job(id) on delete cascade,
  slug text not null,
  op text not null check (op in ('create', 'update', 'archive', 'merge')),
  after_updated_at timestamptz null,
  created_at timestamptz not null default now()
);
create index bg_job_change_run on bg_job_change (run_id);

-- 이전 판을 밀어낸 쓰기가 어느 회차·어느 턴이었나(일반 턴도 turn_id 를 남긴다).
alter table agent_memory_revision add column run_id uuid null references bg_job(id) on delete set null;
alter table agent_memory_revision add column turn_id uuid null;
create index agent_memory_revision_run on agent_memory_revision (run_id) where run_id is not null;
