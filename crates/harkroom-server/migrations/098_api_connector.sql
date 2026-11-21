-- 외부 API 권한(C안 P2) — 설계 스레드 07519d86(채널 a42006a1), designer v3 ②③, jaebin D1~D4·E1·E2.
--
-- 두 가지를 더한다.
-- ① `api_connector`: 사람이 정한 "API 연결"(화면 이름). 에이전트는 연결 **id 로 받은 권한**과 경로만 쓰고,
--    호스트·인증 형식·키는 여기서 정한 대로 오퍼레이터가 붙인다(P3 래퍼). 키 값은 이 표에 없다 — 비밀 보관소
--    (085)의 비밀을 가리킬 뿐이다.
-- ② `account_grant` 확장: 줄 id·위임 사슬(parent_grant_id)·다시 줄 수 있는 단계(delegate_depth)·좁힌 범위
--    (limits)·정지(suspended_at). 위임(P5)은 이 칸을 쓰지만 마이그레이션은 여기서 한 번에 끝낸다.
--
-- 판정은 `auth/apiGrants.ts` 가 **쓰는 순간 사슬을 거슬러 올라가** 한다. cascade 는 거두기를 아래로 퍼뜨리고,
-- 만료·정지는 지우지 않으므로 판정이 막는다(둘 다 필요하다).

create table api_connector (
  id               uuid primary key default gen_random_uuid(),
  -- 에이전트가 `harkroom-operator api <name> …` 으로 부를 이름. 워크스페이스 안에서 하나다(비밀 이름과 같은 규칙).
  name             text not null unique check (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  owner_account_id uuid not null references account(id) on delete cascade,
  -- https 의 origin 만(경로·질의·사용자 정보 없음). 라우트가 정규화해 넣는다 — 여기서는 모양만 다시 잰다.
  base_url         text not null check (base_url ~ '^https://[^/?#@\s]+$'),
  auth_kind        text not null check (auth_kind in ('bearer', 'header', 'none')),
  -- auth_kind = 'header' 일 때 헤더 이름. bearer 는 Authorization 고정이다.
  auth_header      text null check (auth_header is null or auth_header ~ '^[A-Za-z0-9-]{1,64}$'),
  -- 키. 비밀이 지워지면 연결은 남고 "키 없음"이 된다(화면이 흐리게 보인다, 호출은 막힌다).
  secret_id        uuid null references secret(id) on delete set null,
  -- 에이전트에게 줄 수 있는 최대치. grant 의 limits.methods 는 이것의 부분집합이어야 한다.
  methods          text[] not null check (methods <@ array['GET','POST','PUT','PATCH','DELETE']::text[] and cardinality(methods) > 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((auth_kind = 'header') = (auth_header is not null))
);
create index api_connector_owner_idx on api_connector (owner_account_id);

alter table account_grant
  add column id uuid not null default gen_random_uuid(),
  -- 위임(P5): 이 줄을 준 grant. null = 사람이 준 루트. 부모를 거두면 아래가 같이 사라진다.
  add column parent_grant_id uuid null,
  -- 이 grant 를 받은 쪽이 다른 에이전트에게 다시 줄 수 있는 단계. 사람이 0·1·2 중에 고른다(기본 0).
  add column delegate_depth int not null default 0 check (delegate_depth between 0 and 2),
  -- `api.call` 의 좁힌 범위 {"methods": [...], "pathPrefix": "/api/"}. 다른 capability 는 null.
  add column limits jsonb null,
  -- 연결의 주소·인증·키가 바뀌면 그 연결의 grant 를 멈춘다(사람이 다시 확인). 지우지 않는다 — 누가 무엇을
  -- 받았는지는 남아야 다시 줄 수 있다.
  add column suspended_at timestamptz null,
  add column suspend_reason text null;

alter table account_grant add constraint account_grant_id_key unique (id);
alter table account_grant
  add constraint account_grant_parent_fk foreign key (parent_grant_id) references account_grant(id) on delete cascade;
create index account_grant_parent_idx on account_grant (parent_grant_id) where parent_grant_id is not null;
