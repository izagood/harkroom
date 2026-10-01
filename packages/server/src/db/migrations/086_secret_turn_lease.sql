-- 턴 임대(086) — 비밀 보관소 PR 2, 보안 검토 H1(스레드 bc98df3a).
--
-- 서버는 지금까지 요청이 **어느 턴에서 왔는지** 몰랐다: 에이전트 인증은 오퍼레이터 토큰 +
-- `X-Harkroom-Agent` + 배정뿐이고, 그 자격은 모델의 셸까지 내려간다. 그래서 reveal 이 요청
-- 인자의 channelId 를 믿으면 공개 채널의 턴이 비공개 채널에만 허용된 비밀을 받아 간다.
--
-- 임대는 러너가 멘션(인박스 항목)을 집을 때 받는다. 채널·스레드는 **서버가 그 메시지에서**
-- 읽어 이 행에 박고, reveal 은 이 행만 본다. 토큰은 해시로만 둔다(PAT 와 같다).
--
-- 남는 구멍(H2 와 같은 경계): 같은 오퍼레이터의 셸 가능 에이전트는 러너와 같은 자격을 쥐므로,
-- 아직 임대되지 않은 자기 멘션을 먼저 임대할 수 있다. 그러면 러너의 임대가 409 로 부딪힌다 —
-- 그 충돌은 감사에 남고 소유자가 본다. 임대를 멘션당 하나로 묶는 것이 그 신호를 만든다.
create table secret_turn_lease (
  id               uuid primary key default gen_random_uuid(),
  token_hash       text not null,
  agent_id         uuid not null references account(id) on delete cascade,
  operator_id      uuid not null references operator(id) on delete cascade,
  cause_message_id uuid not null references message(id) on delete cascade,
  channel_id       uuid not null,
  thread_root_id   uuid not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  ended_at         timestamptz null
);
-- 멘션 하나에 살아 있는 임대 하나. 끝났거나 만료된 것은 다시 받을 수 있다(러너 재시도).
create index secret_turn_lease_cause_idx on secret_turn_lease (agent_id, cause_message_id);
