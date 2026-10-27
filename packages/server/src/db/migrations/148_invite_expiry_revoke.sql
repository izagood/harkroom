-- 초대 토큰 수명(2026-10-27): 지금까지 초대는 **가입에 쓰여야만** 무효가 됐다 — 만료·취소 길이 없어 화면에
-- 한 번 보였거나 건넨 토큰이 기한 없이 살았다. 이 마이그레이션이 그 길을 연다.
--
-- ① `id` — 목록·취소가 가리킬 이름. 기본키 `token_hash` 는 바깥에 내보내지 않는다(해시라도 토큰의 대역이다).
-- ② `expires_at` — 새 초대는 발급 때 7일 뒤로 채운다(서버 코드). null 은 무기한이다 — 아래 ④ 뒤로는 쓰인 옛 행만 null 이다.
-- ③ `revoked_at`·`revoked_by` — 취소. 취소한 행은 지우지 않는다(목록·감사에 남는다).
-- ④ 소급 만료 — 이미 쌓인 **안 쓴** 옛 초대도 이 판이 배포된 때부터 7일 뒤 만료한다. 이미 샌 토큰을 무기한 살려 두지 않되,
--    지금 건네 둔 초대가 배포 순간 갑자기 죽지는 않게 한다.
alter table invite add column id uuid not null default gen_random_uuid();
alter table invite add constraint invite_id_key unique (id);
alter table invite add column expires_at timestamptz null;
alter table invite add column revoked_at timestamptz null;
alter table invite add column revoked_by uuid null references account(id);

update invite set expires_at = now() + interval '7 days' where used_by is null;

create index invite_created_at_idx on invite (created_at desc);
