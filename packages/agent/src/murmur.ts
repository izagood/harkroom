// murmur 접속 표면. 스펙(§4)이 지정한 에이전트 표면은 MCP 이므로 그것만 쓴다 — inbox 롱폴은
// MCP `inbox.poll` 에만 있고 REST `/inbox` 에는 없다.
//
// 이 러너를 만들면서 MCP 표면에 구멍이 하나 드러났다: 미읽음을 소비하는 도구가 없어서 같은
// 멘션에 영원히 반복 응답했다. `inbox.read` 를 추가해 닫았고, 그래서 여기 REST 호출이 없다.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AccountView, AgentView, InboxEntry, MessageRow } from '@murmur/shared';
import { mcpUrl } from './turn.js';

export interface Me { id: string; handle: string }

export interface InboxBatch {
  entries: InboxEntry[];
  messages: MessageRow[];
}

export class MurmurAgentClient {
  private mcp: Client | null = null;

  constructor(private baseUrl: string, private pat: string) {}

  private async connected(): Promise<Client> {
    if (this.mcp) return this.mcp;
    const client = new Client({ name: 'murmur-agent', version: '0.1.0' });
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
      throw new Error(`${name}: 텍스트 결과가 없다`);
    }
    const parsed = JSON.parse(first.text) as T & { error?: { code: string; message: string } };
    if (parsed.error) throw new Error(`${name}: ${parsed.error.code} ${parsed.error.message}`);
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
    if (!res.ok) throw new Error(`agent/config 실패: ${res.status}`);
    return (await res.json()) as AgentView;
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
    if (!res.ok) throw new Error(`accounts 실패: ${res.status}`);
    const body = (await res.json()) as { accounts: AccountView[] };
    return body.accounts;
  }

  /** timeoutMs 동안 park 한다. 새 항목이 없으면 빈 배치로 정상 반환된다. */
  pollInbox(timeoutMs: number): Promise<InboxBatch> {
    return this.call<InboxBatch>('inbox.poll', { timeoutMs });
  }

  async readThread(channelId: string, threadRootId: string | null, limit = 30): Promise<MessageRow[]> {
    const res = await this.call<{ messages: MessageRow[] }>('message.read',
      threadRootId ? { channelId, threadRootId, limit } : { channelId, limit });
    return res.messages;
  }

  async post(channelId: string, body: string, threadRootId: string | null): Promise<void> {
    await this.call('message.post', threadRootId ? { channelId, body, threadRootId } : { channelId, body });
  }

  /** inbox entry id 로 읽음 처리. 서버가 요청 계정으로 스코프를 걸어 남의 inbox 는 소비되지 않는다. */
  async markRead(ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const res = await this.call<{ read: number }>('inbox.read', { ids });
    return res.read;
  }
}
