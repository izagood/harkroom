-- 스레드 답을 채널에도 함께 올린다(#231). 메시지를 두 개 만들지 않고 하나를 두 곳에
-- 보인다 — 두 개면 편집·삭제할 것이 둘이 되고, 하나만 고치면 같은 발언이 두 곳에서
-- 다른 말을 한다.
--
-- thread_root_id 가 없는 메시지에 이 값이 true 인 것은 뜻이 없다 — 이미 채널 메시지다.
-- 서버가 조용히 false 로 정규화한다(HTTP 와 MCP 입력 양쪽).
alter table message add column also_in_channel boolean not null default false;
