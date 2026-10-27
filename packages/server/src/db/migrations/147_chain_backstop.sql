-- 연쇄 한도 재설계 ③(2026-10-27): 백스톱 — 사람 뿌리 하나당 에이전트 홉 상한 또는 24시간, 먼저 닿는 쪽.
--
-- ① `message.chain_started_at` — 이 에이전트 글이 이어 받은 사슬이 사람 손길(사람 글·사람이 답한 카드)에서 시작한 시각.
--    사람 글 뒤 첫 홉은 그 사람 글의 시각, 그 뒤 홉은 앞 고리의 값을 그대로 물려받는다. 사람 글·사슬 밖 글은 null 이다.
--    옛 행은 null 이다 — 그 고리를 물려받는 다음 홉은 그 고리의 created_at 을 시작으로 친다(덜 막는 쪽).
-- ② 상한 설정(078)의 범위를 1~200 으로 넓힌다. 백스톱 값(100)이 들어갈 자리다. 지금 값은 바꾸지 않는다 — admin 이 설정에서 고친다.
alter table message add column chain_started_at timestamptz null;

alter table mention_policy drop constraint if exists mention_policy_chain_limit_check;
alter table mention_policy add constraint mention_policy_chain_limit_check check (chain_limit between 1 and 200);
