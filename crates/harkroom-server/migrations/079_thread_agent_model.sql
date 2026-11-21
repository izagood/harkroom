-- 스레드별 모델 지정 — "이 스레드에서는 이 에이전트를 이 모델로" (2026-10-01, jaebin 승인 결정 1~13).
--
-- 지금까지 모델은 에이전트 하나에 하나였다(`agent_config.model`·`effort`). 같은 에이전트에게
-- 고도화 작업만 더 고급 모델로 시키려면 설정을 바꿨다 되돌려야 했고, 그 사이 다른 스레드의
-- 턴도 함께 비싸졌다. 그래서 값을 **스레드 × 에이전트** 에 둔다(결정 2) — 스레드 안에서 부른
-- 다른 에이전트는 물려받지 않는다(결정 8: 모델 이름은 하네스마다 달라 옮겨 줄 수 없다).
--
-- **`harness` 를 함께 적는다**(결정 9). 에이전트의 하네스가 나중에 바뀌면 이 값은 새 하네스가
-- 모르는 이름이 된다. 행을 지우지 않고 남겨 두되, 읽는 쪽이 지금 하네스와 견주어 무효로
-- 판정한다 — 지우면 사람은 지정이 왜 사라졌는지 모르고, 하네스를 되돌리면 값이 되살아나야 한다.
--
-- 기한은 없다(결정 9). 스레드가 지워지면 함께 지워진다.
create table thread_agent_model (
  thread_root_id uuid not null references message(id) on delete cascade,
  agent_id uuid not null references account(id) on delete cascade,
  harness text not null,
  -- null 이면 그 축은 에이전트 설정을 따른다. 둘 다 null 인 행은 만들지 않는다(그것은 "지정 없음"이다).
  model text,
  effort text,
  set_by uuid references account(id) on delete set null,
  set_at timestamptz not null default now(),
  primary key (thread_root_id, agent_id),
  check (model is not null or effort is not null)
);
