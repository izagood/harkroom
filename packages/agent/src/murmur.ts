// murmur 접속 표면. 스펙(§4)이 지정한 에이전트 표면은 MCP 이므로 그것만 쓴다 — inbox 롱폴은
// MCP `inbox.poll` 에만 있고 REST `/inbox` 에는 없다.
//
// 이 러너를 만들면서 MCP 표면에 구멍이 하나 드러났다: 미읽음을 소비하는 도구가 없어서 같은
// 멘션에 영원히 반복 응답했다. `inbox.read` 를 추가해 닫았고, 그래서 여기 REST 호출이 없다.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AccountView, AgentView, InboxEntry, MessageRow } from '@murmur/shared';
import { mcpUrl } from './turn.js';
import { MURMUR_ERROR_SOURCE } from './policy.js';
import { VERSION } from './version.js';

export interface Me { id: string; handle: string }

export interface InboxBatch {
  entries: InboxEntry[];
  messages: MessageRow[];
}

/**
 * 이 클라이언트가 던지는 에러에 출처와 HTTP status 를 붙인다.
 *
 * `policy.ts::isCredentialFailure` 는 `main.ts` 에서 턴 **전체**를 감싸는 catch 에 쓰이므로,
 * 하네스 실패와 murmur 호출 실패가 같은 자리로 들어온다. 태그가 없으면 murmur PAT 만료를
 * "claude CLI 로 로그인해라"로 안내하게 된다(#87).
 *
 * status 를 함께 싣는 이유: 태그만 있으면 판정이 다시 문구 매칭으로 내려간다. status 가
 * 있으면 `isCredentialFailure` 가 401/403 만 보고 끝낸다.
 */
function murmurError(message: string, status?: number): Error {
  const err = new Error(message) as Error & { source: string; status?: number };
  err.source = MURMUR_ERROR_SOURCE;
  if (status !== undefined) err.status = status;
  return err;
}

export class MurmurAgentClient {
  private mcp: Client | null = null;

  constructor(private baseUrl: string, private pat: string) {}

  private async connected(): Promise<Client> {
    if (this.mcp) return this.mcp;
    const client = new Client({ name: 'murmur-agent', version: VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl(this.baseUrl)), {
      requestInit: { headers: { authorization: `Bearer ${this.pat}` } },
    });
    await client.connect(transport);
    this.mcp = client;
    return client;
  }

  /** 서버 재시작·절단 후 다음 호출이 새 세션을 열도록 버린다. */
  reset(): void {
    const old = this.mcp;
    this.mcp = null;
    void old?.close().catch(() => {});
  }

  private async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const client = await this.connected();
    const res = await client.callTool({ name, arguments: args });
    const first = (res.content as { type: string; text?: string }[] | undefined)?.[0];
    if (!first || first.type !== 'text' || !first.text) {
      throw murmurError(`${name}: 텍스트 결과가 없다`);
    }
    const parsed = JSON.parse(first.text) as T & { error?: { code: string; message: string } };
    if (parsed.error) {
      // MCP 도구 에러에는 HTTP status 가 없다 — code 로만 온다. 자격증명 문제라면
      // 서버가 401/403 을 내는 fetch 경로(definition·accounts)에서 먼저 드러난다.
      throw murmurError(`${name}: ${parsed.error.code} ${parsed.error.message}`);
    }
    return parsed;
  }

  me(): Promise<Me> {
    return this.call<Me>('account.me');
  }

  /** 서버가 들고 있는 자기 정의(UI 로 수정된다). REST 다 — MCP 에는 이 도구가 없다. */
  async definition(): Promise<AgentView> {
    const res = await fetch(`${this.baseUrl}/agent/config`, {
      headers: { authorization: `Bearer ${this.pat}` },
    });
    if (!res.ok) {
      throw murmurError(`agent/config 실패: ${res.status}`, res.status);
    }
    return (await res.json()) as AgentView;
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
  async reportActivity(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agent/activity`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.pat}` },
    });
    if (!res.ok) {
      throw murmurError(`agent/activity 실패: ${res.status}`, res.status);
    }
  }

  async guide(): Promise<string> {
    const res = await this.call<{ guide?: string } | string>('workspace.guide');
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
    const res = await fetch(`${this.baseUrl}/accounts`, {
      headers: { authorization: `Bearer ${this.pat}` },
    });
    if (!res.ok) {
      throw murmurError(`accounts 실패: ${res.status}`, res.status);
    }
    const body = (await res.json()) as { accounts: AccountView[] };
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
    const listed = await this.call<{ slugs: string[] }>('memory.list');
    const slugs = listed.slugs ?? [];
    if (!slugs.includes('core')) return { core: null, slugs: slugs.filter((s) => s !== 'core') };
    const got = await this.call<{ value?: string; error?: unknown }>('memory.get', { slug: 'core' });
    return {
      core: typeof got.value === 'string' ? got.value : null,
      slugs: slugs.filter((s) => s !== 'core'),
    };
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
  async listApprovedSkills(): Promise<{ slug: string; body: string }[]> {
    const res = await fetch(`${this.baseUrl}/skills?state=approved`, {
      headers: { authorization: `Bearer ${this.pat}` },
    });
    if (!res.ok) {
      throw murmurError(`skills 실패: ${res.status}`, res.status);
    }
    return (await res.json()) as { slug: string; body: string }[];
  }

  /** timeoutMs 동안 park 한다. 새 항목이 없으면 빈 배치로 정상 반환된다. */
  pollInbox(timeoutMs: number): Promise<InboxBatch> {
    return this.call<InboxBatch>('inbox.poll', { timeoutMs, version: VERSION });
  }

  async readThread(channelId: string, threadRootId: string | null, since?: number, limit = 30): Promise<MessageRow[]> {
    const args: Record<string, unknown> = { channelId, limit };
    if (threadRootId) args.threadRootId = threadRootId;
    if (since !== undefined) args.since = since;
    const res = await this.call<{ messages: MessageRow[] }>('message.read', args);
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
