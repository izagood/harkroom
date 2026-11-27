-- 팀을 지워도 위임 기록은 남는다.
--
-- `team_delegation.team_id` 는 050 에서 `on delete cascade` 로 생겼다 — 팀을 지우면 그 팀 이름으로 넘겼던 위임 행(과 그 항목)이
-- 함께 지워졌다. 팀 명단으로 넘기던 길은 걷혔고 새 위임은 이 칸을 비운다. 남은 옛 행은 기록이므로, 팀이 지워지면 칸만 비운다
-- (`inbox.team_id` 가 047 부터 그런 것과 같다).
--
-- 제약 이름은 050 의 기본 이름이다. 다른 이름으로 선 DB 를 위해 이 칸의 `agent_team` FK 를 찾아 모두 떼고 다시 단다.
do $$
declare c text;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'team_delegation'::regclass
       and con.confrelid = 'agent_team'::regclass
       and con.contype = 'f'
       and att.attname = 'team_id'
  loop
    execute format('alter table team_delegation drop constraint %I', c);
  end loop;
end $$;

alter table team_delegation
  add constraint team_delegation_team_id_fkey
  foreign key (team_id) references agent_team(id) on delete set null;
