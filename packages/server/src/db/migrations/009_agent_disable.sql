-- 에이전트 비활성화 기능: account 에 disabled_at 컬럼 추가
alter table account add column disabled_at timestamptz;