-- 첨부파일. message_id 가 null 인 행은 "올렸지만 아직 메시지에 붙지 않은 업로드"다.
-- 업로드가 메시지보다 먼저 존재하는 이유: 파일을 먼저 쓰고 행을 나중에 만들면 실패했을 때
-- 남는 것이 고아 파일(GC 로 치울 수 있다)이고, 반대로 하면 가리키는 파일이 없는 행이
-- 남는다 — 그건 사용자에게 '깨진 첨부'로 보인다.
--
-- #257 이 그 문제의식의 **전역판**을 보여 줬다: 이 순서 규칙은 한 건씩 깨지는 것을 막지만
-- 경로의 **기준**이 흔들리는 것은 막지 못한다. 저장 루트 기본값이 cwd 상대경로였던 탓에
-- 기동 디렉터리가 달라지자 이미 있던 **모든 행이 한꺼번에** 가리키는 파일을 잃었다.
-- 그래서 기본 루트는 이제 서버 패키지 기준 절대경로다(`buildServer.ts` 의
-- `defaultAttachmentRoot`). 아래 `storage_key` 는 루트에 상대적인 키일 뿐이므로 기준을
-- 고정하는 책임은 스키마가 아니라 그 자리에 있다.
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
