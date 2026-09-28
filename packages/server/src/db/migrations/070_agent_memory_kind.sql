-- 기억의 종류(메모리 고도화 PR4, 2026-09-28 jaebin 승인).
--
-- 2026-09-28 감사: murmur 메모리의 41%(52개·86k자)가 `mem/pr-*` — PR 하나의 경위 기록이었고,
-- 적고 나면 거의 다시 읽히지 않았다. 그런데 매 턴 목록에는 그 이름이 전부 실렸다.
-- - topic     : 주제별 사실·함정(기본값)
-- - procedure : 되풀이하는 절차(스킬 승격 후보)
-- - journal   : 한 작업의 경위. 목록에 싣지 않고 `memory.search` 로만 찾는다. 에이전트마다
--               최근 것 60개만 둔다(서비스가 넘치는 것부터 이전 판으로 옮기며 지운다).
alter table agent_memory add column kind text not null default 'topic';
alter table agent_memory add constraint agent_memory_kind check (kind in ('topic', 'procedure', 'journal'));

-- 이름으로 경위 기록임이 분명한 것만 journal 로 옮긴다. 나머지는 에이전트(정리 턴)가 고른다.
update agent_memory set kind = 'journal' where slug like 'mem/pr-%';
