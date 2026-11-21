-- 채널 섹션을 표로 세운다(사이드바 섹션 D2). 038 은 섹션을 `channel_pref.section` 이름
-- 문자열로만 가졌다 — 그래서 빈 섹션·섹션 순서·접힘 상태를 담을 자리가 없었다(섹션은
-- 채널이 하나라도 들어 있을 때만 존재했고, 순서는 이름순 고정이었다).
--
-- 계정별이다(D1) — 012 의 channel_pref 와 같은 층이다. 한 사람의 섹션이 남의 사이드바를
-- 바꾸지 않는다.
--
-- position: 사이드바에서의 섹션 순서(손으로 정한다, D3). 0..n-1 로 촘촘히 유지한다 —
--   지우기·순서 바꾸기가 다시 매긴다. 유일 제약을 걸지 않는 이유: 한 문장 안에서 두 행의
--   값을 맞바꾸는 순간 제약에 걸린다(deferrable 로 풀 수 있지만 그만큼 얻는 것이 없다).
-- collapsed: 접힘 상태. 기기 사이에 따라오도록 서버에 둔다.
-- unique (account_id, name): 038 의 이름 문자열과 같은 뜻을 지킨다 — 옛 클라이언트는 이름으로
--   섹션을 가리킨다(`PATCH /channels/:id/pref { section }`, `PATCH /channels/sections/:name`).
create table channel_section (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id) on delete cascade,
  name       text not null,
  position   integer not null,
  collapsed  boolean not null default false,
  created_at timestamptz not null default now(),
  unique (account_id, name)
);

-- 채널 → 섹션. 섹션을 지우면 채널은 미분류(CHANNELS)로 돌아간다 — 채널 선호는 남는다.
-- `section` 이름 문자열은 **지우지 않고 거울로 남긴다**: 롤아웃 동안 옛 서버 파드와 옛 앱이
-- 그 컬럼을 읽는다. 쓰는 쪽(services/channelSections.ts)이 둘을 한 문장에서 같이 쓴다.
alter table channel_pref
  add column section_id uuid references channel_section(id) on delete set null;
create index channel_pref_section_id on channel_pref (section_id) where section_id is not null;

-- 옮겨 담기: 지금 있는 이름마다 섹션 행 하나. 순서는 지금 화면과 같은 이름순으로 시작한다.
insert into channel_section (account_id, name, position)
select account_id, section,
       (row_number() over (partition by account_id order by section) - 1)::integer
from (select distinct account_id, section from channel_pref where section is not null) s;

update channel_pref p set section_id = s.id
from channel_section s
where s.account_id = p.account_id and s.name = p.section;
