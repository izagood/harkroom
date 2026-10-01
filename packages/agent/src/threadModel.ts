/**
 * 이 턴이 쓸 모델·effort — 스레드 × 에이전트 지정(서버 079)을 에이전트 설정 위에 얹는다.
 *
 * 서버가 계산한 실효값(`GET /agent/thread-model`)을 그대로 쓴다. 여기서 다시 합치지 않는 이유:
 * 서버는 같은 값으로 발화의 모델 어긋남을 판정한다(`reportedModel.ts`) — 둘이 다르게 계산하면
 * 지정대로 답한 발화가 "어긋남" 으로 뜬다.
 *
 * **물러나는 곳은 정의(`def`)다.** 옛 서버(404)·링크 오류면 지정을 모르는 것이고, 그때는 지금까지
 * 처럼 에이전트 설정으로 돈다. 턴을 막지 않는다 — 지정은 비용을 고르는 손잡이지 턴의 성패가 아니다.
 * 대신 조용히 삼키지 않고 로그에 남긴다.
 */
export interface TurnModel {
  model: string | null;
  effort: string | null;
  /** 축마다 어디서 왔나. 실패 통지가 "스레드 지정 모델이 거절됐다" 를 가르는 재료다. */
  source: { model: 'thread' | 'agent'; effort: 'thread' | 'agent' };
}

export interface ThreadModelSource {
  threadModel?(messageId: string): Promise<TurnModel>;
}

export async function resolveTurnModel(
  harkroom: ThreadModelSource,
  def: { model: string | null; effort: string | null },
  messageId: string | null,
  log: (line: string) => void = (line) => console.error(line),
): Promise<TurnModel> {
  const fromDef: TurnModel = { model: def.model, effort: def.effort, source: { model: 'agent', effort: 'agent' } };
  if (!messageId || !harkroom.threadModel) return fromDef;
  try {
    const got = await harkroom.threadModel(messageId);
    // **러너도 모양을 본다**(security #967 ② 의 한 겹 더). 서버가 이미 막지만 이 값은 argv 로
    // 가므로, 모양이 틀린 축은 쓰지 않고 정의로 물러난다 — `-` 로 시작하면 다른 플래그가 된다.
    const model = got.source.model === 'thread' && !safeAxis(got.model) ? def.model : got.model;
    const effort = got.source.effort === 'thread' && !safeAxis(got.effort) ? def.effort : got.effort;
    if (model !== got.model || effort !== got.effort) {
      log(`[threadModel] ${messageId}: 스레드 지정 값의 모양이 틀려 그 축은 에이전트 설정으로 돈다`);
      return {
        model, effort,
        source: { model: model === got.model ? got.source.model : 'agent', effort: effort === got.effort ? got.source.effort : 'agent' },
      };
    }
    return got;
  } catch (err: unknown) {
    log(`[threadModel] ${messageId}: 스레드 모델 지정을 못 읽어 에이전트 설정으로 돈다 — ${err instanceof Error ? err.message : String(err)}`);
    return fromDef;
  }
}

/** 서버 `AXIS_PATTERN` 과 같은 모양(영숫자 시작, 영숫자·._:/[]-). null 은 "지정 없음" 이라 통과. */
const AXIS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/;
function safeAxis(v: string | null): boolean {
  return v === null || AXIS_PATTERN.test(v);
}

/** 스레드에 지정된 축이 하나라도 있나. */
export function usesThreadModel(m: TurnModel | null | undefined): boolean {
  return !!m && (m.source.model === 'thread' || m.source.effort === 'thread');
}

/** 세션 키(`${channelId}/${root|_root}`)에서 스레드 루트. 채널 최상위 세션이면 null. */
export function rootFromThreadKey(key: string): string | null {
  const root = key.slice(key.indexOf('/') + 1);
  return root && root !== '_root' ? root : null;
}
