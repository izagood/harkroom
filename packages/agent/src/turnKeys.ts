/**
 * 턴 열쇠 — 하네스 아래에 주는 좁은 턴 자격(오퍼레이터 쪽 장부는 `operator/src/turnKeys.ts`).
 *
 * 러너는 하네스를 띄울 때마다 열쇠 둘을 새로 만든다:
 * - `bridge`: harkroom MCP 다리만 받는다. 셸 env 에는 두지 않고, 하네스가 MCP 자식에게만 넘기는 자리로 준다(`turn.ts`).
 * - `shell`: 하네스 env(`RUNNER_TURN_KEY_ENV.shell`)로 셸·hook·래퍼가 본다.
 *
 * 띄우기 전에 relay 로 오퍼레이터에 맡기고(`register`), 답이 200 이 아니면 **띄우지 않는다**(닫히는 쪽).
 * 하네스가 끝나면 지운다(`end`). 끝내기를 놓쳐도 오퍼레이터가 12시간 뒤에 쓴다.
 */
import { randomBytes } from 'node:crypto';
import { TURN_KEYS_END_PATH, TURN_KEYS_PATH } from '@harkroom/shared/runnerLink';

export interface TurnKeys {
  bridge: string;
  shell: string;
}

/** 32바이트 난수 둘(hex 64자). */
export function issueTurnKeys(): TurnKeys {
  return { bridge: randomBytes(32).toString('hex'), shell: randomBytes(32).toString('hex') };
}

/** 열쇠 값을 기록·로그 가림 목록에 넣을 때 쓴다(security K3). */
export function turnKeyValues(keys: TurnKeys | null | undefined): string[] {
  return keys ? [keys.bridge, keys.shell] : [];
}

export interface TurnKeyLink {
  request(req: { type: 'http.forward'; method: string; path: string; body?: string; contentType?: string }): Promise<{ status: number }>;
}

/** 맡기지 못했다 — 그 턴은 띄우지 않는다. 문장에 열쇠 값을 싣지 않는다. */
export class TurnKeyRegisterError extends Error {
  constructor(readonly status: number | null) {
    super(`턴 자격을 오퍼레이터에 맡기지 못했다(${status ?? 'link'}) — 오퍼레이터가 이 판을 모르면 앱을 업데이트하라`);
    this.name = 'TurnKeyRegisterError';
  }
}

export async function registerTurnKeys(link: TurnKeyLink, turn: { turnId: string; cause: string | null; keys: TurnKeys }): Promise<void> {
  let status: number | null = null;
  try {
    const res = await link.request({
      type: 'http.forward', method: 'POST', path: TURN_KEYS_PATH, contentType: 'application/json',
      body: JSON.stringify({ turnId: turn.turnId, cause: turn.cause, keys: turn.keys }),
    });
    status = res.status;
  } catch {
    throw new TurnKeyRegisterError(null);
  }
  if (status !== 200) throw new TurnKeyRegisterError(status);
}

/** 실패는 삼킨다 — 오퍼레이터가 수명 상한으로 쓴다. */
export async function endTurnKeys(link: TurnKeyLink, turnId: string): Promise<void> {
  await link.request({
    type: 'http.forward', method: 'POST', path: TURN_KEYS_END_PATH, contentType: 'application/json',
    body: JSON.stringify({ turnId }),
  }).catch(() => undefined);
}
