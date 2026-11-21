-- 연쇄 한도 재설계 ②(2026-10-27): 정체 홉 — 새 결과물(sha·PR 번호·메시지 링크·첨부) 없이 이어진 에이전트 홉 수.
-- 깊이(043 mention_depth)는 사람이 마지막으로 말한 뒤 건넌 수라 정상 협업도 길어지면 상한에 걸렸다. 이 칸은 처음엔
-- 기록만 한다(그림자) — 막힐 뻔한 부름은 meta.mentionStallShadow 에 남고, 1주 기록에서 정상 스레드 오탐 0 을 본 뒤 차단으로 바꾼다.
-- 옛 행은 0 이다(상수 기본값이라 테이블을 다시 쓰지 않는다). 사슬이 이어지면 다음 홉부터 셈이 쌓인다.
alter table message add column stall_depth int not null default 0;
