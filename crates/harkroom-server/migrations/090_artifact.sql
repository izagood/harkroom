-- 미리보기(아티팩트) — 에이전트가 올린 HTML 한 장을 harkroom 안에서 바로 열어 본다.
--
-- 왜 새 표인가: HTML 바이트는 **보통 첨부와 똑같이** attachment 행에 산다. 그래야 가시성
-- (`resolveAttachmentFor`)·메시지 삭제·채널 삭제 시 파일 정리·비밀 누출 검사·채널 파일 목록을
-- 전부 그대로 물려받는다. 이 표들이 더하는 것은 두 가지뿐이다.
--  1. **고정 id + 버전 번호.** 같은 안을 고쳐 올리면 같은 artifact 의 n+1 이 된다. 버전마다
--     새 메시지(새 첨부)이고, 옛 메시지는 그때 버전을 그대로 가리킨다 — 대화가 "그때 무엇을
--     보고 말했나"를 잃지 않는다.
--  2. **미리보기 자격.** 미리보기 라우트는 artifact_version 에 걸린 첨부만 연다. 사람이 올린
--     아무 .html 첨부는 지금처럼 다운로드뿐이다(v1 범위, jaebin 결정 2026-10-02).
create table artifact (
  id uuid primary key default gen_random_uuid(),
  -- 고쳐 올릴 수 있는 범위다. 다른 채널에서 같은 id 로 버전을 올리면 옛 채널의 대화가
  -- 모르는 사이에 바뀐 안을 가리키게 된다.
  channel_id uuid not null references channel(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  created_by uuid not null references account(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table artifact_version (
  artifact_id uuid not null references artifact(id) on delete cascade,
  version int not null check (version >= 1),
  -- 한 첨부는 한 버전에만 걸린다 — attachment 가 한 메시지에만 붙는 것과 같은 이유다.
  -- 첨부가 지워지면(메시지 cascade) 그 버전 행도 함께 사라진다.
  attachment_id uuid not null unique references attachment(id) on delete cascade,
  -- 선택 표지 그림(PNG). 없으면 화면은 글 카드로만 그린다.
  cover_attachment_id uuid unique references attachment(id) on delete set null,
  summary text check (summary is null or char_length(summary) <= 500),
  created_at timestamptz not null default now(),
  primary key (artifact_id, version)
);

-- 미리보기 URL 서명 키. **한 행**만 있다. 환경 변수가 아니라 DB 에 두는 이유: 키가 없는
-- 테넌트에서도 설정 없이 켜져야 하고, 복제본이 둘 이상이면(무중단 배포) 모든 파드가 **같은
-- 키**로 서명·검증해야 한다 — 프로세스마다 난수를 뽑으면 다른 파드가 받은 URL 이 404 가 된다.
-- 값은 서버가 처음 쓸 때 `insert … on conflict do nothing` 으로 한 번 만든다(동시 기동 안전).
create table preview_signing_key (
  id smallint primary key default 1 check (id = 1),
  key bytea not null check (octet_length(key) >= 32),
  created_at timestamptz not null default now()
);
