-- 에이전트 비활성화(#94). 하드 삭제가 아니라 소프트 비활성화인 이유: message.author_id 가
-- account(id) 를 RESTRICT 로 참조하므로(001_init.sql) 메시지를 하나라도 쓴 계정은 지울 수
-- 없고, 대화 이력을 어떻게 할지는 별개 결정이다(이슈 #94 가 그 질문들을 열어 뒀다).
-- 불리언이 아니라 시각인 이유: "언제 껐나"가 감사·운영에 필요하고, null 이 곧 '활성'이라
-- 기본값 backfill 이 필요 없다. 기존 행은 전부 null(활성)로 남는다.
-- 컬럼 추가만이라 옛 코드와 호환된다 — 롤백은 '되돌리기'가 아니라 '안 쓰기'다.
alter table account add column disabled_at timestamptz;
