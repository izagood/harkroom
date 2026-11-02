import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { HarkroomAgentClient, isUnknownTool } from '../src/harkroom.js';
import { runnerNoticeFallbackBody } from '../src/prompt.js';

/**
 * 러너 알림 줄(2026-11-02) — `message.notice` 로 서버가 시스템 줄을 쓴다. 그 도구가 없는 **옛 서버**면 옛 본문을 일반 글로
 * 올린다(알림이 사라지지 않게). 입력 검증 실패(같은 -32602)는 옛 서버로 오인하지 않는다.
 *
 * 가짜 서버는 저수준 `Server` 다 — 모르는 도구·입력 거절을 `McpServer` 와 같은 꼴(`-32602 Tool <name> not found`)로 던진다.
 */
async function clientFor(withNotice: boolean, opts: { noticeRejects?: boolean } = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const server = new Server({ name: 'fake', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (name === 'message.notice' && withNotice) {
      if (opts.noticeRejects) throw new McpError(ErrorCode.InvalidParams, 'Input validation error: Invalid arguments for tool message.notice');
      calls.push({ tool: name, args });
      return { content: [{ type: 'text', text: JSON.stringify({ message: { seq: 2 } }) }] };
    }
    if (name === 'message.post') {
      calls.push({ tool: name, args });
      return { content: [{ type: 'text', text: JSON.stringify({ message: { seq: 1 } }) }] };
    }
    throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new HarkroomAgentClient({ mcpTransport: () => clientSide } as never);
  return { client, calls };
}

describe('HarkroomAgentClient.notice', () => {
  it('새 서버: message.notice 에 키만 싣는다 — 본문을 보내지 않는다', async () => {
    const { client, calls } = await clientFor(true);
    expect(await client.notice('ch', 'root', { key: 'controlled', handle: 'alice', pending: 2 })).toBe(2);
    expect(calls).toEqual([{ tool: 'message.notice', args: { channelId: 'ch', threadRootId: 'root', key: 'controlled', handle: 'alice', pending: 2 } }]);
  });

  it('옛 서버(도구 없음): 옛 본문을 일반 글로 올린다', async () => {
    const { client, calls } = await clientFor(false);
    expect(await client.notice('ch', 'root', { key: 'blocked_by_turn' })).toBe(1);
    expect(calls).toEqual([{ tool: 'message.post', args: { channelId: 'ch', threadRootId: 'root', body: runnerNoticeFallbackBody({ key: 'blocked_by_turn' }) } }]);
  });

  it('입력 거절(-32602)은 옛 서버로 오인하지 않고 던진다', async () => {
    const { client, calls } = await clientFor(true, { noticeRejects: true });
    await expect(client.notice('ch', 'root', { key: 'fenced' })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('isUnknownTool 은 도구 이름까지 본다', () => {
    expect(isUnknownTool(new Error('message.notice: MCP error -32602: Tool message.notice not found'), 'message.notice')).toBe(true);
    expect(isUnknownTool(new Error('message.notice: MCP error -32602: Invalid arguments'), 'message.notice')).toBe(false);
    expect(isUnknownTool(new Error('Tool message.post not found'), 'message.notice')).toBe(false);
  });
});
