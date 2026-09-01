-- 첨부파일. message_id 가 null 인 행은 "올렸지만 아직 메시지에 붙지 않은 업로드"다.
-- 업로드가 메시지보다 먼저 존재하는 이유: 파일을 먼저 쓰고 행을 나중에 만들면 실패했을 때
-- 남는 것이 고아 파일(GC 로 치울 수 있다)이고, 반대로 하면 가리키는 파일이 없는 행이
-- 남는다 — 그건 사용자에게 '깨진 첨부'로 보인다.
create table if not exists attachment (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references message(id) on delete cascade,
  uploader_id uuid not null references account(id) on delete cascade,
  -- 사용자가 준 이름. 표시에만 쓰고 경로로는 절대 쓰지 않는다.
  filename text not null,
  -- 클라이언트가 보낸 값이라 신뢰하지 않는다. 내려줄 때는 nosniff + attachment 로 감싼다.
  content_type text not null,
  size_bytes bigint not null,
  -- 스토리지 키는 서버가 만든다(uuid). 파일명이 경로가 되는 자리를 없앤다.
  storage_key text not null unique,
  created_at timestamptz not null default now(),
  attached_at timestamptz
);

-- 메시지 한 페이지분의 첨부를 message_id 로 모아 온다.
create index if not exists attachment_message_idx on attachment (message_id);
-- 고아 업로드 GC 가 "붙지 않은 채 오래된 것"을 찾는 경로.
create index if not exists attachment_unattached_idx on attachment (created_at)
  where message_id is null;
