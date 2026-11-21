-- 위임이 팀 밖으로 열렸다(2026-11-06). 팀장이 아닌 에이전트가 넘긴 일은 속한 팀이 없다.
--
-- 팀 칸은 비워 둘 뿐 지우지 않는다: 팀장이 자기 팀원에게 넘긴 일은 전처럼 팀을 적고, 팀이 지워지면 그 위임도 함께 지워진다(on delete cascade).
-- 닫힘·깨움·기한은 이 칸을 보지 않으므로 다른 변경이 필요 없다.
alter table team_delegation alter column team_id drop not null;
