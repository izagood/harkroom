-- migrate: no-transaction
--
-- 인박스 「오늘」(C안, P1 서버) — 마지막으로 본 시각(S1)과 「끝난 것」 조회(S3)의 색인.
--
-- `inbox_view_cursor`: 계정마다 한 줄. `seen_at` 은 `PUT /inbox/today/seen` 이 `greatest()` 로만 올린다 —
-- 기기 둘이 서로 되감지 않는다. 키가 계정 하나라 남의 줄을 건드릴 길이 없다.
--
-- `thread_status (status, updated_at)`: 「끝난 것」 이 `status = 'done' and updated_at > since` 를 묻고, 버전 태그가
-- 상태별 `max(updated_at)` 을 묻는다. 지금 색인은 root_id(pk)·account_id 뿐이라 둘 다 thread_status 전체를 훑는다.
-- 이미 있는 표라 트랜잭션 밖에서 `concurrently` 로 만든다(120 과 같은 꼴). 앞서 실패해 INVALID 로 남은 것을 먼저 걷는다.
create table if not exists inbox_view_cursor (
  account_id uuid primary key references account(id) on delete cascade,
  seen_at timestamptz not null,
  updated_at timestamptz not null default now()
);
drop index concurrently if exists thread_status_status_updated_idx;
create index concurrently if not exists thread_status_status_updated_idx on thread_status (status, updated_at);
