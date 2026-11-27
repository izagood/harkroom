-- 위임 다시 부르기(DA) — 담당 턴이 보고·실패·기다림 없이 끝났을 때 서버가 담당을 다시 부른 횟수와 시각.
-- - recall_count: 다시 부른 횟수. 상한(`core::delegation_recall::RECALL_MAX`)에 닿은 뒤 또 말없이 끝나면 막힘으로 표시한다.
-- - recalled_at: 마지막으로 다시 부른 시각.
-- - recall_blocked_at: 다시 불러도 결말이 없어 막힘으로 표시하고 위임자를 깨운 시각. 위임은 닫지 않는다(`outcome` 그대로).
-- 스위치(`HARKROOM_DELEGATION_RECALL`, 기본 off)가 꺼져 있으면 아무도 읽거나 쓰지 않는다(동작 변화 없음).
--
-- 쓰기 역할 GRANT(스위치 `on` 에만 필요): `team_delegation_item` 의 `recall_count`·`recalled_at`·`recall_blocked_at` 칸 UPDATE,
-- `agent_wake` INSERT. `shadow` 는 읽기뿐이다(`team_delegation_item` SELECT 가 표 단위면 더 줄 것이 없다).
-- 없으면 다시 부르기만 빠지고 나머지는 그대로 돈다.
alter table team_delegation_item add column if not exists recall_count integer not null default 0;
alter table team_delegation_item add column if not exists recalled_at timestamptz;
alter table team_delegation_item add column if not exists recall_blocked_at timestamptz;
