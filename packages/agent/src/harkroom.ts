// harkroom 접속 표면. 스펙(§4)이 지정한 에이전트 표면은 MCP 이므로 그것만 쓴다 — inbox 롱폴은
// MCP `inbox.poll` 에만 있고 REST `/inbox` 에는 없다.
//
// 이 러너를 만들면서 MCP 표면에 구멍이 하나 드러났다: 미읽음을 소비하는 도구가 없어서 같은
// 멘션에 영원히 반복 응답했다. `inbox.read` 를 추가해 닫았고, 그래서 여기 REST 호출이 없다.
//
// **서버는 여기 없다**(스펙 2026-09-20 §5). 이 클라이언트가 아는 것은 오퍼레이터 링크 하나다:
// MCP 는 링크 위의 트랜스포트(`mcp.request`)로, 몇 안 되는 REST(`/agent/config` 등)는
// `http.forward` 로 간다. 인증(오퍼레이터 토큰 + `X-Harkroom-Agent`)은 오퍼레이터가 붙인다 —
// 그래서 이 파일에 PAT 도 URL 도 없다.
import type { TurnModel } from './threadModel.js';
import type { RecallHit, RecallResult } from './memoryPin.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AccountView, AgentView, InboxEntry, MessageRow } from '@harkroom/shared';
import type { RelayClient } from './relay.js';
import { HARKROOM_ERROR_SOURCE } from './policy.js';
import { VERSION } from './version.js';

/** 이 클라이언트가 링크에서 쓰는 표면. `RelayClient` 가 그대로 맞는다 — 테스트는 가짜를 준다. */
export type RunnerLink = Pick<RelayClient, 'request' | 'mcpTransport'>;

export interface Me { id: string; handle: string }

/**
 * 서버가 준 계정 목록에서 **내 이름이 바뀌었는지** 보고, 바뀌었으면 고친다(#847).
 * 바뀐 경우에만 옛 이름을 돌려준다(호출부가 그것으로 로그 한 줄을 남긴다).
 *
 * `main.ts` 가 아니라 여기 있는 이유: `main.ts` 는 top-level await 스크립트라 테스트가
 * 불러올 수 없다. 규칙 하나가 테스트 밖에 있으면 그 규칙은 다음 사람이 옮기다 잃는다.
 *
 * **객체를 갈아끼우지 않고 필드를 고친다.** `me` 를 값으로 받아 둔 자리가 둘이다
 * (`createInteractiveManager` 는 기동 때 한 번 조립되고, `buildTurnDeps` 는 턴마다 읽는다).
 * 새 객체로 바꾸면 앞쪽은 영영 옛 이름을 쥔다 — 그래서 반환값이 새 `Me` 가 아니다.
 *
 * 목록에 내가 없으면 아무 일도 하지 않는다. 그것은 "이름이 지워졌다"가 아니라 대개
 * 목록이 덜 왔다는 뜻이고, 그때 이름을 비우면 프롬프트가 이름 없는 에이전트를 만든다.
 */
export function applySelfRename(me: Me, accounts: readonly { id: string; handle: string }[]): string | null {
  const mine = accounts.find((a) => a.id === me.id);
  if (!mine || mine.handle === me.handle) return null;
  const was = me.handle;
  me.handle = mine.handle;
  return was;
}

export interface InboxBatch {
  entries: InboxEntry[];
  messages: MessageRow[];
  /**
   * 이 배치 시점의 메모리 판본(러너 메모리 캐시, `memoryCache.ts`). 항목이 있는 배치에만
   * 온다. 옛 서버는 안 준다 — 그때 캐시는 매번 받아 온다.
   */
  memoryRev?: string;
}

/**
 * 이 클라이언트가 던지는 에러에 출처와 HTTP status 를 붙인다.
 *
 * `policy.ts::isCredentialFailure` 는 `main.ts` 에서 턴 **전체**를 감싸는 catch 에 쓰이므로,
 * 하네스 실패와 harkroom 호출 실패가 같은 자리로 들어온다. 태그가 없으면 harkroom PAT 만료를
 * "claude CLI 로 로그인해라"로 안내하게 된다(#87).
 *
 * status 를 함께 싣는 이유: 태그만 있으면 판정이 다시 문구 매칭으로 내려간다. status 가
 * 있으면 `isCredentialFailure` 가 401/403 만 보고 끝낸다.
 */
function harkroomError(message: string, status?: number): Error {
  const err = new Error(message) as Error & { source: string; status?: number };
  err.source = HARKROOM_ERROR_SOURCE;
  if (status !== undefined) err.status = status;
  return err;
}

/**
 * MCP **트랜스포트**가 던진 에러도 이 클라이언트의 에러다 — 태그를 붙여 다시 던진다
 * (2026-09-08 14:04 실측).
 *
 * 왜 필요한가: `call()` 은 도구 **결과**의 에러만 태그했고, 폴 루프(`inbox.poll`)는 MCP 전용이라
 * 롱턴에 park 된 러너는 REST 경로를 아예 타지 않는다. 그날 PAT 가 회전되자 러너가 처음 낸
 * 호출은 MCP 였고, 서버는 도구 결과가 아니라 **HTTP 401** 로 답했다 — 그 오류에 `status` 가
 * 없어 `isCredentialFailure` 가 `'other'` 로 읽었고, "401 이면 78 로 물러난다"가 안 지켜졌다.
 *
 * 지금 그 자리는 링크 트랜스포트(`relay.ts::mcpTransport`)가 `mcp.error` 의 `status` 를 실어
 * 던지는 오류다. **문구가 아니라 `status` 로 판정한다** — 서버가 오퍼레이터에게 낸 401/403
 * (토큰 폐기·배정 해제)이 그 숫자 그대로 여기 닿는다. `status: 0` 은 링크가 끊긴 것이라
 * 자격증명이 아니다 — 재접속으로 낫는 실패이고, 폴 루프의 백오프가 담당한다.
 */
function tagTransportError(err: unknown): never {
  const status = (err as { status?: unknown } | null)?.status;
  if (err instanceof Error && typeof status === 'number' && status > 0) {
    throw harkroomError(err.message, status);
  }
  throw err;
}

/**
 * `message.fail` 의 선택 칸들. `code` 는 서버 `FAILURE_CODES` 의 부분집합이다.
 * - `account_gate`(2026-10-02, 서버 0.3.x #1039 부터): 턴 **시작** 때 계정 설정 확인 화면이 사람을
 *   기다린다. `mentionId`(그 턴을 띄운 멘션 — 서버가 차례 주인을 확인한다)·`account`(계정 id 만)와
 *   짝이다. **옛 서버는 모르는 code 값을 거절한다**(키는 걸러지지만 enum 값은 아니다) — 그래서 이
 *   값은 그 서버 릴리스 뒤에만 싣는다.
 */
export interface FailOpts {
  retryable: boolean;
  what?: string;
  reason?: string;
  code?: 'thread_model_rejected' | 'account_gate';
  mentionId?: string;
  account?: string;
}

export class HarkroomAgentClient {
  private mcp: Client | null = null;

  constructor(private link: RunnerLink) {}

  private async connected(): Promise<Client> {
    if (this.mcp) return this.mcp;
    const client = new Client({ name: 'harkroom-agent', version: VERSION });
    await client.connect(this.link.mcpTransport());
    this.mcp = client;
    return client;
  }

  /**
   * REST 한 번 — 오퍼레이터가 `http.forward` 로 서버에 넘긴다. 이 클라이언트가 REST 를 쓰는
   * 자리는 MCP 에 그 표면이 없는 것뿐이다(`definition`·`reportActivity`·`accounts`·
   * `listApprovedSkills`·`recordSkillUse`). 실패는 status 를 실어 던진다 — `isCredentialFailure` 가 읽는다.
   */
  private async rest<T>(method: string, path: string, what: string, body?: unknown): Promise<T> {
    const res = await this.link.request({
      type: 'http.forward', method, path,
      ...(body !== undefined ? { body: JSON.stringify(body), contentType: 'application/json' } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      throw harkroomError(`${what} 실패: ${res.status}${res.status === 0 ? ` (${res.body})` : ''}`, res.status || undefined);
    }
    return (res.body ? JSON.parse(res.body) : undefined) as T;
  }

  /** 서버 재시작·절단 후 다음 호출이 새 세션을 열도록 버린다. */
  reset(): void {
    const old = this.mcp;
    this.mcp = null;
    void old?.close().catch(() => {});
  }

  private async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    // 접속(initialize POST)과 도구 호출이 **같은 try 안**에 있어야 한다 — 401 은 둘 중
    // 어느 쪽에서든 온다(러너는 `reset()` 뒤 다음 호출에서 새로 접속한다).
    let res: Awaited<ReturnType<Client['callTool']>>;
    try {
      const client = await this.connected();
      res = await client.callTool({ name, arguments: args });
    } catch (err) {
      tagTransportError(err);
    }
    const first = (res.content as { type: string; text?: string }[] | undefined)?.[0];
    if (!first || first.type !== 'text' || !first.text) {
      throw harkroomError(`${name}: 텍스트 결과가 없다`);
    }
    const parsed = JSON.parse(first.text) as T & { error?: { code: string; message: string } };
    if (parsed.error) {
      // 도구 **결과**의 에러에는 HTTP status 가 없다 — code 로만 온다. HTTP status 로 오는
      // 실패(자격증명 포함)는 위 `tagTransportError` 가 잡는다.
      throw harkroomError(`${name}: ${parsed.error.code} ${parsed.error.message}`);
    }
    return parsed;
  }

  me(): Promise<Me> {
    return this.call<Me>('account.me');
  }

  /** 서버가 들고 있는 자기 정의(UI 로 수정된다). REST 다 — MCP 에는 이 도구가 없다. */
  definition(): Promise<AgentView> {
    return this.rest<AgentView>('GET', '/agent/config', 'agent/config');
  }

  /**
   * 이 스레드에서 이 에이전트가 쓸 모델·effort(서버 079 의 실효값). `messageId` 는 앵커 아무것이나
   * — 서버가 그 루트를 찾는다. REST 인 이유는 `definition()` 과 같다. 실패는 던진다 — 물러날지는
   * 호출자(`threadModel.ts::resolveTurnModel`)가 정한다.
   */
  threadModel(messageId: string): Promise<TurnModel> {
    return this.rest<TurnModel>('GET', `/agent/thread-model?messageId=${encodeURIComponent(messageId)}`, 'agent/thread-model');
  }

  /**
   * 턴을 마쳤다고 서버에 보고한다(#176). **본문이 없다** — 시각은 서버가 찍는다. 여기서
   * `new Date()` 를 실어 보내면 이 머신의 시계 오차가 그대로 화면의 "마지막 활동"이 된다.
   *
   * REST 인 이유는 `definition()` 과 같다: MCP 에는 이 표면이 없다. 대상 id 를 보내지
   * 않는다 — 서버가 PAT 의 주인만 갱신한다.
   *
   * 실패를 던지는 것은 의도다. 삼키면 호출자가 "보고했다"와 "보고가 실패했다"를 구분하지
   * 못한다 — **턴을 실패로 만들지 않는 판단은 호출자(mentionTurn)의 몫이고**, 거기서
   * 로그로 남긴다(`readMemory` 가 같은 이유로 던진다).
   */
  /**
   * 턴 임대(비밀 보관소 086). 이 멘션에 대해 **한 번만** 받을 수 있다 — 거절(403 not_invoked·409 lease_used)
   * 이든 서버가 보관소를 안 켰든(404·409) 비밀 없이 돌면 되므로 null 이다. 토큰은 어디에도 찍지 않는다.
   */
  async issueTurnLease(causeMessageId: string): Promise<{ id: string; token: string; expiresAt: string } | null> {
    const res = await this.link.request({
      type: 'http.forward', method: 'POST', path: '/agent/turn-leases',
      body: JSON.stringify({ causeMessageId }), contentType: 'application/json',
    });
    if (res.status !== 200 || !res.body) return null;
    try {
      const lease = (JSON.parse(res.body) as { lease?: { id?: unknown; token?: unknown; expiresAt?: unknown } }).lease;
      return lease && typeof lease.id === 'string' && typeof lease.token === 'string' && typeof lease.expiresAt === 'string'
        ? { id: lease.id, token: lease.token, expiresAt: lease.expiresAt } : null;
    } catch {
      return null;
    }
  }

  /**
   * 이 에이전트가 머지해도 되는 저장소(스레드 3deac356). 옛 서버(404)·오류는 빈 목록이다 — allow 규칙이 안
   * 붙을 뿐이고 deny 는 그대로 붙는다(fail-closed 쪽).
   */
  async mergeGrants(): Promise<string[]> {
    try {
      const r = await this.rest<{ repos?: unknown }>('GET', '/agent/merge-grants', 'merge-grants');
      return Array.isArray(r?.repos) ? r.repos.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * 스레드 임대(서버 095, `threadClaims.ts`). 200 잡음(또는 밀음) · 409 남이 쥠 · 404 옛 서버(임대 없음).
   * 그 밖(링크 끊김·5xx)은 던진다 — 확인하지 못한 것이고, 띄울지는 호출자가 정한다(fail-closed).
   */
  async claimThread(channelId: string, threadRootId: string, holder: string, ttlSec: number): Promise<'held' | 'taken' | 'unsupported'> {
    const res = await this.link.request({
      type: 'http.forward', method: 'POST', path: '/agent/thread-claims',
      body: JSON.stringify({ channelId, threadRootId, holder, ttlSec }), contentType: 'application/json',
    });
    if (res.status === 200) return 'held';
    if (res.status === 409) return 'taken';
    if (res.status === 404) return 'unsupported';
    throw harkroomError(`agent/thread-claims 실패: ${res.status}${res.status === 0 ? ` (${res.body})` : ''}`, res.status || undefined);
  }

  async releaseThread(channelId: string, threadRootId: string, holder: string): Promise<void> {
    const res = await this.link.request({
      type: 'http.forward', method: 'POST', path: '/agent/thread-claims/release',
      body: JSON.stringify({ channelId, threadRootId, holder }), contentType: 'application/json',
    });
    // 404 는 옛 서버 — 놓을 것이 처음부터 없었다.
    if ((res.status < 200 || res.status >= 300) && res.status !== 404) {
      throw harkroomError(`agent/thread-claims/release 실패: ${res.status}`, res.status || undefined);
    }
  }

  async reportActivity(): Promise<void> {
    await this.rest<unknown>('POST', '/agent/activity', 'agent/activity');
  }

  /**
   * 워크스페이스 규칙. 러너는 **항상 `mode: 'turn'`** 으로 받는다 — 러너가 띄우는 것은
   * 턴뿐이고, 턴에게 상주용 poll 계약을 주면 그 턴이 인박스를 또 보고 남의 앵커의 요청을
   * 대신 해 버린다(2026-09-08 실측, 서버 `mcp/guide.ts` 머리에 경위가 있다).
   *
   * 서버가 이 인자를 모르는 판본이면(러너가 먼저 배포되는 창) MCP 는 알 수 없는 인자를
   * 무시하고 전문을 준다 — 옛 동작으로 후퇴할 뿐 실패하지 않는다.
   */
  async guide(): Promise<string> {
    const res = await this.call<{ guide?: string } | string>('workspace.guide', { mode: 'turn' });
    return typeof res === 'string' ? res : (res.guide ?? JSON.stringify(res));
  }

  async channels(): Promise<{ id: string; name: string }[]> {
    const res = await this.call<{ channels: { id: string; name: string }[] }>('channel.list');
    return res.channels;
  }

  /**
   * 워크스페이스 전체 계정 목록 — main.ts 가 배치 단위로 한 번 받아 accountId→handle
   * 맵을 채우는 데 쓴다(prompt.ts::buildTurnPrompt 가 handles 없는 작성자를 "알 수 없는
   * 사용자"로 렌더한다). MCP 에는 이 표면이 없다 — definition() 과 같은 이유로 REST 다.
   */
  async accounts(): Promise<AccountView[]> {
    const body = await this.rest<{ accounts: AccountView[] }>('GET', '/accounts', 'accounts');
    return body.accounts;
  }

  /**
   * 이 계정의 메모리를 읽는다(#139). **`core` 본문과 `mem/*` slug 목록만** 가져온다 —
   * `mem/*` 의 본문까지 주입하면 축적이 곧 컨텍스트 고갈이 된다(이슈가 그렇게 확정했다).
   * 에이전트가 필요할 때 `memory.get` 으로 직접 가져간다.
   *
   * **던지는 것을 삼키지 않는다.** 호출자가 "저장소가 비었다"와 "조회가 실패했다"를
   * 구분해야 하기 때문이다 — 여기서 빈 값으로 뭉개면 그 구분이 사라진다.
   */
  async readMemory(): Promise<{ core: string | null; slugs: string[] }> {
    const listed = await this.listMemory();
    const slugs = listed.slugs ?? [];
    if (!slugs.includes('core')) return { core: null, slugs: slugs.filter((s) => s !== 'core') };
    return {
      core: await this.getMemoryValue('core'),
      slugs: slugs.filter((s) => s !== 'core'),
    };
  }

  /** `memory.list` — slug 와 판본(`rev`, 옛 서버는 없음). `memoryCache.ts` 의 `MemorySource`. */
  listMemory(): Promise<{ slugs: string[]; rev?: string; entries?: { slug: string; description: string | null; kind?: string }[] }> {
    return this.call<{ slugs: string[]; rev?: string; entries?: { slug: string; description: string | null; kind?: string }[] }>('memory.list');
  }

  /**
   * `memory.search` recall 모드, 본문 포함 — 러너가 관련 기억을 턴 프롬프트에 붙일 때 쓴다(`memoryPin.ts`).
   * 옛 서버는 `recall` 을 모르는 키로 버리고 옛 응답(terms·nameHits 없음)을 준다 — memoryPin 이 점수로 거른다.
   */
  async searchMemory(query: string, limit: number): Promise<RecallResult> {
    const res = await this.call<{ hits?: RecallHit[]; terms?: string[] }>('memory.search', { query, limit, includeValue: true, recall: true });
    return { hits: res.hits ?? [], ...(Array.isArray(res.terms) ? { terms: res.terms } : {}) };
  }

  /** `memory.get` 의 본문만. 없으면 null. */
  async getMemoryValue(slug: string): Promise<string | null> {
    const got = await this.call<{ value?: string; error?: unknown }>('memory.get', { slug });
    return typeof got.value === 'string' ? got.value : null;
  }

  /**
   * 승인된 스킬 목록(#140). `state=approved` 만 읽는다 — 미승인 스킬을 러너가 실체화하면
   * 승인 게이트가 없는 것과 같다.
   *
   * **던지는 것을 삼키지 않는다.** readMemory 와 같은 이유다: 여기서 빈 배열로 뭉개면
   * "승인된 스킬이 없다"와 "서버를 못 읽었다"가 같은 값이 되고, 그러면 동기화가 이미
   * 있는 스킬을 '사라진 것'으로 보고 지운다. 삼키는 것은 호출자(syncSkills)의 일이고,
   * 그쪽은 삼키면서 stderr 에 한 줄을 남긴다.
   */
  listApprovedSkills(): Promise<{ slug: string; body: string }[]> {
    return this.rest<{ slug: string; body: string }[]>('GET', '/skills?state=approved', 'skills');
  }

  /**
   * 이번 턴에 부른 스킬을 보고한다(D3). 대상 id 를 보내지 않는다 — 서버가 PAT 의 주인 이름으로만
   * 남긴다. 실패는 던진다(`reportActivity` 와 같다) — 삼키는 판단은 호출자(mentionTurn)의 몫이다.
   */
  async recordSkillUse(slugs: string[]): Promise<void> {
    await this.rest<unknown>('POST', '/skills/usage', 'skills/usage', { slugs });
  }

  /**
   * timeoutMs 동안 park 한다. 새 항목이 없으면 빈 배치로 정상 반환된다.
   *
   * `claudeLane` 은 기동 때 읽은 계정 순서다(5단계). **버전과 같은 자리로 실어 보낸다** —
   * 값이 바뀔 때만 서버가 쓰므로(services/claudeLane.ts) 이 25초 루프에 쓰기 비용이 없고,
   * 러너가 이미 거는 호출에 얹으면 lane 만을 위한 새 실패 지점이 생기지 않는다.
   * claude 하네스가 아닌 러너는 넘기지 않는다 — 그러면 서버에 행이 안 생기고, 화면은
   * 그것을 **모른다**로 그린다(없는 lane 을 빈 lane 으로 적으면 거짓이 된다).
   */
  pollInbox(timeoutMs: number, claudeLane?: { pool: string | null; accounts: string[] }): Promise<InboxBatch> {
    return this.call<InboxBatch>('inbox.poll', {
      timeoutMs, version: VERSION, ...(claudeLane ? { claudeLane } : {}),
    });
  }

  async readThread(channelId: string, threadRootId: string | null, since?: number, limit = 30): Promise<MessageRow[]> {
    const args: Record<string, unknown> = { channelId, limit };
    if (threadRootId) args.threadRootId = threadRootId;
    if (since !== undefined) args.since = since;
    const res = await this.call<{ messages: MessageRow[] }>('message.read', args);
    return res.messages;
  }

  /**
   * 채널 전체(스레드 답 포함)에서 seq 커서 이후. `message.read` 에 `threadRootId` 를 주지
   * 않으면 서버 `listMessages` 가 스레드 경계 없이 돌려준다 — 그 계약에 이름을 붙인 것이다.
   *
   * 러너가 이것을 쓰는 자리는 하나다: 침묵으로 끝난 턴이 **자기 앵커 밖에** 발화를 남겼는지
   * 보는 관측(`mentionTurn.ts::offAnchorEvidence`). 앵커 스레드만 읽어서는 정의상 안 보인다.
   */
  async readChannelSince(channelId: string, sinceSeq: number, limit = 200): Promise<MessageRow[]> {
    const res = await this.call<{ messages: MessageRow[] }>('message.read', {
      channelId, since: sinceSeq, limit,
    });
    return res.messages;
  }

  async post(channelId: string, body: string, threadRootId: string | null): Promise<number> {
    const res = await this.call<{ message: { seq: number } }>('message.post', threadRootId ? { channelId, body, threadRootId } : { channelId, body });
    return res.message.seq;
  }

  // #144: 진행 설명 메시지 — 결과 발화로 세지 않고, 사용자가 읽을 수 있어야 뜻이 있다.
  // kind='progress'로 저장되어 message.read 응답에서 구분할 수 있다.
  async progress(channelId: string, body: string, threadRootId: string | null): Promise<number> {
    const res = await this.call<{ message: { seq: number } }>('message.progress', threadRootId ? { channelId, body, threadRootId } : { channelId, body });
    return res.message.seq;
  }

  /**
   * 스스로 못 끝냈음을 알린다(`message.fail`). 수신자는 언제나 사람이다.
   *
   * **`post` 로 대신할 수 없다.** 평문은 스레드 상태에 아무것도 남기지 않는다 — 서버의
   * `unresolved_failure_count` 와 화면의 `threadState()` 는 둘 다 `meta.kind='failure'` 를
   * 보고 `막힘`을 칠하므로, 러너가 평문으로 말하면 사람이 보는 배지는 `끝남` 이다(실측:
   * 재시도 통지를 평문으로 올리던 자리에서 스레드 머리가 `끝남`, 터미널 머리가 `Running`
   * 으로 갈렸다).
   *
   * `retryable` 을 옵셔널로 두지 않는 이유는 서버 도구와 같다 — 기본값을 여기서 정하면
   * 다시 불러도 소용없는 실패에 단추가 생기거나 고칠 수 있는 실패의 경로가 사라진다.
   */
  async fail(
    channelId: string,
    body: string,
    threadRootId: string | null,
    /**
     * `code` 는 기계가 읽는 실패 갈래(서버 FailureMeta.code) — 화면이 그 갈래의 고칠 길을 단다.
     * 옛 서버의 도구 입력 검증은 모르는 키를 걸러 낼 뿐 거절하지 않는다 — 실패 통지는 그대로
     * 나가고 표지만 빠진다(화면이 평문 실패 카드로 그린다). 있을 때만 싣는다.
     */
    opts: FailOpts,
  ): Promise<number> {
    const res = await this.call<{ message: { seq: number } }>('message.fail', {
      channelId,
      body,
      retryable: opts.retryable,
      ...(threadRootId ? { threadRootId } : {}),
      ...(opts.what ? { what: opts.what } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.code ? { code: opts.code } : {}),
      ...(opts.mentionId ? { mentionId: opts.mentionId } : {}),
      ...(opts.account ? { account: opts.account } : {}),
    });
    return res.message.seq;
  }

  /** inbox entry id 로 읽음 처리. 서버가 요청 계정으로 스코프를 걸어 남의 inbox 는 소비되지 않는다. */
  async markRead(ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const res = await this.call<{ read: number }>('inbox.read', { ids });
    return res.read;
  }

  /** 메시지에 리액션을 추가한다. inbox 가 at-least-once 라 같은 멘션이 두 번
   * 처리될 수 있는데, 서버가 중복 추가를 에러로 만들지 않는다. */
  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.call('message.react', { channelId, messageId, emoji });
  }

  /** 메시지에서 리액션을 제거한다. 없는 것을 제거해도 성공이다. */
  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.call('message.unreact', { channelId, messageId, emoji });
  }
}
