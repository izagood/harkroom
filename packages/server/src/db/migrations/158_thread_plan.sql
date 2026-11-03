-- 스레드 계획판(Thread Plan) P1 — 스레드마다 하나인 **공개** 계획 문서(설계 K1·K2·K5).
--
-- thread_note(128)와 다른 자리다: 메모는 (에이전트, 스레드)마다 한 장이고 본인만 읽는다. 계획은 스레드에 하나이고
-- 채널을 볼 수 있는 누구나 본다. 그래서 키가 스레드 루트 하나다.
-- - doc: shared `PlanDoc`(goal·groups·steps·next·blocked). 검증(`validatePlan`)은 서비스가 쓰기 전에 한다 —
--   SQL 검사는 크기 하나만 둔다(상한을 두 곳에 적으면 갈라진다).
-- - rev: 쓸 때마다 1씩 오른다. 화면·이벤트가 「몇 번째 판」을 견주는 값이다.
-- - flag_reason: 쓰기 검사(080)에 걸린 판. 화면에는 보이되 러너는 싣지 않는다(thread_note 와 같은 규칙).
create table thread_plan (
  -- 채널 삭제(#155)는 message 를 실제로 지운다 — 계획이 그것을 막으면 안 된다(128 과 같이 cascade).
  root_id uuid primary key references message(id) on delete cascade,
  channel_id uuid not null references channel(id) on delete cascade,
  doc jsonb not null check (octet_length(doc::text) <= 65536),
  rev integer not null default 1 check (rev >= 1),
  flag_reason text null,
  updated_by uuid null references account(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index thread_plan_channel on thread_plan (channel_id);
create index thread_plan_updated_by on thread_plan (updated_by);

-- 연결 그룹(`linkedRootId`)의 역참조. 자식 스레드의 계획이 바뀌면 그것을 가리키는 부모를 찾는 데 쓴다(2차 구독기).
-- 정본은 doc 이고 이 표는 쓸 때 doc 에서 다시 만든다.
create table thread_plan_link (
  parent_root uuid not null references thread_plan(root_id) on delete cascade,
  child_root uuid not null references message(id) on delete cascade,
  primary key (parent_root, child_root),
  check (parent_root <> child_root)
);
-- message 를 가리키는 외래키는 앞자리 색인이 있어야 한다(123, messageFkIndexes.test).
create index thread_plan_link_child on thread_plan_link (child_root);
