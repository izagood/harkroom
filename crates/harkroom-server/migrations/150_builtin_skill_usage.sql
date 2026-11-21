-- 내장 스킬 사용 기록(2026-10-27, 내장 스킬 S의 P2).
--
-- 러너가 코드와 같은 판으로 싣는 내장 스킬(`harkroom-*`)은 `workspace_skill` 행이 없다. 그런데
-- `workspace_skill_usage.slug` 는 그 표를 FK 로 가리켜서 내장 스킬의 사용을 남길 수 없었다(081 은 모르는 slug 를
-- 조용히 버린다). FK 를 풀면 워크스페이스 스킬을 지웠다 같은 이름으로 다시 만들 때 옛 기록이 되살아나므로, 내장 스킬은
-- 따로 둔다. 행 하나 = 한 에이전트가 한 턴에 그 내장 스킬을 불렀다는 사실(081 과 같은 뜻).
create table builtin_skill_usage (
  id bigserial primary key,
  slug text not null,
  account_id uuid not null references account(id) on delete cascade,
  used_at timestamptz not null default now()
);

create index builtin_skill_usage_slug_idx on builtin_skill_usage (slug, used_at desc);
