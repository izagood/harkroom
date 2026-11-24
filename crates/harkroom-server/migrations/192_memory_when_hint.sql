-- 기억의 「언제」 문장 — 이 기억을 떠올려야 하는 때(예: "완료 보고를 올리기 직전"). 요약(description)은 무엇인지를, 이 칸은 때를 적는다.
-- 지금은 저장과 목록 표시까지다 — 이 칸을 보고 싣는 경로는 아직 없다(동작 변화 없음).
--
-- 쓰기 역할 GRANT: `agent_memory` 의 `when_hint` 칸 UPDATE. 없으면 `when` 을 준 memory.set 만 `when_unavailable` 로 거절되고 나머지는 그대로 돈다.
alter table agent_memory add column if not exists when_hint text check (char_length(when_hint) <= 200);
