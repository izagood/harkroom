-- 소유는 grant 가 아니다(스펙 2026-09-20-operator-and-permissions §6 (3)). channel 에 그 컬럼이
-- 없었다. 기존 채널은 null — 008 판례대로 추측 backfill 은 안 한다: null 은 "아직 아무도"이지
-- "아무나"가 아니다(can() 의 isOwnerOf 가 null 을 소유로 읽지 않는다).
alter table channel add column created_by uuid references account(id) on delete set null;
