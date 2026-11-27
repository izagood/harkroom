-- 깨움 행 임대 칸(EA). 깨움 표(181)에 「누가 언제까지 집었나」를 적을 자리를 만든다.
-- 이 마이그레이션은 칸만 더한다: 지금은 아무 경로도 이 칸을 쓰거나 읽지 않는다(동작 변화 없음). 턴의 원천을 깨움 행으로
-- 옮기는 뒤 단계가 쓴다.
--
-- - `claimed_by` 는 집은 쪽을 가리키는 짧은 글자(러너·오퍼레이터가 주는 식별자), `claimed_until` 은 그 임대의 끝.
--   둘은 같이 차거나 같이 빈다.
-- - 같은 PR 에서 inbox 줄을 넣는 자리들이 같은 트랜잭션에서 깨움 행도 쓰기 시작한다(스위치 `HARKROOM_WAKE_WRITE`, 기본 off).
--   그 쓰기는 `work_id` 를 채우므로 쓰기 역할에 `work` select 가 있어야 한다(이미 있는 권한이다 — 177).
-- - 쓰기 역할 GRANT: 새로 필요한 것 없음. `wake` select·insert·update 는 181 에서 이미 요구했고, 표 단위 권한이라 새 칸도 덮는다.
alter table wake add column if not exists claimed_by text check (claimed_by is null or length(claimed_by) between 1 and 128);
alter table wake add column if not exists claimed_until timestamptz;
alter table wake drop constraint if exists wake_claim_pair_check;
alter table wake add constraint wake_claim_pair_check check ((claimed_by is null) = (claimed_until is null));
create index if not exists wake_claim_idx on wake (account_id, claimed_until) where state = 'pending';
