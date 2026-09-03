-- 채널 보관(#153). 하드 삭제가 아니라 시각을 저장하는 이유: "언제 보관했나"가 운영에 필요하고,
-- null 이 곧 "활성"이라 기본값 backfill 이 필요 없다. archived_at 으로 보관 시각을,
-- archived_by 로 누가 보관했는지 남겨 감사 추적과 운영恢复를 가능하게 한다.
-- 컬럼 추가만이라 옛 코드와 호환된다 — 롤백은 '보관 해제'다.
alter table channel add column archived_at timestamptz;
alter table channel add column archived_by uuid references account(id);