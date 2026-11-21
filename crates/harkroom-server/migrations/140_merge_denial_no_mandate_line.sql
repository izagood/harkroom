-- 위임(mandate) W3 — 위임 판정을 켠 서버(HARKROOM_MANDATE_ENFORCE=on)는 임대의 위임에 맞는 merge 줄이 없으면
-- no_mandate_line 으로 거절하고 카드용 거절 기록을 남긴다. 기록은 권한을 주지 않는다 — 카드는 지금처럼 승인만 청한다.
alter table merge_denial drop constraint merge_denial_reason_check;
alter table merge_denial add constraint merge_denial_reason_check
  check (reason in ('not_granted', 'cause_not_human', 'ci_not_green', 'no_mandate_line'));
