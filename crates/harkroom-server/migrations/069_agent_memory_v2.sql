-- 에이전트 메모리 2단계(메모리 고도화 PR3, 2026-09-28 jaebin 승인).
--
-- 011 은 (account_id, slug, value, updated_at) 넷뿐이었다. 2026-09-28 감사에서 드러난 것:
-- - 목록에 이름만 실려 무슨 내용인지 몰라 `memory.get` 이 거의 안 불렸다(431세션 중 6.7%).
--   → description: 목록에 같이 싣는 한 줄 요약.
-- - 무엇이 쓰이고 무엇이 안 쓰이는지 근거가 없어 정리를 못 했다(132개 중 23%만 읽혔다).
--   → created_at · read_count · last_read_at.
-- - 덮어쓰기라 잘못 고친 것을 되돌릴 수 없었다. 정기 정리가 병합·삭제를 하려면 되돌릴 길이
--   먼저 있어야 한다. → agent_memory_revision.
alter table agent_memory
  add column description text,
  add column created_at timestamptz,
  add column read_count integer not null default 0,
  add column last_read_at timestamptz;

-- 있던 행의 생성 시각은 모른다 — 알 수 있는 가장 이른 값(마지막 수정)으로 채운다.
update agent_memory set created_at = updated_at where created_at is null;
alter table agent_memory alter column created_at set default now();
alter table agent_memory alter column created_at set not null;

alter table agent_memory add constraint agent_memory_description_length
  check (description is null or char_length(description) <= 200);

-- 바뀌기 **전** 본문을 남긴다(수정·삭제 모두). slug 마다 최근 몇 개만 둔다 — 서비스가 자른다.
create table agent_memory_revision (
  id bigserial primary key,
  account_id uuid not null references account(id) on delete cascade,
  slug text not null,
  value text not null,
  description text,
  -- 이 판이 유효하던 마지막 시각(= 원래 행의 updated_at)과 밀려난 시각.
  updated_at timestamptz not null,
  replaced_at timestamptz not null default now()
);
create index agent_memory_revision_slug on agent_memory_revision (account_id, slug, replaced_at desc);
