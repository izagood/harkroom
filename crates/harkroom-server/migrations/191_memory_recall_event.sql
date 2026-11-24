-- 기억이 프롬프트에 실린 사건(턴·기억·계기·순위). 096 의 recall_count 는 누적 수뿐이라 어느 턴에 무엇이 몇 번째로 실렸는지 모른다.
--
-- - 러너가 성공한 턴 뒤 `memory.recalled` 에 턴 id 를 실어 보낼 때만 한 줄씩 적는다(옛 러너는 수만 센다).
-- - `trigger`: 실린 계기. 지금은 `turn_start` 하나다(발화 도구 때 싣기가 생기면 도구 이름이 온다).
-- - 본문·질의는 적지 않는다.
-- - 기억이 지워지면 사건도 같이 지워진다(FK cascade). 계정의 90일 지난 사건은 다음에 적을 때 지운다.
-- - 쓰기 역할 GRANT: `memory_recall_event` select·insert·delete. 없으면 사건만 안 적히고 나머지는 그대로 돈다.
create table if not exists memory_recall_event (
  account_id uuid not null,
  turn_id uuid not null,
  slug text not null,
  trigger text not null default 'turn_start' check (char_length(trigger) between 1 and 64),
  rank smallint not null check (rank between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (account_id, turn_id, trigger, slug),
  foreign key (account_id, slug) references agent_memory (account_id, slug) on delete cascade
);
create index if not exists memory_recall_event_slug_idx on memory_recall_event (account_id, slug);
create index if not exists memory_recall_event_created_idx on memory_recall_event (account_id, created_at);
