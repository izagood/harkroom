-- 계획판 자동 진행. doc 이 아니라 열에 둔다 — 에이전트가 doc 쓰기로 켜지 못하게.
-- 켜기는 사람 글을 근거로만 된다(`services/threadPlanAuto.ts`).
alter table thread_plan
  add column auto_until text,
  add column auto_source uuid references message(id) on delete set null,
  add column auto_by uuid references account(id) on delete set null,
  add column auto_mandate uuid references mandate(id) on delete set null,
  add column auto_at timestamptz,
  -- 단계마다 한 번만 깨운다(단계 id → 판 updatedAt). 깨우기는 다음 PR.
  add column auto_woken jsonb not null default '{}'::jsonb,
  -- 근거로 쓴 글. 같은 글로 두 번 켜지 못한다. 끈 뒤에도 남는다.
  add column auto_used_sources uuid[] not null default '{}';
