-- 스레드×에이전트 모델 지정에 「실행 조합」을 적는다(J2b).
--
-- - `agent.call` 의 `agentModels[].comboId` 로 고른 조합을 `thread_agent_model.combo_id` 에 남긴다. 그 줄의 model·effort 는
--   고른 때 조합에서 베낀 값이다(러너는 지금처럼 model·effort 만 읽는다 — 이 칸을 읽어 자격을 고르는 길은 아직 없다).
-- - 조합이 지워지면 그 조합으로 정한 지정도 같이 지운다(cascade) — 지워진 조합의 모델이 스레드에 남지 않는다.
-- - 사람이 정한 줄·모델만 고른 줄은 null 이다.
-- - 쓰기 역할은 이 표에 이미 표 단위 select·insert·update·delete 가 있다(079·087) — 새 GRANT 는 없다.
alter table thread_agent_model
  add column if not exists combo_id uuid references exec_combo(id) on delete cascade;
create index if not exists thread_agent_model_combo_idx on thread_agent_model (combo_id) where combo_id is not null;
