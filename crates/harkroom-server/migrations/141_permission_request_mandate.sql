-- 위임(mandate) W4 — 권한 요청이 그 요청을 낸 턴의 위임을 기억한다(턴 임대의 mandate_id, 서버가 적는다).
-- 승인되면 기존 grant 와 함께 그 위임에 줄(mandate_line)이 하나 더해진다. 위임 없는 턴의 요청은 null 이고 동작은 전과 같다.
-- 새 nullable 칸이라 옛 파드에 무해하다(expand).
alter table permission_request add column if not exists mandate_id uuid null references mandate(id) on delete set null;
