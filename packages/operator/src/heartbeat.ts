/**
 * 오퍼레이터 박동(원격 호스트 관리 P3a, 스레드 3b0f0255) — 서버 `status` 프레임의 본문을 만든다.
 *
 * 서버는 받은 것을 화이트리스트로 다시 고른다(`parseOperatorStatus`). 그래도 여기서부터 **값을 싣지 않는다**:
 * 자격 증명 칸은 이 PR 에서 보내지 않는다(이름을 무엇으로 채울지는 원격 로그인 P6 에서 정한다, security n3).
 *
 * 머신 값은 `/etc/machine-id`(리눅스) · IOPlatformUUID(맥)의 sha256 hex 다. **원래 값은 보내지 않는다** —
 * 서버가 이것을 소유자 id 와 다시 섞어 저장한다(`operator.machine_id`).
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { freemem, platform, totalmem } from 'node:os';
import type { OperatorPlatform, OperatorStatus } from '@harkroom/shared';

/** 박동 주기. 서버는 이보다 촘촘한 박동을 거른다(`STATUS_MIN_INTERVAL_MS`). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatSources {
  startedAt: Date;
  /** 지금 쥔 턴 자리와 상한(`turnSlots`). 상한이 없으면 max null. */
  turns(): { running: number; max: number | null };
  /** runnerId → 그 러너가 쥔 턴 자리 수. */
  turnsByRunner(): Map<string, number>;
  /** 살아 있는 러너의 runnerId → agentId. */
  runners(): { runnerId: string; agentId: string }[];
  /** 디스크 여유를 잴 경로(오퍼레이터 데이터 디렉터리). */
  dataDir: string;
}

const PLATFORMS = new Set<string>(['darwin', 'linux', 'win32']);

export async function collectStatus(src: HeartbeatSources): Promise<OperatorStatus> {
  const status: OperatorStatus = {
    startedAt: src.startedAt.toISOString(),
    turns: src.turns(),
    memory: { totalBytes: totalmem(), freeBytes: Math.min(freemem(), totalmem()) },
  };
  const os = platform();
  if (PLATFORMS.has(os)) status.platform = os as OperatorPlatform;
  try {
    const fs = await statfs(src.dataDir);
    const total = fs.blocks * fs.bsize;
    const free = Math.min(fs.bavail * fs.bsize, total);
    if (Number.isSafeInteger(total) && Number.isSafeInteger(free)) status.disk = { totalBytes: total, freeBytes: free };
  } catch { /* 못 재면 칸을 뺀다 — 서버도 화면도 "모름"으로 그린다 */ }
  const byRunner = src.turnsByRunner();
  const perAgent = new Map<string, number>();
  for (const r of src.runners()) perAgent.set(r.agentId, (perAgent.get(r.agentId) ?? 0) + (byRunner.get(r.runnerId) ?? 0));
  status.runners = [...perAgent].map(([agentId, turns]) => ({ agentId, turns }));
  return status;
}

/** 머신 고유값을 읽어 sha256 hex 로. 못 읽으면 null(박동은 머신 값 없이 간다). */
export async function readMachineDigest(
  os: string = platform(),
  read: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
  ioreg: () => Promise<string> = () => new Promise((resolve, reject) =>
    execFile('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5_000 }, (err, out) => (err ? reject(err) : resolve(out)))),
): Promise<string | null> {
  let raw: string | null = null;
  try {
    if (os === 'linux') {
      raw = (await read('/etc/machine-id').catch(() => read('/var/lib/dbus/machine-id'))).trim();
    } else if (os === 'darwin') {
      raw = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(await ioreg())?.[1] ?? null;
    }
  } catch { raw = null; }
  if (!raw) return null;
  // 접두를 섞는다 — 같은 machine-id 를 다른 용도로 해시한 값과 겹치지 않게.
  return createHash('sha256').update(`harkroom-operator-machine:${raw}`).digest('hex');
}
