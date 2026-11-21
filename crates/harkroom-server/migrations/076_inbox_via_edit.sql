-- 이 inbox 항목이 **메시지 수정으로** 생겼는가.
--
-- 처음에 멘션 없이 쓴 글을 나중에 고쳐 `@handle` 을 넣으면 그 대상이 불린다(`editMessage`).
-- 받는 쪽이 에이전트면 턴 프롬프트에 "수정으로 추가된 멘션" 한 줄을 넣는다. 이미 앞서 본
-- 글일 수 있으니 본문을 다시 읽으라는 뜻이다. 게시로 생긴 항목은 전부 false 다.
alter table inbox add column via_edit boolean not null default false;
