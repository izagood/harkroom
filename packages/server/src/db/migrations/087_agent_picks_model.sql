-- 에이전트가 다른 에이전트를 부르며 그 스레드의 모델을 고른다(2026-10-01, jaebin 승인 결정 1~9).
--
-- 결정 3·9·11: 대상 에이전트의 **소유자**가 "다른 에이전트가 나를 부를 때 고를 수 있는 (모델·effort)"을
-- 켠다. 비어 있으면(기본) 에이전트는 그 대상의 모델을 고르지 못한다 — opt-in 이다.
-- 모양: `[{ "model": "opus", "efforts": ["medium", "high"] }]`. `model` 은 하네스가 받는 id(`--model` 에
-- 그대로 가는 값). `efforts` 가 비면 effort 는 고르지 못한다(에이전트 설정 effort 그대로). effort 를 따로
-- 묶는 이유(결정 11): 모델만 묶으면 기본 모델 그대로 effort 만 max 로 올려 비용 상한을 비켜 간다 —
-- 하네스 목록(`checkOffered`)은 비용을 묻지 않고, 오퍼레이터가 오프라인이면 아무것도 거르지 않는다.
alter table agent_config add column agent_pickable_models jsonb not null default '[]'::jsonb;

-- 결정 4·8: 누가 정한 지정인가. 사람이 정한 행은 에이전트가 덮지도 풀지도 못한다. 에이전트가 정한
-- 행은 사람이 언제든, 에이전트는 같은 규칙으로 덮거나 풀 수 있다. 계정 kind 로 되짚지 않는 이유:
-- 정한 계정이 지워지면(`set_by` 는 on delete set null) 판정이 흔들린다.
alter table thread_agent_model add column set_by_kind text not null default 'human'
  check (set_by_kind in ('human', 'agent'));

-- 결정 5: 한 스레드에서 에이전트가 지정을 바꾼 횟수(대상 합계). 상한을 넘으면 사람이 봐야 한다.
-- 지정 행과 따로 두는 이유: 에이전트가 풀면 행이 사라지는데, 횟수까지 사라지면 풀고 다시 정하기로
-- 상한을 돌 수 있다.
create table thread_agent_pick_count (
  thread_root_id uuid primary key references message(id) on delete cascade,
  n int not null default 0
);
