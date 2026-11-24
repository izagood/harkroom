-- 조각 판정(PX5). 리더가 넘긴 조각(위임이 낳은 하위 작업 행)이 닫힌 뒤 리더가 내린 판정을 조각마다 한 줄로 적는다.
-- 이 마이그레이션은 표만 만든다: 판정 쓰기는 스위치(기본 꺼짐) 뒤에 있고 아직 어떤 운영 경로도 부르지 않는다(동작 변화 없음).
--
-- - 서버는 품질을 보지 않는다 — 누가·언제·무엇으로 판정했는지와 횟수만 적는다.
-- - `verdict`: `accept`(수락)·`retry`(같은 조건으로 다시, 조각당 1번)·`promote`(더 비싼 조합으로 새 조각)·`discard`(버림).
-- - `retry_count` 는 이 조각에 내린 재시도 판정 수다(상한 1 — check 가 막는다).
-- - `retry_work_id` 는 재시도로 새로 띄운 조각, `promoted_from_work_id` 는 승격의 원본 조각이다. 그 작업이 지워지면 칸만 빈다.
-- - `needs_review` 는 사람이 봐야 한다는 표시다(지금은 아무도 켜지 않는다).
-- - 작업이 지워지면 판정도 같이 지워진다.
-- - 쓰기 역할 GRANT: `work_verdict` select·insert·update, `work` select, `team_delegation` select.
create table if not exists work_verdict (
  work_id uuid primary key references work(id) on delete cascade,
  verdict text not null check (verdict in ('accept', 'retry', 'promote', 'discard')),
  decided_by_account_id uuid references account(id) on delete set null,
  decided_by_work_id uuid references work(id) on delete set null,
  decided_at timestamptz not null default now(),
  retry_count integer not null default 0 check (retry_count between 0 and 1),
  retry_work_id uuid references work(id) on delete set null,
  promoted_from_work_id uuid references work(id) on delete set null,
  needs_review boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists work_verdict_decided_by_idx on work_verdict (decided_by_account_id) where decided_by_account_id is not null;
create index if not exists work_verdict_decided_by_work_idx on work_verdict (decided_by_work_id) where decided_by_work_id is not null;
create index if not exists work_verdict_retry_work_idx on work_verdict (retry_work_id) where retry_work_id is not null;
create index if not exists work_verdict_promoted_from_idx on work_verdict (promoted_from_work_id) where promoted_from_work_id is not null;
