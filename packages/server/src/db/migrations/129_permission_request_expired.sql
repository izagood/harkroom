-- 권한 요청의 시한이 지나면 서버가 카드를 닫는다(스레드 65f3b26e, 2026-10-19).
-- 전에는 만료된 요청의 카드가 열린 채 버튼을 보였고, 누르면 409 `request_expired` 만 돌아왔다.
alter table permission_request drop constraint permission_request_status_check;
alter table permission_request add constraint permission_request_status_check
  check (status in ('pending', 'granted', 'denied', 'approved_once', 'obsolete', 'expired'));
