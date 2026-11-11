//! 회수 중 세대 러너 표(TS `runners.ts` 의 `retiring` 맵·`notePollStopped`·`retiringHoldsInbox`·`reapRetiring`·
//! `retiringRunners`·`records` 의 회수 줄·`spawnRunner` 의 이관 보류 env, s21c-2c-2b).
//!
//! 회수(SIGTERM)를 보낸 앞 세대 러너를 **러너 표와 다른 자리**에 둔다 — 표에 넣으면 조정기에게 「이 에이전트는
//! 러너가 있다」로 보여 교체가 아예 안 일어난다. 여기 적는 것은 순서를 지키기 위한 사실이고, 그 사실을
//! spawn 이 읽는다(앞 세대가 인박스를 쥐고 있으면 `retiring` 으로 거절, 놓았으면 그 보류 목록을 env 로 심는다).
//!
//! 이 모듈은 **신호를 보내지 않는다** — 생사는 부르는 쪽이 `alive` 로 넘긴다(TS `host.kill(pid, 0)`).
//! SIGTERM·장부 쓰기·exit 통지·보류 풀기 배선은 러너 표(`runners.rs`)가 잇는다.
use crate::runner_ledger::{RetiringFacts, RunnerLedgerEntry};
use std::collections::HashMap;

/// 앞 오퍼레이터의 장부에서 이어 받은 사실 — 다음 장부에 회수 줄로 다시 적는다(TS `RetiringLedgerFacts`).
#[derive(Clone, PartialEq)]
pub struct RetiringLedgerFacts {
    pub started_at_ms: i64,
    pub boot_time_sec: Option<i64>,
    pub link_secret: Option<String>,
    pub spawned_by_app_version: Option<String>,
}

impl std::fmt::Debug for RetiringLedgerFacts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RetiringLedgerFacts")
            .field("started_at_ms", &self.started_at_ms)
            .field("boot_time_sec", &self.boot_time_sec)
            .field(
                "link_secret",
                &self.link_secret.as_ref().map(|_| "<redacted>"),
            )
            .field("spawned_by_app_version", &self.spawned_by_app_version)
            .finish()
    }
}

/// 회수 중 러너 한 줄(TS `RetiringEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct RetiringEntry {
    pub pid: i32,
    /// 장부가 아는 옛 러너 id. 없으면(옛 장부) 순서만 지키고 announce·exit 통지는 없다.
    pub incarnation_id: Option<String>,
    /// 러너가 「인박스를 놓았다」고 알린 보류 목록(`runner.pollStopped`). 모르는 세대는 영영 None.
    pub poll_stopped: Option<RetiringFacts>,
    pub ledger: Option<RetiringLedgerFacts>,
}

/// 물러난 러너를 지운 결과 — 부르는 쪽이 exit 통지·보류 풀기를 낸다(TS `reapRetiring` 의 뒷부분).
#[derive(Debug, Clone, PartialEq)]
pub struct Reaped {
    pub agent_id: String,
    /// 있으면 이 id 로 exit 통지(code·signal 모름)를 낸다.
    pub incarnation_id: Option<String>,
    /// 그 에이전트의 회수 중 러너가 다 물러났고 보류를 심었던 적이 있다 — 지금 러너에 보류 풀기를 알린다.
    pub release_handover: bool,
}

#[derive(Debug, Default)]
pub struct RetiringSet {
    by_agent: HashMap<String, Vec<RetiringEntry>>,
}

impl RetiringSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// 회수 줄을 적는다(TS `retire` 의 표 부분). 같은 pid 는 갈아 끼운다 — 한 에이전트에 여럿을 둔다
    /// (판이 연달아 바뀌면 앞 오퍼레이터가 회수하던 러너와 지금 러너가 함께 넘어온다).
    pub fn insert(&mut self, agent_id: &str, entry: RetiringEntry) {
        let list = self.by_agent.entry(agent_id.to_string()).or_default();
        list.retain(|e| e.pid != entry.pid);
        list.push(entry);
    }

    /// 러너가 인박스를 놓았다고 알렸다(TS `notePollStopped`). id 로 찾는다. 바뀌었으면 true(장부를 다시 쓴다).
    pub fn note_poll_stopped(
        &mut self,
        agent_id: &str,
        incarnation_id: &str,
        holding: &[i64],
        done: &[i64],
    ) -> bool {
        let Some(e) = self.by_agent.get_mut(agent_id).and_then(|l| {
            l.iter_mut()
                .find(|e| e.incarnation_id.as_deref() == Some(incarnation_id))
        }) else {
            return false;
        };
        e.poll_stopped = Some(RetiringFacts {
            holding: holding.to_vec(),
            done: done.to_vec(),
        });
        true
    }

    /// 그 에이전트의 앞 세대가 아직 인박스를 쥐고 있으면 그 pid(TS `retiringHoldsInbox`).
    /// 죽은 것은 지우고 `reaped` 에 더한다 — 남겨 두면 그 에이전트는 영원히 교체를 거절받는다.
    pub fn holds_inbox(
        &mut self,
        agent_id: &str,
        alive: impl Fn(i32) -> bool,
        reaped: &mut Vec<Reaped>,
    ) -> Option<i32> {
        let snapshot = self.by_agent.get(agent_id).cloned().unwrap_or_default();
        for e in snapshot {
            if !alive(e.pid) {
                if let Some(r) = self.reap(agent_id, e.pid) {
                    reaped.push(r);
                }
                continue;
            }
            // 살아 있어도 폴을 놓았으면 인박스는 비어 있다. 남은 턴은 저쪽이 마저 끝낸다.
            if e.poll_stopped.is_some() {
                continue;
            }
            return Some(e.pid);
        }
        None
    }

    /// 죽은 회수 줄을 모두 거둔다(TS `pollAdopted` 앞부분).
    pub fn reap_dead(&mut self, alive: impl Fn(i32) -> bool) -> Vec<Reaped> {
        let dead: Vec<(String, i32)> = self
            .by_agent
            .iter()
            .flat_map(|(a, l)| l.iter().map(move |e| (a.clone(), e.pid)))
            .filter(|(_, pid)| !alive(*pid))
            .collect();
        dead.into_iter()
            .filter_map(|(a, pid)| self.reap(&a, pid))
            .collect()
    }

    /// 한 줄을 지운다 — 지우는 것과 알리는 것이 같은 자리라 어느 쪽이 먼저 발견하든 한 번이다(TS `reapRetiring`).
    fn reap(&mut self, agent_id: &str, pid: i32) -> Option<Reaped> {
        let list = self.by_agent.get_mut(agent_id)?;
        let i = list.iter().position(|e| e.pid == pid)?;
        let any_stopped = list.iter().any(|e| e.poll_stopped.is_some());
        let entry = list.remove(i);
        let empty = list.is_empty();
        if empty {
            self.by_agent.remove(agent_id);
        }
        Some(Reaped {
            agent_id: agent_id.to_string(),
            incarnation_id: entry.incarnation_id,
            // 회수 중인 러너가 아직 남았으면 풀지 않는다 — 보류는 그 러너들의 턴도 담고 있다.
            release_handover: empty && any_stopped,
        })
    }

    /// pid → 장부의 커널 시작 시각. 생사를 `kill(pid,0)` 에 더해 시작 시각으로 대조하려고 부르는 쪽이 쓴다.
    pub fn boot_times(&self) -> HashMap<i32, Option<i64>> {
        self.by_agent
            .values()
            .flatten()
            .map(|e| (e.pid, e.ledger.as_ref().and_then(|l| l.boot_time_sec)))
            .collect()
    }

    /// 회수를 보냈고 아직 살아 있는, id 를 아는 러너들 — hello 의 announce 에 실린다(TS `retiringRunners`).
    pub fn announce(&self, alive: impl Fn(i32) -> bool) -> Vec<(String, i32, String)> {
        let mut out: Vec<(String, i32, String)> = self
            .by_agent
            .iter()
            .flat_map(|(a, l)| {
                l.iter().filter_map(move |e| {
                    e.incarnation_id
                        .as_ref()
                        .map(|id| (a.clone(), e.pid, id.clone()))
                })
            })
            .filter(|(_, pid, _)| alive(*pid))
            .collect();
        out.sort();
        out
    }

    /// 교체 러너에 심을 이관 보류 env(TS `spawnRunner` 의 `HARKROOM_HANDOVER_HOLD`·`_DONE`).
    /// 회수 중 러너가 여럿이면 모두의 보류를 합친다. 끝남에서는 보류에 든 것을 뺀다 —
    /// 섞으면 보류 시한 뒤 끝난 일에 두 번째 턴이 선다.
    pub fn handover_env(&self, agent_id: &str) -> Vec<(String, String)> {
        let mut hold: Vec<i64> = Vec::new();
        let mut done: Vec<i64> = Vec::new();
        for p in self
            .by_agent
            .get(agent_id)
            .into_iter()
            .flatten()
            .filter_map(|e| e.poll_stopped.as_ref())
        {
            for n in &p.holding {
                if !hold.contains(n) {
                    hold.push(*n);
                }
            }
            for n in &p.done {
                if !done.contains(n) {
                    done.push(*n);
                }
            }
        }
        done.retain(|n| !hold.contains(n));
        let join = |v: &[i64]| {
            v.iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(",")
        };
        let mut env = Vec::new();
        if !hold.is_empty() {
            env.push(("HARKROOM_HANDOVER_HOLD".to_string(), join(&hold)));
        }
        if !done.is_empty() {
            env.push(("HARKROOM_HANDOVER_DONE".to_string(), join(&done)));
        }
        env
    }

    /// 장부에 더할 회수 줄(TS `records` 의 뒷부분). id·장부 사실을 모르는 줄과 표에 있는 pid 는 적지 않는다.
    pub fn ledger_rows(
        &self,
        table_pids: &[i32],
        nonce: &str,
        app_version: Option<&str>,
    ) -> Vec<RunnerLedgerEntry> {
        let mut rows: Vec<RunnerLedgerEntry> = Vec::new();
        for (agent_id, list) in &self.by_agent {
            for e in list {
                let (Some(id), Some(l)) = (&e.incarnation_id, &e.ledger) else {
                    continue;
                };
                if table_pids.contains(&e.pid) {
                    continue;
                }
                rows.push(RunnerLedgerEntry {
                    agent_id: agent_id.clone(),
                    pid: e.pid,
                    incarnation_id: id.clone(),
                    link_secret: l.link_secret.clone().filter(|s| !s.is_empty()),
                    started_at_ms: l.started_at_ms,
                    boot_time_sec: l.boot_time_sec,
                    spawned_by_nonce: nonce.to_string(),
                    // 그 러너를 띄운 세대를 그대로 잇는다(출처 표시). 모르면 이 오퍼레이터 세대(TS run.ts ledgerSink).
                    spawned_by_app_version: l
                        .spawned_by_app_version
                        .clone()
                        .or_else(|| app_version.map(str::to_string)),
                    retiring: Some(e.poll_stopped.clone().unwrap_or_default()),
                });
            }
        }
        rows.sort_by_key(|r| r.started_at_ms);
        rows
    }
}

#[cfg(test)]
mod tests;
