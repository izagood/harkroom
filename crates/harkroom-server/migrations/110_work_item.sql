-- 작업 항목(협업 통합 설계 ①, 2026-10-06 jaebin 승인 — 「내 작업」 S3 자리).
--
-- 한 사람의 보드에 서는 **밖의 일**이다: GitHub PR·Jira 티켓·Slack 스레드, 그리고 avcs intent.
-- 키가 (owner, source, external_key)인 이유: 같은 바깥 일을 다시 올리면 고쳐 쓰는 것이 곧 멱등이다.
--
-- 왜 task_link 를 따로 두지 않는가: avcs intent 를 스레드에 잇는 것도 "바깥 일 하나를 내 보드의
-- 스레드에 붙인다"와 같은 모양이다. 표를 둘 두면 보드가 두 곳을 합쳐 읽어야 한다.
--
-- avcs 만 다른 두 가지(check 로 지킨다):
-- * state 는 null 이다 — intent 상태의 정본은 avcs 서버의 /reduced 다. 손으로 밀면 정본이 둘이 된다
--   (보드에 합류시키는 것은 ② 의 일이다).
-- * thread_root_id 가 필수다 — 보드에서 별도 카드가 아니라 그 스레드 카드의 코드 칩으로 선다.
--
-- thread_root_id 가 cascade 인 이유: 스레드가 지워지면 거기 붙인 항목도 뜻을 잃는다. set null 이면
-- avcs 행이 위 check 에 걸려 지우기가 실패한다.
create table work_item (
  id uuid primary key default gen_random_uuid(),
  owner_account_id uuid not null references account(id) on delete cascade,
  source text not null check (source in ('github', 'jira', 'slack', 'other', 'avcs')),
  external_key text not null check (char_length(external_key) between 1 and 300),
  url text null check (url is null or (url ~ '^https://' and char_length(url) <= 2000)),
  title text not null check (char_length(title) between 1 and 200),
  state text null check (state in ('mine', 'blocked', 'active', 'done')),
  thread_root_id uuid null references message(id) on delete cascade,
  updated_by uuid null references account(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_account_id, source, external_key),
  check ((source = 'avcs') = (state is null)),
  check (source <> 'avcs' or thread_root_id is not null)
);

create index work_item_owner_updated on work_item (owner_account_id, updated_at desc);
create index work_item_thread on work_item (thread_root_id) where thread_root_id is not null;
