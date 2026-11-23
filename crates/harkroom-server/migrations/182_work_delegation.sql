-- 위임 = 하위 작업 행(D1, 그림자). 위임 의무(`team_delegation_item`) 하나마다 `work` 하위 행 하나를 나란히 적는다.
-- 이 마이그레이션은 칸과 인덱스만 더한다: 위임의 정본은 여전히 `team_delegation`·`team_delegation_item` 이고,
-- 작업 행은 커밋 뒤 요청 밖에서 따라 적는 그림자다(동작 변화 없음).
--
-- - `delegation_id` 는 그 작업을 낳은 위임이다. 위임이 지워지면 이 칸만 빈다(작업 이력은 남는다).
-- - (위임, 담당)마다 작업은 하나다 — 부분 유일 인덱스가 되풀이 기록을 막는다(`on conflict do nothing`).
-- - 쓰기 역할 GRANT: 177 의 `work`·`work_event`·`work_event_id_seq` 그대로(새 칸은 표 권한에 든다) +
--   `team_delegation` select, `team_delegation_item` select.
alter table work add column if not exists delegation_id uuid references team_delegation(id) on delete set null;

create unique index if not exists work_delegation_assignee_uidx
  on work (delegation_id, assignee_account_id) where delegation_id is not null;
