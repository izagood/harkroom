/**
 * 「매일 기억 정리」 설정 화면(설정 › 일반, 에이전트 › 기억)의 판정 — 화면은 이 결과를 그리기만 한다.
 */
import { MAX_ARCHIVED_MEMORIES } from './memoryList';

/** 워크스페이스의 매일 정리 — `GET·PUT /settings/memory-cleanup`. */
export interface CleanupSchedule { enabled: boolean; time: string; tz: string }

/** 에이전트의 매일 정리. `workspace` 는 그 칸을 싣기 전 서버에는 없다. */
export interface AgentCleanup { enabled: boolean; workspace?: CleanupSchedule }

export type BackgroundKind = 'distill' | 'cleanup' | 'organize';
export interface BackgroundRun {
  id: string; kind: BackgroundKind; status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  summary: string | null; error: string | null; changes: number;
  createdAt: string; finishedAt: string | null; revertedAt: string | null;
}
export interface AgentBackground {
  enabled: boolean; paused: BackgroundKind[]; serverEnabled: boolean; runs: BackgroundRun[];
}
export interface BackgroundChange { slug: string; ops: ('create' | 'update' | 'archive' | 'merge')[] }
export interface RevertResult { reverted: string[]; skipped: { slug: string; reason: string }[] }

/** 서버가 시작 시각부터 흩어 돌리는 폭(`memory_daily` 의 `SPREAD_SECS`). */
export const CLEANUP_SPREAD_MIN = 120;
/** 보관이 이보다 많으면 곧 지워진다고 알린다. */
export const ARCHIVE_NEAR = MAX_ARCHIVED_MEMORIES - 30;

export function validTime(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** 고를 목록. 엔진에 따라 UTC 가 빠져 있어 더한다. */
export function timeZones(): string[] {
  const list = Intl.supportedValuesOf('timeZone');
  return list.includes('UTC') ? list : [...list, 'UTC'];
}

/**
 * 저장 전 검사. 목록에 있으면 통과다. 목록은 엔진마다 별칭(Asia/Kolkata ↔ Asia/Calcutta)이 달라 이름 꼴이고 엔진이 아는
 * 시간대면 함께 받는다 — 마지막 판정은 서버(`bad_tz`)다. `+09:00` 같은 차이 표기는 받지 않는다.
 */
export function validTz(tz: string): boolean {
  if (timeZones().includes(tz)) return true;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

const two = (n: number): string => String(n).padStart(2, '0');
const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const hhmm = (m: number): string => `${two(Math.floor(m / 60) % 24)}:${two(m % 60)}`;

/** `03:00` → `03:00–05:00`. */
export function windowText(time: string): string {
  return `${time}–${hhmm(minutes(time) + CLEANUP_SPREAD_MIN)}`;
}

/** 그 시간대의 벽시계를 UTC 로 읽은 ms. */
function wallMs(at: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(at)) p[type] = Number(value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

/**
 * 다음 창. `day` 는 그 시간대의 날짜(UTC 자정으로 적은 ms), `local` 은 보는 사람의 시각이 다를 때만 있다.
 * 지금이 창 안이면 그 창이다. 회차를 실제로 넣을지는 서버가 정하므로 「돈다」고 말하지 않는다.
 */
export function nextWindow(s: CleanupSchedule, now: number, viewerTz?: string): { day: number; text: string; local: string | null } | null {
  if (!validTime(s.time)) return null;
  try {
    const wall = wallMs(now, s.tz);
    const midnight = Math.floor(wall / 86_400_000) * 86_400_000;
    const start = minutes(s.time) * 60_000;
    const day = wall < midnight + start + CLEANUP_SPREAD_MIN * 60_000 ? midnight : midnight + 86_400_000;
    // 벽시계 → 실제 시각. 일광 절약 경계에서도 맞도록 한 번 더 맞춘다.
    let at = day + start - (wall - now);
    at -= wallMs(at, s.tz) - (day + start);
    const mine = viewerTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const there = Math.round((wallMs(at, mine) - (day + start)) / 60_000);
    const local = there === 0 ? null : windowText(hhmm((((minutes(s.time) + there) % 1440) + 1440) % 1440));
    return { day, text: windowText(s.time), local };
  } catch {
    return null;
  }
}

/** 화면이 보는 멈춤 — 매일 정리 루프는 `paused` 를 보지 않으므로 `cleanup` 은 뺀다. */
export function pausedKinds(paused: readonly BackgroundKind[]): ('distill' | 'organize')[] {
  return (['distill', 'organize'] as const).filter((k) => paused.includes(k));
}
