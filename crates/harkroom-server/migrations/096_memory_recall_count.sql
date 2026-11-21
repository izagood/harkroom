-- 러너 자동 주입(recall)으로 실린 횟수·마지막 시각(메모리 S2 F1, Fable 검토 harkroom://message/4de3e802-4042-415c-a719-53c5e1e1b16d).
--
-- read_count(069)는 `memory.get` 만 센다. 그런데 기억이 실제로 쓰이는 길의 대부분은 러너가 턴
-- 프롬프트에 본문을 붙여 주는 recall 이다 — 그래서 recall 로 잘 실리던 기억이 `memory.audit` 에서
-- "한 번도 안 읽힘·오래 안 읽힘" 정리 후보로 올랐다. 두 길을 섞지 않고 따로 센다: 에이전트가 직접
-- 연 것(read)과 러너가 골라 실은 것(recall)은 다른 신호다. audit 은 둘 중 하나라도 있으면 쓰인 것으로 본다.
--
-- updated_at 은 건드리지 않는다(readMemoryCounted 와 같은 이유 — 판본 memoryRev 가 바뀌면 러너 캐시가 깨진다).
alter table agent_memory
  add column recall_count integer not null default 0,
  add column last_recalled_at timestamptz;
