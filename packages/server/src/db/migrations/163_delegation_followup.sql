-- 위임 뒤 후속 보고(2026-11-06). 넘긴 일이 이미 닫힌 뒤 그 팀원이 `message.report` 를 올리면(감시 끝 등) 넘긴 쪽을 깨운다.
--
-- 멘션 게이트·회신권은 그대로 두고, 서버가 위임 행으로 판정해 넣는 사유를 따로 둔다. 러너가 프롬프트를 다르게 조립해야 하므로
-- 사유를 가른다(050 과 같은 규칙) — 팀원의 글을 「할 일」이 아니라 「결과」로 실어야 한다.
alter table inbox drop constraint inbox_reason_check;
alter table inbox add constraint inbox_reason_check
  check (reason in ('mention', 'thread_reply', 'dm', 'wake', 'ask_answered', 'ask_closed',
                    'team_mention', 'team_delegated', 'delegation_done', 'delegation_followup'));

-- 후속으로 깨운 횟수. 위임 행 안에서 세어 상한을 건다.
alter table team_delegation add column followups int not null default 0;
