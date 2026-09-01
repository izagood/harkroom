-- idempotency key를 (author, channel) 범위로 좁힌다.
--
-- key가 전역 PRIMARY KEY였고 재생 조회가 key만 봤기 때문에, 남의 key를 맞히면 그 메시지
-- 전문이 재생 응답으로 돌아왔다 — DM 멤버가 아니어도 마찬가지였다(요청한 채널만 검사하고,
-- 반환되는 메시지는 다른 채널의 것일 수 있었다). key는 클라이언트가 고르는 값이므로
-- 전역 유일성을 가정할 수 없다.
alter table idempotency_key
  add column author_id uuid references account(id),
  add column channel_id uuid references channel(id);

-- 기존 행은 자기 메시지에서 채운다.
update idempotency_key k
  set author_id = m.author_id, channel_id = m.channel_id
  from message m where m.id = k.message_id;

alter table idempotency_key
  alter column author_id set not null,
  alter column channel_id set not null;

alter table idempotency_key drop constraint idempotency_key_pkey;
alter table idempotency_key add primary key (author_id, channel_id, key);
