-- 메시지 고정(#218). **채널 전역 상태다** — 사람마다 따로가 아니다.
-- 보관(015_channel_archive.sql)이 같은 논리로 채널 단위이고, 음소거·즐겨찾기
-- (012_channel_pref.sql)가 계정별인 것과 대비된다. "이 결정은 계속 보여야 한다"는
-- 채널에 대한 사실이지 내 취향이 아니므로, 기본키에 account_id 가 들어가지 않는다.
--
-- channel_id 를 message 에서 복제해 두는 이유: 핀 목록은 채널 단위 질의이고, 매번
-- message 를 조인해 채널을 알아내면 그 조인이 목록 질의의 뜨거운 경로에 들어간다.
-- **다만 그 값이 message.channel_id 와 어긋나면 안 된다** — 삽입할 때 메시지 행에서
-- 읽어 넣고 클라이언트가 준 값은 절대 쓰지 않는다(services/pins.ts 의 insert ... select).
--
-- message_id 에 on delete cascade 를 걸지 않는 이유: 메시지는 하드 삭제되지 않고
-- deleted_at 으로 가려진다. 지워진 메시지의 핀은 목록 질의가 `deleted_at is null` 로
-- 걸러 자동으로 사라진다 — 삭제 경로에 핀 정리를 얹으면 그 경로가 하나 더 늘고,
-- 빠뜨리면 지운 메시지 본문이 핀 목록으로 샌다.
create table message_pin (
  message_id uuid not null references message(id),
  channel_id uuid not null references channel(id),
  pinned_by uuid not null references account(id),
  pinned_at timestamptz not null default now(),
  primary key (message_id)
);

-- 목록은 언제나 "이 채널의 핀을 최근 순으로"다. 기본키는 message_id 하나라 그 질의를
-- 돕지 못한다 — channel_id 를 복제해 둔 이유를 실제로 살리는 것이 이 인덱스다.
create index message_pin_channel_idx on message_pin (channel_id, pinned_at desc);
