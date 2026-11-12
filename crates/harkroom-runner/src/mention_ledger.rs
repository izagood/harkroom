//! 정본 `createMentionScheduler` 의 장부(B4-1b-2a) — admit 이 entry 를 거르는 순서, 재시도·관문·임대 대기 회계,
//! 끝난 entry 표, 같은 사람 멘션 묶기. 서버 호출·턴 띄우기·통지는 하지 않는다 — 그것은 B4-1b-2b 가 이 위에 얹는다.
//!
//! 시각은 모두 호출자가 준 `now`(ms)다. 정본의 `Map` 순회 순서(넣은 순)는 `done_entries` 에서만 밖으로 보이므로
//! 그 표만 넣은 순서를 지킨다.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

use crate::mention_scheduler::{
    BLOCKED_NOTICED_MAX, BUNDLE_MAX_ENTRIES, BUNDLE_MAX_FAILURES, DONE_UNREAD_MAX_MS,
    GATE_REQUEUE_MAX, GATE_WAIT_MAX_MS, LEASE_RETRY_MS, LEASE_WAIT_MAX_MS, RECENTLY_DONE_MS,
    backoff_for, is_plain_mention,
};
use crate::poll_loop::BatchContext;

/// 한 번에 묶어 싣는 본문 글자 수 상한(정본 `BUNDLE_MAX_CHARS = DELTA_MAX_CHARS / 2`, `prompt.ts` 60,000).
pub const BUNDLE_MAX_CHARS: usize = 30_000;

/// 정본 `mentionAnchor` — 스레드 안이면 그 루트, 채널 최상위면 그 멘션 자신.
pub fn mention_anchor(mention: &Value) -> &str {
    mention
        .get("threadRootId")
        .and_then(Value::as_str)
        .or_else(|| mention.get("id").and_then(Value::as_str))
        .unwrap_or_default()
}

/// 정본 `SessionStore.threadKey`.
pub fn thread_key(channel_id: &str, thread_root_id: Option<&str>) -> String {
    format!("{channel_id}/{}", thread_root_id.unwrap_or("_root"))
}

/// 멘션 줄 하나의 스레드 키(앵커 기준).
pub fn mention_thread_key(mention: &Value) -> String {
    let channel = mention
        .get("channelId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    thread_key(channel, Some(mention_anchor(mention)))
}

/// 항목별 시도 횟수·다음 시도 가능 시각·재시도 통지를 이미 했는가.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Attempt {
    pub tried: u32,
    pub not_before: u64,
    pub noticed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateWait {
    pub config_dir: String,
    pub since: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GateRequeue {
    pub count: u32,
    pub since: u64,
}

/// admit 앞쪽 관문(스레드를 보기 전)의 판정.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreGate {
    /// 스레드 판정으로 넘어간다.
    Proceed,
    /// 이번 폴엔 띄우지 않는다(백오프·관문 대기·도는 중·이관 보류).
    Blocked,
    /// 아무것도 하지 않는다(끝내고 읽음까지 한 것).
    Skip,
    /// 턴 없이 읽음 처리만(관문 대기 상한을 넘김 — 정본 `orphans`).
    MarkRead,
    /// 끝났는데 읽음 처리만 남은 것 — 배치 끝에 한 번에 다시 읽음 처리(정본 `doneAgain`).
    DoneAgain,
}

/// 계정 관문 때문에 턴을 접었을 때의 판정.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateRequeueOutcome {
    /// 다시 띄운다(`queued` 면 표식이 지워진 뒤).
    Requeue { count: u32 },
    /// 안전판 — 더 띄우지 않고 읽음 처리한다.
    GiveUp { count: u32 },
}

/// 정본 `createMentionScheduler` 의 인메모리 표들.
#[derive(Debug, Default)]
pub struct Ledger {
    attempts: HashMap<i64, Attempt>,
    gate_waits: HashMap<i64, GateWait>,
    gate_requeues: HashMap<i64, GateRequeue>,
    lease_waits: HashMap<i64, u64>,
    in_flight_entries: HashSet<i64>,
    in_flight_threads: HashSet<String>,
    blocked_noticed: HashSet<i64>,
    blocked_noticed_order: VecDeque<i64>,
    /// 넣은 순서를 지킨다(`done_entries`).
    done_unread: Vec<(i64, u64)>,
    recently_done: HashMap<i64, u64>,
    bundles: HashMap<i64, Vec<i64>>,
}

impl Ledger {
    /// 앞 세대가 끝냈는데 읽음 처리만 못 한 entry(정본 `handoverDone`)는 처음부터 「끝났다」로 둔다 — 시각은 지금.
    pub fn new(handover_done: &[i64], now: u64) -> Self {
        let mut l = Self::default();
        for &id in handover_done {
            l.set_done_unread(id, now);
        }
        l
    }

    fn set_done_unread(&mut self, id: i64, at: u64) {
        if !self.done_unread.iter().any(|(i, _)| *i == id) {
            self.done_unread.push((id, at));
        }
    }

    fn is_done_unread(&self, id: i64) -> bool {
        self.done_unread.iter().any(|(i, _)| *i == id)
    }

    pub fn attempt(&self, id: i64) -> Option<Attempt> {
        self.attempts.get(&id).copied()
    }

    pub fn gate_wait(&self, id: i64) -> Option<&GateWait> {
        self.gate_waits.get(&id)
    }

    pub fn gate_requeue_of(&self, id: i64) -> Option<GateRequeue> {
        self.gate_requeues.get(&id).copied()
    }

    /// 정본 `pruneDoneUnread` — 상한을 넘긴 끝난 entry 를 표에서 지운다. 폴마다 한 번.
    pub fn prune(&mut self, now: u64) {
        self.done_unread
            .retain(|(_, since)| now.saturating_sub(*since) <= DONE_UNREAD_MAX_MS);
        self.recently_done
            .retain(|_, since| now.saturating_sub(*since) <= RECENTLY_DONE_MS);
    }

    /// admit 앞쪽 관문(정본 순서 그대로: 백오프 → 관문 대기 → 끝남·읽음 남음 → 최근 끝남 → 도는 중 → 이관 보류).
    /// `attention_active(configDir)` 는 그 계정의 관문 표식이 아직 있는가 — 실패는 「없음」으로 준다(정본 `.catch(() => false)`).
    pub fn pre_gate(
        &mut self,
        id: i64,
        now: u64,
        held: &HashSet<i64>,
        attention_active: &mut dyn FnMut(&str) -> bool,
    ) -> PreGate {
        // 관문 0: 실패 백오프 — 읽기만 한다. 증가는 모든 관문 뒤다.
        if self.attempts.get(&id).is_some_and(|r| r.not_before > now) {
            return PreGate::Blocked;
        }
        if let Some(gw) = self.gate_waits.get(&id) {
            if now.saturating_sub(gw.since) > GATE_WAIT_MAX_MS {
                self.gate_waits.remove(&id);
                self.gate_requeues.remove(&id);
                self.attempts.remove(&id);
                return PreGate::MarkRead;
            }
            if attention_active(&gw.config_dir) {
                return PreGate::Blocked;
            }
            self.gate_waits.remove(&id);
        }
        if self.is_done_unread(id) {
            return PreGate::DoneAgain;
        }
        if self.recently_done.contains_key(&id) {
            return PreGate::Skip;
        }
        if self.in_flight_entries.contains(&id) || held.contains(&id) {
            return PreGate::Blocked;
        }
        PreGate::Proceed
    }

    /// 이 프로세스 안에서 그 스레드에 턴을 띄우기로 이미 정했는가(정본 `inFlightThreads`). 레지스트리 판정은 호출자가 더한다.
    pub fn thread_in_flight(&self, key: &str) -> bool {
        self.in_flight_threads.contains(key)
    }

    /// 앞 턴 대기 통지를 이 entry 에 처음 하는가(entry 당 1회). 상한을 넘으면 오래된 것부터 잊는다.
    pub fn note_blocked(&mut self, id: i64) -> bool {
        if !self.blocked_noticed.insert(id) {
            return false;
        }
        self.blocked_noticed_order.push_back(id);
        while self.blocked_noticed.len() > BLOCKED_NOTICED_MAX {
            match self.blocked_noticed_order.pop_front() {
                Some(old) => {
                    self.blocked_noticed.remove(&old);
                }
                None => break,
            }
        }
        true
    }

    fn forget_blocked(&mut self, id: i64) {
        if self.blocked_noticed.remove(&id) {
            self.blocked_noticed_order.retain(|x| *x != id);
        }
    }

    /// 정본 `canJoinBundle` — 혼자서도 지금 뜰 수 있는 entry 인가(앞쪽 관문을 읽기만 한다).
    pub fn can_join_bundle(&self, id: i64, now: u64, held: &HashSet<i64>) -> bool {
        if self
            .attempts
            .get(&id)
            .is_some_and(|r| r.not_before > now || r.tried >= BUNDLE_MAX_FAILURES)
        {
            return false;
        }
        !self.gate_waits.contains_key(&id)
            && !self.is_done_unread(id)
            && !self.recently_done.contains_key(&id)
            && !self.in_flight_entries.contains(&id)
            && !held.contains(&id)
    }

    /// 정본 `bundleFor` — `entry` 와 한 턴으로 묶을 entry 들의 `batch.entries` 색인(오래된 순, 끝이 대표).
    /// 묶을 수 없으면 `[entry_idx]` 하나다.
    pub fn bundle_for(
        &self,
        batch: &Value,
        entry_idx: usize,
        ctx: &BatchContext,
        now: u64,
        held: &HashSet<i64>,
    ) -> Vec<usize> {
        let entries = batch
            .get("entries")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let Some(entry) = entries.get(entry_idx) else {
            return vec![entry_idx];
        };
        let Some(mention) = message_for(batch, entry) else {
            return vec![entry_idx];
        };
        let lead_id = entry_id(entry);
        if !is_plain_mention(entry, mention)
            || self.attempts.get(&lead_id).map_or(0, |a| a.tried) >= BUNDLE_MAX_FAILURES
        {
            return vec![entry_idx];
        }
        let author = mention.get("authorId").and_then(Value::as_str);
        let key = mention_thread_key(mention);
        let cause = entry.get("causeKey").filter(|v| !v.is_null());
        let author_is_human = author.is_some_and(|a| ctx.human_ids.contains(a));
        // 턴 임대는 대표 글 하나에서 나온다. 에이전트 글은 원인 키가 같을 때만, 키가 없으면 사람으로 확인된 글만 묶는다.
        let same_cause = |other: &Value| {
            let oc = other.get("causeKey").filter(|v| !v.is_null());
            if cause.is_some() || oc.is_some() {
                return cause == oc;
            }
            author_is_human
        };
        let mut group = vec![entry_idx];
        let mut chars = body_chars(mention);
        for (i, other) in entries.iter().enumerate() {
            if group.len() >= BUNDLE_MAX_ENTRIES {
                break;
            }
            let oid = entry_id(other);
            if oid <= lead_id {
                continue;
            }
            let Some(row) = message_for(batch, other) else {
                continue;
            };
            if row.get("authorId").and_then(Value::as_str) != author
                || !same_cause(other)
                || !is_plain_mention(other, row)
                || !self.can_join_bundle(oid, now, held)
            {
                continue;
            }
            if mention_thread_key(row) != key {
                continue;
            }
            // 본문을 다 싣지 못할 글은 넣지 않는다 — 안 실린 글을 읽음 처리하면 #1699 가 돌아온다.
            let len = body_chars(row);
            if chars + len > BUNDLE_MAX_CHARS {
                break;
            }
            chars += len;
            group.push(i);
        }
        group
    }

    /// 관문을 다 지난 묶음을 띄우기로 정한다 — 장부 등록은 동기적으로, 띄우기 전에. 돌려준 값은 대표의 이번 시도 번호.
    /// `group` 은 entry id(오래된 순, 끝이 대표).
    pub fn start(&mut self, group: &[i64], key: &str) -> u32 {
        let lead = *group.last().expect("group is never empty");
        if group.len() > 1 {
            self.bundles.insert(lead, group.to_vec());
            // 관문 재시도 횟수는 구성원의 최대값을 대표가 물려받는다.
            let heaviest = group
                .iter()
                .filter_map(|id| self.gate_requeues.get(id).copied())
                .max_by_key(|r| r.count);
            for id in group {
                self.gate_requeues.remove(id);
            }
            if let Some(h) = heaviest {
                self.gate_requeues.insert(lead, h);
            }
        }
        for &id in group {
            self.in_flight_entries.insert(id);
            self.forget_blocked(id);
        }
        self.in_flight_threads.insert(key.to_string());
        // 유일한 증가 지점. `noticed` 를 보존한다 — 떨어뜨리면 entry 당 1회 통지 약속이 깨진다.
        let prior = self
            .attempts
            .get(&lead)
            .copied()
            .or_else(|| group.iter().find_map(|id| self.attempts.get(id).copied()));
        let tried = group
            .iter()
            .map(|id| self.attempts.get(id).map_or(0, |a| a.tried))
            .max()
            .unwrap_or(0)
            + 1;
        for &id in group {
            if id != lead {
                self.attempts.remove(&id);
            }
        }
        self.attempts.insert(
            lead,
            Attempt {
                tried,
                not_before: 0,
                noticed: prior.is_some_and(|p| p.noticed),
            },
        );
        tried
    }

    /// 정본 `finish` 가 읽음 처리할 id — 묶음이면 구성원 전부(대표 포함).
    pub fn finish_ids(&self, lead: i64) -> Vec<i64> {
        self.bundles
            .get(&lead)
            .cloned()
            .unwrap_or_else(|| vec![lead])
    }

    /// 정본 `finishMany` 의 결말. 성공이면 최근 끝남으로, 실패면 읽음 남음으로(처음 적힌 시각을 지킨다).
    pub fn mark_read_result(&mut self, ids: &[i64], ok: bool, now: u64) {
        if ok {
            for &id in ids {
                self.done_unread.retain(|(i, _)| *i != id);
                self.recently_done.insert(id, now);
            }
        } else {
            for &id in ids {
                self.set_done_unread(id, now);
            }
        }
    }

    /// 턴이 끝나 결말을 냈다(성공·포기·임대 잃음 통지·정지 통지) — 재시도·관문 회계를 지운다.
    pub fn settle(&mut self, lead: i64) {
        self.attempts.remove(&lead);
        self.gate_requeues.remove(&lead);
    }

    /// 턴 임대가 아직 정해지지 않았다(409 `lease_used`·무응답). 상한 안이면 `true` — 조용히 미뤘다 다시 묻는다(시도로 세지 않는다).
    pub fn lease_wait(&mut self, lead: i64, tried: u32, now: u64) -> bool {
        let since = self.lease_waits.get(&lead).copied().unwrap_or(now);
        if now.saturating_sub(since) < LEASE_WAIT_MAX_MS {
            self.lease_waits.insert(lead, since);
            let noticed = self.attempts.get(&lead).is_some_and(|a| a.noticed);
            self.attempts.insert(
                lead,
                Attempt {
                    tried: tried.saturating_sub(1),
                    not_before: now + LEASE_RETRY_MS,
                    noticed,
                },
            );
            return true;
        }
        self.lease_waits.remove(&lead);
        false
    }

    /// 임대가 정해졌다(받았든 상한을 넘겼든) — 대기 표에서 지운다.
    pub fn lease_settled(&mut self, lead: i64) {
        self.lease_waits.remove(&lead);
    }

    /// 실패가 아닌 접힘(스레드 임대 잃음) — 이번 시도를 세지 않고 바로 다시 띄울 수 있게 둔다.
    pub fn uncount(&mut self, lead: i64, tried: u32) {
        let noticed = self.attempts.get(&lead).is_some_and(|a| a.noticed);
        self.attempts.insert(
            lead,
            Attempt {
                tried: tried.saturating_sub(1),
                not_before: 0,
                noticed,
            },
        );
    }

    /// 계정 관문 때문에 접었다. 상한(`GATE_REQUEUE_MAX`·`GATE_WAIT_MAX_MS`)을 넘으면 포기(호출자가 읽음 처리).
    /// `queued_config_dir` 가 있으면 그 계정 표식이 지워질 때까지 기다린다.
    pub fn gate_requeue(
        &mut self,
        lead: i64,
        tried: u32,
        queued_config_dir: Option<&str>,
        now: u64,
    ) -> GateRequeueOutcome {
        let rq = self.gate_requeues.entry(lead).or_insert(GateRequeue {
            count: 0,
            since: now,
        });
        rq.count += 1;
        let rq = *rq;
        if rq.count > GATE_REQUEUE_MAX || now.saturating_sub(rq.since) > GATE_WAIT_MAX_MS {
            self.gate_requeues.remove(&lead);
            self.gate_waits.remove(&lead);
            self.attempts.remove(&lead);
            return GateRequeueOutcome::GiveUp { count: rq.count };
        }
        self.uncount(lead, tried);
        if let Some(dir) = queued_config_dir.filter(|d| !d.is_empty()) {
            self.gate_waits.insert(
                lead,
                GateWait {
                    config_dir: dir.to_string(),
                    since: rq.since,
                },
            );
        }
        GateRequeueOutcome::Requeue { count: rq.count }
    }

    /// 아직 시도가 남은 실패 — 이 entry 만 쉬고 나머지는 흐른다. 돌려준 값은 재시도 통지를 이번에 처음 하는가.
    pub fn retry_later(&mut self, lead: i64, tried: u32, now: u64) -> bool {
        let first = !self.attempts.get(&lead).is_some_and(|a| a.noticed);
        self.attempts.insert(
            lead,
            Attempt {
                tried,
                not_before: now + backoff_for(tried),
                noticed: true,
            },
        );
        first
    }

    /// 정본 `runOne` 의 `finally` — 어떤 길로 끝나든 맨 먼저. 묶음은 한 몸이라 대표의 재시도·관문 대기를 구성원이 같이 진다.
    pub fn release(&mut self, lead: i64, key: &str) {
        let members = self.bundles.remove(&lead).unwrap_or_else(|| vec![lead]);
        let record = self.attempts.get(&lead).copied();
        let gw = self.gate_waits.get(&lead).cloned();
        for id in members {
            self.in_flight_entries.remove(&id);
            if id == lead {
                continue;
            }
            match record {
                Some(r) => {
                    let noticed = self.attempts.get(&id).map_or(r.noticed, |a| a.noticed);
                    self.attempts.insert(id, Attempt { noticed, ..r });
                }
                None => {
                    self.attempts.remove(&id);
                }
            }
            if let Some(g) = &gw {
                self.gate_waits.insert(id, g.clone());
            }
        }
        self.in_flight_threads.remove(key);
    }

    /// 도는 턴이 쥔 entry(정본 `holdingEntries`).
    pub fn holding_entries(&self) -> Vec<i64> {
        let mut v: Vec<i64> = self.in_flight_entries.iter().copied().collect();
        v.sort_unstable();
        v
    }

    /// 끝냈지만 읽음 처리를 못 한 entry(정본 `doneEntries`, 넣은 순).
    pub fn done_entries(&self) -> Vec<i64> {
        self.done_unread.iter().map(|(i, _)| *i).collect()
    }
}

fn entry_id(entry: &Value) -> i64 {
    entry.get("id").and_then(Value::as_i64).unwrap_or(i64::MIN)
}

/// entry 가 가리키는 메시지 줄(정본 `batch.messages.find((m) => m.id === entry.messageId)`).
pub fn message_for<'a>(batch: &'a Value, entry: &Value) -> Option<&'a Value> {
    let mid = entry.get("messageId").and_then(Value::as_str)?;
    batch
        .get("messages")
        .and_then(Value::as_array)?
        .iter()
        .find(|m| m.get("id").and_then(Value::as_str) == Some(mid))
}

/// 정본 `body.length`(UTF-16 단위).
fn body_chars(row: &Value) -> usize {
    row.get("body")
        .and_then(Value::as_str)
        .map_or(0, |s| s.encode_utf16().count())
}

#[cfg(test)]
#[path = "mention_ledger_tests.rs"]
mod tests;
