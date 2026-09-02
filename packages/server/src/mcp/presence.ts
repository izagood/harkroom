import { emitEvent } from '../events.js';

const AGENT_ONLINE_TTL_MS = 60_000;

const agentPresence = new Map<string, number>();

export function markAgentOnline(accountId: string): void {
  const now = Date.now();
  const wasPresent = agentPresence.has(accountId);
  agentPresence.set(accountId, now);
  if (!wasPresent) {
    emitEvent({ type: 'presence.changed', accountId, online: true });
  }
}

export function getOnlineAgents(): string[] {
  return [...agentPresence.keys()];
}

export const AGENT_PRESENCE_TTL_MS = AGENT_ONLINE_TTL_MS;

let presenceSweepInterval: ReturnType<typeof setInterval> | null = null;

export function startPresenceSweep(app: FastifyInstance): void {
  if (presenceSweepInterval) return;
  presenceSweepInterval = setInterval(() => {
    const now = Date.now();
    const toRemove: string[] = [];
    for (const [accountId, lastPoll] of agentPresence) {
      if (now - lastPoll > AGENT_ONLINE_TTL_MS) {
        toRemove.push(accountId);
      }
    }
    for (const accountId of toRemove) {
      agentPresence.delete(accountId);
      emitEvent({ type: 'presence.changed', accountId, online: false });
    }
  }, AGENT_ONLINE_TTL_MS / 2);
  app.addHook('onClose', async () => {
    if (presenceSweepInterval) {
      clearInterval(presenceSweepInterval);
      presenceSweepInterval = null;
    }
  });
}

import type { FastifyInstance } from 'fastify';