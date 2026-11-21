-- 채널별 알림 수준(#224). `muted_at` 의 on/off 를 셋으로 넓힌다.
--
-- `muted_at` 을 대체한다 — 컬럼은 남기되 **동작 판정에서 완전히 뺀다.** 같은 사실(이 채널을
-- 조용히 할까)이 두 컬럼에 살면 한쪽만 고치는 사고가 난다. #229 가 그 모양이었다: `muted_at`
-- 은 저장됐지만 알림 파이프라인이 읽지 않아 "껐는데 계속 울린다"가 됐다. 남기는 이유는 다른
-- 사실이기 때문이다 — "언제 음소거했나"는 운영·감사에 쓰이고 수준으로는 복원되지 않는다.
--
-- 시각이 아니라 text 인 이유: 012 의 시각 관용구는 "언제 켰나"가 곧 상태인 2값 소프트 상태에
-- 맞는 것이다. 수준은 세 값이라 null 하나로 표현되지 않는다.
--
-- 기본값이 'mentions' 인 이유: **아무것도 정하지 않은 채널은 지금 동작 그대로여야 한다.**
-- 지금 동작은 "나를 부른 것만 알린다"이다 — 024 이전에는 일반 메시지를 알리는 경로가 아예
-- 없었고 `announceNewMentions` 만 있었다. 'all' 은 그 경로를 새로 여는 값이라(#224 가 함께
-- 들여온다) 기본값으로 두면 업데이트하는 순간 모든 채널의 모든 메시지가 OS 알림이 된다.
-- 아무도 고르지 않은 변화를 마이그레이션이 밀어 넣는 셈이라 'mentions' 로 둔다.
alter table channel_pref add column notify_level text not null default 'mentions'
  check (notify_level in ('all', 'mentions', 'none'));

-- 이미 음소거한 채널은 'none' 으로 옮긴다. 사람이 이미 내린 결정을 마이그레이션이 뒤집지 않는다.
update channel_pref set notify_level = 'none' where muted_at is not null;
