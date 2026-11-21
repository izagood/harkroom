-- 비밀번호 재설정 코드(스레드 a6017542, jaebin B안). 관리자가 멤버 하나에게 1회용 코드를 발급하고, 그 사람이
-- 로그인 화면에서 코드와 새 비밀번호를 대면 바뀐다. account 에 이메일이 없으니(#110) 메일 링크 대신 이 길이다.
--
-- - 코드는 **해시만** 저장한다(`session`·`invite` 와 같은 규칙 — 이 표가 통째로 새도 코드는 새지 않는다).
-- - 사람마다 살아 있는 코드는 **하나**다(아래 부분 유일 색인). 새로 발급하면 이전 것을 `revoked_at` 으로 닫는다.
-- - `notice_seen_at`: 대상 본인에게 「관리자가 코드를 발급했다」를 알렸는가(R7). 본인이 확인하면 채운다.
create table password_reset_code (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references account(id) on delete cascade,
  code_hash      text not null unique,
  issued_by      uuid not null references account(id),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz,
  revoked_at     timestamptz,
  notice_seen_at timestamptz
);

create unique index password_reset_code_live_idx
  on password_reset_code (account_id) where used_at is null and revoked_at is null;

create index password_reset_code_notice_idx
  on password_reset_code (account_id) where notice_seen_at is null;
