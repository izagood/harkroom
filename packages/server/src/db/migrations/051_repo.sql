-- 저장소를 **가리키는 것**에서 **갖는 것**으로 (docs/hub-seat.md 「층 1 — 쓰기」).
--
-- 지금까지 저장소 설정은 두 조각으로 흩어져 있었다: 채널의 `repo` 이름(어느 저장소인가)과
-- 전역 `projection_config.avcs_base_url`(어디에 있는가). 그래서 **저장소마다 다른 서버**를
-- 볼 수 없었고, murmur 가 저장소를 직접 호스팅한다는 선택지는 놓을 자리조차 없었다.
--
-- 이 테이블이 그 자리다. 한 줄이 저장소 하나의 설정이다.
--
-- ## 왜 채널에 `repo_id` 를 매달지 않는가
--
-- 채널은 계속 `repo` **문자열**로 가리킨다. 이 저장소에서 저장소의 키는 이미 그 문자열이다 —
-- `projection_cursor(repo, avcs_base_url)` · `active_lease(repo, ...)` 가 전부 그것으로 잡혀 있고,
-- 그 셋을 한꺼번에 uuid 로 바꾸는 것은 이 단계가 할 일이 아니다(마이그레이션 하나가 커지면
-- 되돌릴 수 없는 것이 늘어난다). slug 는 여기서 자연키이고, 그것으로 충분하다.
--
-- ## `base_url` 이 null 인 것은 '없음' 이 아니라 '전역을 따른다'
--
-- 이행기 기본값이다. 지금 돌고 있는 워크스페이스는 전역 URL 하나로 모든 저장소를 보고 있고,
-- 이 마이그레이션이 그것을 깨서는 안 된다. 그래서 백필된 행은 전부 `base_url = null` 이고,
-- 읽는 쪽(`resolveRepoBaseUrl`)이 `repo.base_url ?? 전역` 으로 접는다. 저장소별 주소를 실제로
-- 정하기 시작하면 그때부터 이 칸이 채워진다.
create table repo (
  id uuid primary key default gen_random_uuid(),
  -- `<org>/<repo>` 두 세그먼트. 채널의 `repo` 와 같은 문자열이다.
  slug text unique not null check (length(slug) > 0),
  -- linked: 바깥 avcs-server 를 읽는다(지금까지의 유일한 모양).
  -- hosted: murmur 안에서 avcs-server 를 띄운다(다음 단계).
  mode text not null default 'linked' check (mode in ('linked', 'hosted')),
  -- null = 전역 해석값을 따른다(위 설명). hosted 면 읽지 않는다 — 주소는 murmur 자신이다.
  base_url text check (base_url is null or length(base_url) > 0),
  created_at timestamptz not null default now()
);

-- 이미 채널에 걸려 있는 저장소를 그대로 들여온다. **설정을 바꾸지 않는다** —
-- 전부 `linked` · `base_url = null` 이라 동작은 이 마이그레이션 전후로 같다.
insert into repo (slug)
select distinct repo from channel where repo is not null and length(repo) > 0
on conflict (slug) do nothing;
