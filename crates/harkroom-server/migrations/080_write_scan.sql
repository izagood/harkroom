-- 에이전트 쓰기 검사(2026-10-01, Hermes 자기 개선 검토 D4 — jaebin "추천대로").
--
-- 기억(core 는 매 턴 시스템 프롬프트로)과 스킬(승인되면 모든 에이전트에게)은 에이전트가 쓴 글이
-- 그대로 다른 턴의 지시가 되는 자리다. 스레드에 섞인 남의 글·Slack 글이 기억으로 옮겨지면 그
-- 글이 프롬프트가 된다. 그래서 에이전트의 `memory.set`·`skill.propose` 를 검사한다
-- (`services/contentScan.ts`).
--
-- 걸려도 **거절하지 않는다** — 오탐이면 정상 기억이 사라진다. 저장하고 표시하고, 사람이
-- 확인할 때까지 프롬프트에 싣지 않는다:
-- - flagged_at · flag_reason: 걸린 판. 사람이 확인하거나(route) 깨끗한 판으로 다시 쓰면 비운다.
-- - agent_memory_revision.flagged: 이전 판이 걸린 판이었나. 걸린 기억을 읽을 때 "걸리기 전
--   마지막 판"을 돌려주는 데 쓴다(core 가 걸려도 러너는 그 전 판을 싣는다).
alter table agent_memory
  add column flagged_at timestamptz,
  add column flag_reason text;

alter table agent_memory_revision
  add column flagged boolean not null default false;

alter table workspace_skill
  add column flagged_at timestamptz,
  add column flag_reason text;
