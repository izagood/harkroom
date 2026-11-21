-- 권한의 축이 is_admin 하나였다(스펙 2026-09-20-operator-and-permissions §6 "오늘"). 역할(누가
-- 권한을 줄 수 있나)과 grant(무엇을 할 수 있나)를 갈라 둔다. is_admin 은 남긴다 — role in
-- ('owner','admin') 과 항상 같고, 기존 코드가 그것을 읽는다. 두 값이 어긋나는 것은 아래
-- check 가 막는다.
alter table account add column role text not null default 'member'
  check (role in ('owner', 'admin', 'member', 'guest'));

-- 첫 관리자(bootstrap 으로 만들어진 가장 오래된 사람 admin)가 owner 다. 나머지 admin 은 admin.
update account set role = 'admin' where is_admin;
update account set role = 'owner'
  where id = (select id from account where is_admin and kind = 'human' order by created_at limit 1);

alter table account add constraint account_role_is_admin_consistent
  check (is_admin = (role in ('owner', 'admin')));

create table account_grant (
  account_id  uuid not null references account(id) on delete cascade,
  capability  text not null,
  -- '' = 커뮤니티 전역. null 이 아닌 이유: PK 에 넣으려면 값이 있어야 한다.
  scope       text not null default '',
  granted_by  uuid not null references account(id),
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz,
  primary key (account_id, capability, scope)
);
create index account_grant_capability_idx on account_grant (capability, scope);
