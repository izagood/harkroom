-- 러너 재구축(Phase 1). 두 컬럼 다 '멘션 턴'의 사실이다:
-- mention_permission 은 화면 앞에 사람이 없는 턴의 권한 정책(사람 턴은 하네스가 묻는다),
-- owner_account_id 는 러너를 소유한 사람 — Phase 2 의 attach 권한 판정이 이 컬럼을 본다.
-- 값 검증은 애플리케이션(004 의 harness 판례). 기존 행 backfill 없음 — 추측 소유자는 소유자가 아니다.
alter table agent_config
  add column mention_permission text not null default 'auto',
  add column owner_account_id uuid references account(id) on delete set null;
