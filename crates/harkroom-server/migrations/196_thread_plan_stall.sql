-- 계획판의 단계별 조용함 시계 — `active` 단계가 언제부터 신호 없이 있었는지를 계획 진행 루프(`loops::plan_progress`)가 적는다.
-- 모양: `{"seenAt": 초, "lastWokenAt": 초?, "steps": {"<단계 id>": {"quietAt": 초, "wokenAt": 초?}}}`(초는 epoch).
-- 계획 문서(`doc`)·`rev`·`updated_at` 과 따로 움직인다 — 이 칸을 고쳐도 판은 바뀐 것이 아니다.
-- 스위치(`HARKROOM_PLAN_STALL`, 기본 꺼짐)가 꺼져 있으면 아무도 읽거나 쓰지 않는다(동작 변화 없음).
--
-- 쓰기 역할 GRANT: `thread_plan` 의 `stall` 칸 SELECT·UPDATE. 없으면 멈춤 판정만 빠지고 나머지는 그대로 돈다.
-- 읽기 역할: `thread_plan` SELECT 가 표 단위면 더 줄 것이 없다(칸 단위면 `stall` 칸 SELECT).
alter table thread_plan add column if not exists stall jsonb not null default '{}'::jsonb;
