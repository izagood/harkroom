-- 권한 요청의 대체(superseded). 에이전트가 같은 요청(에이전트·종류·대상·채널·스레드)을 다시 냈을 때, 시한이 지나
-- 기다리던 것(pending)이나 이미 만료된 것(expired)을 새 요청에 잇는다 — 해결하는 쪽이 옛 카드에서 새 요청을 따라갈 수 있게.
-- 시한 안의 기다리는 요청이 있으면 지금처럼 그것을 돌려주고 새로 만들지 않는다(대체는 일어나지 않는다).
alter table permission_request drop constraint permission_request_status_check;
alter table permission_request add constraint permission_request_status_check
  check (status in ('pending', 'granted', 'denied', 'approved_once', 'obsolete', 'expired', 'superseded'));
alter table permission_request add column superseded_by uuid references permission_request(id) on delete set null;
create index permission_request_superseded_by on permission_request (superseded_by) where superseded_by is not null;
