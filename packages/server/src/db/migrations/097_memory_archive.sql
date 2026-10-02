-- 기억 보관(archive)·판 이유·정리 임대(메모리 자동 요약·압축 C1, 2026-10-02 jaebin "추천대로",
-- 설계 harkroom://message/5e177fd9-b118-4f41-acee-2bd97ae72971).
--
-- 200 상한에 닿은 에이전트가 할 수 있는 일이 "지우기"뿐이었다. 지우면 되돌릴 길이 이전 판 5개뿐이고,
-- 지우기 전에 읽어 판단해야 하니 상한 근처의 정리는 늘 미뤄졌다(harkroom 200/200 실측).
-- - archived_at: 보관된 기억. 목록(`<memory-index>`)·recall·검색·200 상한 계산에서 빠지되 `memory.get`·
--   사람 화면에서는 보이고 `memory.unarchive` 한 번으로 돌아온다. 삭제보다 보관이 기본 권고다.
-- - agent_memory_revision.reason · detail: 어떤 일로 밀려난 판인가(merge·restore). 압축·되돌리기로 생긴
--   판은 "최근 5판" 계산에서 따로 센다(서비스 `pruneRevisions`) — 정리 한 바퀴가 되돌릴 판을 밀어내면
--   안 된다. detail 은 merge 의 `{from: [...]}` 처럼 되돌리기·측정(gold 재매핑)에 쓰는 사실이다.
-- - memory_lease: 정리 턴은 계정당 하나다. 주간 automation 과 경고를 본 턴이 같은 계정을 동시에 정리하면
--   한쪽의 merge 가 다른 쪽의 ifUpdatedAt 을 계속 깨뜨린다. 임대는 사실만 적고 강제하지 않는다 —
--   `memory.lease` 가 "다른 턴이 정리 중"이라고 알려 주면 에이전트가 물러난다.
alter table agent_memory add column archived_at timestamptz;
create index agent_memory_active on agent_memory (account_id) where archived_at is null;

alter table agent_memory_revision
  add column reason text,
  add column detail jsonb;
alter table agent_memory_revision add constraint agent_memory_revision_reason
  check (reason is null or reason in ('merge', 'restore'));

create table memory_lease (
  account_id uuid primary key references account(id) on delete cascade,
  holder text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);
