import { describe, expect, it } from 'vitest';
import { normalizeProviderBaseUrl, readProviderLaneConfig } from '../src/providerLane.js';
import { readOperatorAgentProviderLanePayload } from '../src/daemonProtocol.js';

describe('normalizeProviderBaseUrl', () => {
  it('https 는 받고 끝 슬래시를 뗀다 — 경로 접두는 남긴다', () => {
    expect(normalizeProviderBaseUrl('https://gateway.example/')).toBe('https://gateway.example');
    expect(normalizeProviderBaseUrl(' https://gateway.example/anthropic/ ')).toBe('https://gateway.example/anthropic');
  });
  it('루프백만 평문 http 를 받는다', () => {
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeProviderBaseUrl('http://gateway.example')).toBeNull();
  });
  it('사용자 정보·쿼리·조각·다른 스킴은 거절한다', () => {
    for (const bad of ['https://u:p@gateway.example', 'https://gateway.example?key=1', 'https://gateway.example#x', 'file:///etc/passwd', '', 'nope', 42]) {
      expect(normalizeProviderBaseUrl(bad)).toBeNull();
    }
  });
});

describe('readProviderLaneConfig·payload', () => {
  it('비밀 이름 문법을 지킨다', () => {
    expect(readProviderLaneConfig({ baseUrl: 'https://gateway.example', secretName: 'gw-key' })).toEqual({ baseUrl: 'https://gateway.example', secretName: 'gw-key' });
    expect(readProviderLaneConfig({ baseUrl: 'https://gateway.example', secretName: '../x' })).toBeNull();
  });
  it('lane null 은 빼기, 틀린 lane 은 bad-payload', () => {
    expect(readOperatorAgentProviderLanePayload({ baseUrl: 'https://s.example', agentId: 'a', lane: null })).toEqual({ baseUrl: 'https://s.example', agentId: 'a', lane: null });
    expect(readOperatorAgentProviderLanePayload({ baseUrl: 'https://s.example', agentId: 'a', lane: { baseUrl: 'http://x.example', secretName: 'k' } })).toMatchObject({ code: 'bad-payload' });
  });
});
