-- 채널당 하나(#188). channel_id 가 PK 라 스키마 자체가 "채널당 하나"를 강제한다.
-- 메시지로 두지 않는 이유: 메시지는 추가(append)이고 문서는 덮어쓰기(replace)다.
-- 같은 모델에 두면 메시지가 "밀려나지 않는다"는 속성을 위해 별도 로직이 필요해진다.
create table channel_doc (
  channel_id uuid primary key references channel(id),
  body text not null default '',
  updated_by uuid not null references account(id),
  updated_at timestamptz not null default now()
);