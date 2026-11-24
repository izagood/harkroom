-- contract: v0.5.42(O2-a)부터 서버가 이 칸 둘과 표 하나를 읽지도 쓰지도 않는다.
--
-- 사슬 깊이 정리(O2-b). 홉 수·사슬 나이로 에이전트 부름을 막던 검사를 걷은 뒤(O1) 남은 자리를 지운다.
--
-- - `message.mention_depth`(043) — 사람이 마지막으로 말한 뒤 건넌 에이전트 홉 수.
-- - `message.stall_depth`(146) — 새 결과물 없이 이어진 홉 수.
-- - `mention_policy`(078·147) — 홉 상한 설정 한 줄짜리 표.
--
-- 남기는 것: `message.chain_started_at`(147)·`automation_run.chain_depth`. 이번에 지우지 않는다.
--
-- 되돌릴 수 없다 — 값은 따로 떠 두지 않는다. 이 마이그레이션이 적용된 DB 에는 O2-a 보다 앞선 서버 판을 붙일 수 없다
-- (옛 판은 글을 쓸 때 이 칸에 값을 넣는다). 판올림은 O2-a 가 든 판을 먼저 거친 뒤에 한다.
--
-- 칸 삭제는 카탈로그만 고친다(표를 다시 쓰지 않는다). `if exists` 라 다시 돌려도 같다.
-- 쓰기 역할 GRANT: 새로 줄 것 없음. 목록에 `mention_policy` 줄이 있으면 뺀다(표가 없으면 그 줄이 실패한다).
alter table message
  drop column if exists mention_depth,
  drop column if exists stall_depth;

drop table if exists mention_policy;
