-- 에이전트 팀 (#172). 팀은 에이전트 집합에 이름을 붙여 **저장한 것**이다 —
-- "이 다섯을 넣는다"를 매번 고르는 즉석 멀티셀렉트가 아니다. 매번 고르면 하나
-- 빠뜨리는 실수가 매번 되살아난다.
create table agent_team (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references account(id),
  created_at timestamptz not null default now()
);

-- 이름은 계정 handle·집합 handle 과 **같은 네임스페이스**를 쓴다(집합 026 과 같은 결정).
-- 나중에 `@팀` 멘션을 열 여지를 남기기 위한 예약이고, 그래서 유일성도 멘션 해석과 같은
-- 기준이어야 한다: `mentionedHandles` 는 대소문자를 무시하므로 `Ops` 와 `ops` 는 한
-- 이름이다. `name text unique` 로 두면 그 둘이 동시에 살아남아, 멘션을 여는 날 한 이름이
-- 두 팀을 가리킨다. 계정·집합 handle 과의 충돌은 서버가 삽입 문장 안에서 막는다
-- (`services/teams.ts` 의 `createTeam`) — 여기서 걸 수 있는 제약이 아니다.
create unique index agent_team_name_lower_idx on agent_team (lower(name));

-- 팀원. 에이전트만 넣을 수 있다 — 그 판정은 라우트가 하고(400 `not_an_agent`),
-- 여기서는 걸 수 없다: `account.kind` 를 참조하는 check 제약은 그 계정의 kind 가
-- 나중에 바뀌면 뒤늦게 깨지는 제약이 된다.
--
-- on delete cascade 는 팀에만 건다. 팀이 사라지면 명단은 뜻이 없다(집합 026 과 같은
-- 이유). 계정 쪽에는 걸지 않는다 — 계정 하드 삭제는 오늘 없고(009), 비활성화는
-- 팀원을 지우지 않는다: 팀 구성은 운영자의 의도 기록이라 잠깐 꺼 뒀다고 지우면
-- 다시 켰을 때 다시 넣어야 한다. 걸러지는 자리는 채널에 넣는 시점 하나다.
create table agent_team_member (
  team_id uuid not null references agent_team(id) on delete cascade,
  agent_account_id uuid not null references account(id),
  primary key (team_id, agent_account_id)
);

-- created_by 는 감사에서 '누가 만들었는가'를 답하기 위한 것이지 특별 권한을 주지
-- 않는다 — 팀 관리는 admin 전체에게 열려 있다.
