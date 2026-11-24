//! 정본 `createMentionScheduler().admit` 본체(B4-1b-2b-1) — 배치 하나의 entry 를 차례로 보고, 앞쪽 관문(장부) →
//! 조종 유예 → 같은 스레드 도는 중 → 러너 사이 스레드 임대 → 머신 자리 → 묶음 → 시도 회계를 지나 턴을 띄우기로
//! 정한다. 턴 실행(`runOne`)은 [`AdmitDeps::launch`] 뒤에 있고 B4-1b-2b-2 가 채운다.
//!
//! 서버·레지스트리·임대·자리는 모두 [`AdmitDeps`] 로 받는다 — 정본의 `deps` 와 같은 자리이고, 시험은 가짜로 갈아 끼운다.
//! 통지·경고의 실패는 관측의 실패라 판정을 바꾸지 않는다(정본 주석 그대로). 고아·관문 상한 읽음 처리의 실패만
//! 호출자에게 돌려준다(정본 `await deps.harkroom.markRead(orphans)` 가 던지는 것과 같다).

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::mention_ledger::{Ledger, PreGate, mention_anchor, message_for, thread_key};
use crate::mention_scheduler::{DEFER_WARN_MS, DEFER_WARN_PENDING, is_blocked_notice_reason};
use crate::poll_loop::{AdmitOutcome, BatchContext};
use crate::rest::SlotOutcome;
use crate::turn_registry::{DeferResult, MentionReservation, ThreadControl};

/// admit 이 올리는 러너 알림(정본 `RunnerNotice` 중 admit 몫).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdmitNotice {
    /// 사람이 조종 중이라 미뤘다(entry 당 1회).
    Controlled { handle: String, pending: usize },
    /// 같은 스레드의 앞 턴이 끝나면 읽는다(사람 멘션, entry 당 1회).
    BlockedByTurn,
}

/// 러너 사이의 스레드 임대 하나(정본 `ThreadClaim`). 턴이 완전히 끝난 뒤 놓는다.
pub trait ThreadClaimHandle: Send {
    fn release(&self);
    /// 이 임대를 잃었다(정본 `claim.lost.aborted` — 펜싱). 잃는 길이 없는 임대는 늘 `false`.
    fn fenced(&self) -> bool {
        false
    }
}

/// 스레드 임대를 잡아 본 결과.
pub enum ClaimHold {
    /// 이 러너는 스레드 임대를 쓰지 않는다(정본 `deps.threadClaims` 없음).
    NotConfigured,
    /// 다른 러너가 그 스레드에서 턴을 돌린다 — 이번 폴엔 띄우지 않는다.
    Busy,
    Held(Box<dyn ThreadClaimHandle>),
}

/// admit 이 밖에서 받는 것(정본 `MentionSchedulerDeps` 중 admit 몫).
pub trait AdmitDeps {
    fn now(&self) -> u64;
    /// 앞 세대가 들고 있는 entry(이관 중, 정본 `heldEntryIds`).
    fn held_entry_ids(&self) -> HashSet<i64>;
    /// 그 계정의 관문 표식이 아직 있는가. 실패는 `false`.
    fn attention_active(&mut self, config_dir: &str) -> bool;
    /// 사람이 이 스레드를 조종 중인가(도는 인터랙티브 턴 + 기다리는 이어받기 예약).
    fn control_of(&self, key: &str) -> Option<ThreadControl>;
    fn defer(&mut self, key: &str, entry_id: i64, seq: i64, now: u64) -> DeferResult;
    fn mark_warned(&mut self, key: &str);
    /// 레지스트리에 이 스레드의 턴이 있는가(정본 `registry.get(threadKey)`).
    fn registry_busy(&self, key: &str) -> bool;
    /// 멘션 턴을 띄우기로 정했다 — 레지스트리에 예약한다(인터랙티브 open 이 이 결정을 본다). `None` 이면 그 사이
    /// 인터랙티브 턴이 등록됐다 — 띄우지 않는다.
    fn reserve_mention(&mut self, key: &str) -> Option<MentionReservation>;
    fn notice(
        &mut self,
        channel_id: &str,
        anchor: &str,
        notice: &AdmitNotice,
    ) -> Result<(), String>;
    /// 조종 상한 경고(정본 `harkroom.fail`, retryable false).
    fn fail(
        &mut self,
        channel_id: &str,
        anchor: &str,
        body: &str,
        what: &str,
        reason: &str,
    ) -> Result<(), String>;
    fn hold_claim(&mut self, channel_id: &str, anchor: &str) -> ClaimHold;
    /// 서로 다른 스레드 여럿의 임대를 한꺼번에 잡는다 — `wants` 는 (채널, 앵커)이고 답은 같은 순서다. 기본은 하나씩
    /// 차례로 잡는다. 실물은 동시에 부른다(서버 왕복이 건수만큼 줄 서지 않게).
    fn hold_claims(&mut self, wants: &[(String, String)]) -> Vec<ClaimHold> {
        wants
            .iter()
            .map(|(channel, anchor)| self.hold_claim(channel, anchor))
            .collect()
    }
    /// 머신 전체 동시 턴 자리. `None` 이면 자리 제한을 쓰지 않는다(정본 `deps.turnSlots` 없음).
    fn acquire_slot(&mut self, key: &str) -> Option<SlotOutcome>;
    fn release_slot(&mut self, key: &str);
    /// 정본 `turnWatch.started` — 실패는 삼킨다.
    fn turn_started(&mut self, key: &str, message_id: &str);
    fn mark_read(&mut self, ids: &[i64]) -> Result<(), String>;
    /// 턴을 띄운다(정본 `runOne` + `finally`). 끝나면 [`Launch::release_holds`] 를 부를 책임은 받는 쪽에 있다.
    fn launch(&mut self, launch: Launch);
}

/// 띄우기로 정한 턴 하나(정본 `runOne` 인자).
pub struct Launch {
    /// 대표 entry 줄(서버 inbox 줄 그대로 — reason·team·delegation·delegatedBy·viaEdit·canceledWakes·startedIn·delegations).
    pub lead_entry: Value,
    pub lead_mention: Value,
    /// 묶여 함께 실리는 앞 글들(오래된 순, 대표 제외).
    pub bundled: Vec<Value>,
    pub anchor: String,
    pub thread_key: String,
    /// 대표의 이번 시도 번호(1부터).
    pub tried: u32,
    pub claim: Option<Box<dyn ThreadClaimHandle>>,
    pub slot_held: bool,
    /// 레지스트리의 멘션 예약 — `release_holds` 나 `Launch` 가 떨어질 때 풀린다.
    pub reservation: Option<MentionReservation>,
}

impl Launch {
    pub fn lead_id(&self) -> i64 {
        entry_id(&self.lead_entry)
    }

    /// 턴이 **완전히 끝난 뒤** 임대·자리를 놓고 감시에 끝을 알린다(정본 `.finally`). 재시도로 미룬 멘션도 이 턴은
    /// 끝났다 — 다음 시도는 다시 잡는다.
    pub fn release_holds(
        &mut self,
        release_slot: &mut dyn FnMut(&str),
        turn_ended: &mut dyn FnMut(&str, &str),
    ) {
        if let Some(c) = self.claim.take() {
            c.release();
        }
        drop(self.reservation.take());
        if std::mem::take(&mut self.slot_held) {
            release_slot(&self.thread_key);
        }
        let mid = self
            .lead_mention
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        turn_ended(&self.thread_key, mid);
    }
}

/// 정본 `controlHeldNotice`.
pub fn control_held_notice(handle: &str, pending: usize, held_ms: i64) -> String {
    let minutes = held_minutes(held_ms);
    format!(
        "{handle} 의 조종이 {minutes}분째 이어져 이 스레드의 멘션 {pending}건이 대기 중입니다. \
         조종이 끝나야 처리됩니다 — 터미널에서 하네스를 종료하거나, Agents 탭에서 「조종 끝내기」를 누르세요. \
         (대기 중인 멘션은 사라지지 않습니다.)"
    )
}

/// `Math.max(1, Math.round(ms / 60000))`.
fn held_minutes(held_ms: i64) -> i64 {
    ((held_ms as f64 / 60_000.0).round() as i64).max(1)
}

fn entry_id(entry: &Value) -> i64 {
    entry.get("id").and_then(Value::as_i64).unwrap_or_default()
}

pub(crate) fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// 배치 하나를 받아들인다. 고아(메시지 없는 entry)·관문 상한 entry 의 읽음 처리가 실패하면 `Err` — 장부의
/// 시도 회계는 이미 반영됐다(정본도 던지기 전에 턴을 띄운 뒤다).
pub fn admit(
    ledger: &mut Ledger,
    deps: &mut dyn AdmitDeps,
    batch: &Value,
    ctx: &BatchContext,
) -> Result<AdmitOutcome, String> {
    let mut out = AdmitOutcome::default();
    let mut orphans: Vec<i64> = Vec::new();
    let mut done_again: Vec<i64> = Vec::new();
    ledger.prune(deps.now());
    let held = deps.held_entry_ids();
    let entries = batch
        .get("entries")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();

    // 스레드 임대는 미리 한꺼번에 잡는다 — 하나씩 잡으면 서버 왕복이 건수만큼 턴 시작 앞에 줄을 선다.
    let mut prefetched = prefetch_claims(ledger, deps, batch, entries, &held);
    // 이 폴에서 「남이 쥠」으로 답이 온 스레드 — 같은 스레드의 다음 entry 는 서버에 다시 묻지 않는다.
    let mut claim_busy: HashSet<String> = HashSet::new();

    for (idx, entry) in entries.iter().enumerate() {
        let id = entry_id(entry);
        let Some(mention) = message_for(batch, entry) else {
            orphans.push(id);
            continue;
        };
        let now = deps.now();
        match ledger.pre_gate(id, now, &held, &mut |dir| deps.attention_active(dir)) {
            PreGate::Proceed => {}
            PreGate::Blocked => {
                out.blocked += 1;
                continue;
            }
            PreGate::Skip => continue,
            PreGate::MarkRead => {
                orphans.push(id);
                continue;
            }
            PreGate::DoneAgain => {
                done_again.push(id);
                continue;
            }
        }

        let channel = str_of(mention, "channelId");
        let anchor = mention_anchor(mention).to_string();
        let key = thread_key(channel, Some(&anchor));

        // 조종 유예 — 아래 스레드 판정보다 앞이어야 한다(뒤면 인터랙티브 턴이 `blocked` 로 세어져 통지가 없다).
        if let Some(control) = deps.control_of(&key) {
            out.deferred += 1;
            let handle = control
                .opened_by_handle
                .unwrap_or_else(|| "소유자".to_string());
            let seq = mention
                .get("seq")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let d = deps.defer(&key, id, seq, now);
            if d.should_notify {
                let n = AdmitNotice::Controlled {
                    handle: handle.clone(),
                    pending: d.pending,
                };
                if let Err(e) = deps.notice(channel, &anchor, &n) {
                    eprintln!(
                        "  {} 대기 통지 발화 실패(유예는 유지된다): {e}",
                        str_of(entry, "messageId")
                    );
                }
            }
            // 유예를 무한으로 두지 않는다 — 상한에서 한 번 `막힘`으로 사람을 부른다. 먼저 적는다(발화 실패가 폴마다 쌓이지 않게).
            if !d.warned && (d.pending >= DEFER_WARN_PENDING || d.held_ms >= DEFER_WARN_MS as i64) {
                deps.mark_warned(&key);
                let body = control_held_notice(&handle, d.pending, d.held_ms);
                let reason = format!(
                    "{handle} 의 조종이 {}분째 이어진다",
                    held_minutes(d.held_ms)
                );
                if let Err(e) = deps.fail(
                    channel,
                    &anchor,
                    &body,
                    "사람이 조종 중이라 멘션을 처리하지 못하고 있다",
                    &reason,
                ) {
                    eprintln!(
                        "  {} 조종 상한 경고 발화 실패(유예는 유지된다): {e}",
                        str_of(entry, "messageId")
                    );
                }
            }
            continue;
        }

        if ledger.thread_in_flight(&key) || deps.registry_busy(&key) {
            out.blocked += 1;
            notice_blocked(ledger, deps, entry, mention, &anchor, ctx);
            continue;
        }

        // 러너 사이의 잠금. 기다리는 사이 이 프로세스 안에서 같은 스레드가 시작됐을 수 있다 — 다시 본다.
        let hold = if claim_busy.contains(&key) {
            ClaimHold::Busy
        } else {
            prefetched
                .remove(&key)
                .unwrap_or_else(|| deps.hold_claim(channel, &anchor))
        };
        let claim = match hold {
            ClaimHold::NotConfigured => None,
            ClaimHold::Busy => {
                claim_busy.insert(key);
                out.blocked += 1;
                continue;
            }
            ClaimHold::Held(c) => {
                if ledger.thread_in_flight(&key) || deps.registry_busy(&key) {
                    c.release();
                    out.blocked += 1;
                    continue;
                }
                Some(c)
            }
        };

        // 머신 전체의 동시 턴 상한 — 자리가 없으면 잡은 스레드 임대를 놓고 다음 폴로 미룬다.
        let mut slot_held = false;
        if let Some(slot) = deps.acquire_slot(&key) {
            if slot == SlotOutcome::Full {
                if let Some(c) = claim {
                    c.release();
                }
                out.blocked += 1;
                continue;
            }
            slot_held = slot == SlotOutcome::Granted;
            if ledger.thread_in_flight(&key) || deps.registry_busy(&key) {
                if slot_held {
                    deps.release_slot(&key);
                }
                if let Some(c) = claim {
                    c.release();
                }
                out.blocked += 1;
                continue;
            }
        }

        // 같은 사람이 이 스레드에 연달아 부른 보통 멘션은 한 턴으로. 대표는 그중 가장 새 글이다.
        let group_idx = ledger.bundle_for(batch, idx, ctx, now, &held);
        let group_ids: Vec<i64> = group_idx.iter().map(|&i| entry_id(&entries[i])).collect();
        let lead_entry = &entries[*group_idx.last().expect("group is never empty")];
        let Some(lead_mention) = message_for(batch, lead_entry) else {
            // bundle_for 는 메시지가 있는 entry 만 넣는다 — 닿지 않는 길이지만 임대는 놓는다.
            if slot_held {
                deps.release_slot(&key);
            }
            if let Some(c) = claim {
                c.release();
            }
            continue;
        };
        let bundled: Vec<Value> = group_idx[..group_idx.len() - 1]
            .iter()
            .filter_map(|&i| message_for(batch, &entries[i]).cloned())
            .collect();

        // 장부 등록은 동기적으로, 띄우기 전에. 인터랙티브 open 도 이 결정을 보게 레지스트리에 예약한다.
        // 예약은 장부 등록보다 앞 — `control_of` 판정 뒤 인터랙티브가 끼어들었으면 아무것도 적지 않고 놓는다.
        let Some(reservation) = deps.reserve_mention(&key) else {
            if slot_held {
                deps.release_slot(&key);
            }
            if let Some(c) = claim {
                c.release();
            }
            out.blocked += 1;
            continue;
        };
        let tried = ledger.start(&group_ids, &key);
        out.started += 1;
        deps.turn_started(&key, str_of(lead_mention, "id"));
        deps.launch(Launch {
            lead_entry: lead_entry.clone(),
            lead_mention: lead_mention.clone(),
            bundled,
            anchor,
            thread_key: key,
            tried,
            claim,
            slot_held,
            reservation: Some(reservation),
        });
    }

    // 미리 잡았는데 쓰지 않은 임대는 놓는다(그 사이 조종·인터랙티브가 끼어들어 제 차례에 띄우지 않은 스레드).
    for hold in prefetched.into_values() {
        if let ClaimHold::Held(c) = hold {
            c.release();
        }
    }

    // 정본 순서: 고아 읽음 처리가 던지면 다시 읽음 처리(doneAgain)는 다음 폴로 미뤄진다.
    if !orphans.is_empty() {
        deps.mark_read(&orphans)?;
    }
    if !done_again.is_empty() {
        let ok = match deps.mark_read(&done_again) {
            Ok(()) => true,
            Err(e) => {
                eprintln!(
                    "  entry {} 읽음 처리 실패(턴은 끝났다 — 다시 띄우지 않고 다음 폴에 읽음 처리만 다시 한다): {e}",
                    done_again
                        .iter()
                        .map(i64::to_string)
                        .collect::<Vec<_>>()
                        .join(",")
                );
                false
            }
        };
        ledger.mark_read_result(&done_again, ok, deps.now());
    }
    Ok(out)
}

/// 이 배치에서 스레드 임대까지 갈 것이 확실한 스레드들의 임대를 한꺼번에 잡는다(스레드 열쇠 → 잡은 결과).
///
/// 고르는 기준은 본 루프의 앞쪽 판정과 같되 **읽기만** 한다: 글이 있고, 장부 관문을 지나고([`Ledger::would_proceed`]),
/// 조종 중이 아니고, 이 프로세스가 그 스레드를 돌리고 있지 않다(장부·레지스트리 — 돌고 있는 스레드는 서버에 묻지 않는다).
/// 같은 스레드는 한 번만 넣는다. 둘 이상일 때만 미리 잡는다 — 하나면 본 루프가 제 차례에 잡는 것과 같다.
/// 여기서 빠진 entry 는 본 루프가 전처럼 제 차례에 잡고, 잡았는데 쓰이지 않은 것은 본 루프 끝에서 놓는다.
fn prefetch_claims(
    ledger: &Ledger,
    deps: &mut dyn AdmitDeps,
    batch: &Value,
    entries: &[Value],
    held: &HashSet<i64>,
) -> HashMap<String, ClaimHold> {
    let now = deps.now();
    let mut keys: Vec<String> = Vec::new();
    let mut wants: Vec<(String, String)> = Vec::new();
    for entry in entries {
        let Some(mention) = message_for(batch, entry) else {
            continue;
        };
        if !ledger.would_proceed(entry_id(entry), now, held) {
            continue;
        }
        let channel = str_of(mention, "channelId");
        let anchor = mention_anchor(mention);
        let key = thread_key(channel, Some(anchor));
        if keys.contains(&key)
            || deps.control_of(&key).is_some()
            || ledger.thread_in_flight(&key)
            || deps.registry_busy(&key)
        {
            continue;
        }
        keys.push(key);
        wants.push((channel.to_string(), anchor.to_string()));
    }
    if wants.len() < 2 {
        return HashMap::new();
    }
    let holds = deps.hold_claims(&wants);
    keys.into_iter().zip(holds).collect()
}

/// 정본 `noticeBlocked` — 사람이 부른 멘션이 같은 스레드 앞 턴 때문에 밀렸으면 entry 당 1회 알린다.
fn notice_blocked(
    ledger: &mut Ledger,
    deps: &mut dyn AdmitDeps,
    entry: &Value,
    mention: &Value,
    anchor: &str,
    ctx: &BatchContext,
) {
    if !is_blocked_notice_reason(str_of(entry, "reason")) {
        return;
    }
    // 사람 글인지 모르면(에이전트 글이면) 알리지 않는다 — 에이전트끼리의 부름에 잡음을 얹지 않는다.
    // 명단이 비었으면(계정 목록을 못 받았으면) 모르는 것으로 본다(정본 `!ctx.agentIds`).
    if ctx.agent_ids.is_empty() && ctx.human_ids.is_empty()
        || ctx.agent_ids.contains(str_of(mention, "authorId"))
    {
        return;
    }
    if !ledger.note_blocked(entry_id(entry)) {
        return;
    }
    if let Err(e) = deps.notice(
        str_of(mention, "channelId"),
        anchor,
        &AdmitNotice::BlockedByTurn,
    ) {
        eprintln!(
            "  {} 앞 턴 대기 통지 발화 실패(멘션은 그대로 기다린다): {e}",
            str_of(entry, "messageId")
        );
    }
}

#[cfg(test)]
#[path = "mention_admit_tests.rs"]
mod tests;
