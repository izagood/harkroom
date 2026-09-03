import type { AgentView } from '@murmur/shared';
import { Command } from '@tauri-apps/plugin-shell';
import type { Child } from '@tauri-apps/plugin-shell';
import { prefsStorage } from './prefs';

export type RunnerStatus = 'stopped' | 'running' | 'external' | 'needs_reissue' | 'failed';

export interface RunnerState {
  agentId: string;
  status: RunnerStatus;
  exitCode: number | null;
}

function getHostname(): string {
  try {
    return globalThis.window?.location?.hostname ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const PAT_KEY_PREFIX = 'murmur.runner.pat.';

async function getStoredPat(agentId: string): Promise<string | null> {
  const invoke = (globalThis as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__?.invoke;
  if (!invoke) return null;
  try {
    const key = `${PAT_KEY_PREFIX}${agentId}`;
    const result = await invoke('secret_get', { key }) as string | null;
    return result;
  } catch {
    return null;
  }
}

async function storePat(agentId: string, pat: string): Promise<void> {
  const invoke = (globalThis as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__?.invoke;
  if (!invoke) return;
  const key = `${PAT_KEY_PREFIX}${agentId}`;
  await invoke('secret_set', { key, value: pat });
}

async function deleteStoredPat(agentId: string): Promise<void> {
  const invoke = (globalThis as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__?.invoke;
  if (!invoke) return;
  const key = `${PAT_KEY_PREFIX}${agentId}`;
  try {
    await invoke('secret_delete', { key });
  } catch { /* ignore if not exists */ }
}

interface RunnerApi {
  baseUrl: string;
  listAgents(): Promise<AgentView[]>;
  mintPat(accountId: string, label: string): Promise<string>;
  listPats(accountId: string): Promise<{ label: string; revokedAt: string | null }[]>;
  revokePat(accountId: string, label: string): Promise<{ revoked: number }>;
  me?(): Promise<{ id: string }>;
}

export class RunnerLauncher {
  private runners: Map<string, { child: Child; monitorId: number }> = new Map();
  private states: Map<string, RunnerState> = new Map();
  private onStateChange?: (states: RunnerState[]) => void;

  constructor(
    private api: RunnerApi,
  ) {}

  setOnStateChange(cb: (states: RunnerState[]) => void): void {
    this.onStateChange = cb;
  }

  getStates(): RunnerState[] {
    return Array.from(this.states.values());
  }

  private emitStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getStates());
    }
  }

  async startAll(): Promise<void> {
    const prefs = prefsStorage.load();
    if (!prefs.runnerAutoStart) return;

    const agents = await this.api.listAgents();
    await this.startTargetAgents(agents);
  }

  async startTargetAgents(agents: AgentView[]): Promise<void> {
    const me = this.api.me ? await this.api.me() : null;
    if (!me) return;

    const myId = me.id;
    const targetAgents = agents.filter((a) =>
      a.ownerAccountId === myId &&
      !a.disabled &&
      !a.stopRequestedAt
    );

    for (const agent of targetAgents) {
      try {
        await this.maybeStartAgent(agent);
      } catch (err) {
        console.error(`[runnerLauncher] 에이전트 ${agent.handle} 기동 실패:`, err);
        this.states.set(agent.id, { agentId: agent.id, status: 'failed', exitCode: -1 });
        this.emitStateChange();
      }
    }
  }

  async maybeStartAgent(agent: AgentView): Promise<void> {
    const existing = this.runners.get(agent.id);
    if (existing) return;

    if (agent.runnerVersion) {
      this.states.set(agent.id, { agentId: agent.id, status: 'external', exitCode: null });
      this.emitStateChange();
      return;
    }

    let pat = await getStoredPat(agent.id);
    if (!pat) {
      const label = `desktop:${getHostname()}`;
      const existingPats = await this.api.listPats(agent.id);
      const existingLabel = existingPats.find((p) => p.label.startsWith('desktop:'));
      if (existingLabel && !existingLabel.revokedAt) {
        try {
          await this.api.revokePat(agent.id, existingLabel.label);
        } catch { /* ignore */ }
      }

      try {
        pat = await this.api.mintPat(agent.id, label);
        await storePat(agent.id, pat);
      } catch (err) {
        console.error(`[runnerLauncher] PAT 발급 실패:`, err);
        this.states.set(agent.id, { agentId: agent.id, status: 'failed', exitCode: -1 });
        this.emitStateChange();
        return;
      }
    }

    await this.spawnRunner(agent, pat);
  }

  private async spawnRunner(agent: AgentView, pat: string): Promise<void> {
    const cwd = agent.workingDir ?? process.cwd();
    const cmd = Command.create('pnpm', ['--filter', '@murmur/agent', 'start'], {
      cwd,
      env: {
        MURMUR_PAT: pat,
        MURMUR_URL: this.api.baseUrl,
      },
    });

    this.states.set(agent.id, { agentId: agent.id, status: 'running', exitCode: null });
    this.emitStateChange();

    try {
      const child = await cmd.spawn();
      const pid = child.pid;
      console.log(`[runnerLauncher] Started runner for agent ${agent.handle} with pid ${pid}`);

      const monitorId = window.setInterval(async () => {
        try {
          await child.kill();
          window.clearInterval(monitorId);
          await this.handleChildExit(agent.id, 0);
        } catch {
          // Process still running
        }
      }, 5000);

      this.runners.set(agent.id, { child, monitorId });
    } catch (err) {
      console.error(`[runnerLauncher] Failed to spawn runner:`, err);
      this.states.set(agent.id, { agentId: agent.id, status: 'failed', exitCode: -1 });
      this.emitStateChange();
    }
  }

  private async handleChildExit(agentId: string, exitCode: number): Promise<void> {
    const runner = this.runners.get(agentId);
    if (runner) {
      window.clearInterval(runner.monitorId);
      try {
        await runner.child.kill();
      } catch { /* already dead */ }
      this.runners.delete(agentId);
    }

    if (exitCode === 78) {
      this.states.set(agentId, { agentId, status: 'needs_reissue', exitCode });
    } else {
      this.states.set(agentId, { agentId, status: 'stopped', exitCode });
    }
    this.emitStateChange();
  }

  async reissueAndRestart(agentId: string): Promise<void> {
    const currentState = this.states.get(agentId);
    if (!currentState || currentState.status !== 'needs_reissue') {
      return;
    }

    const agents = await this.api.listAgents();
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;

    const oldPat = await getStoredPat(agentId);
    if (oldPat) {
      const label = `desktop:${getHostname()}`;
      try {
        await this.api.revokePat(agentId, label);
      } catch (err) {
        console.warn(`[runnerLauncher] Failed to revoke old PAT:`, err);
      }
      await deleteStoredPat(agentId);
    }

    const label = `desktop:${getHostname()}`;
    let newPat: string;
    try {
      newPat = await this.api.mintPat(agentId, label);
      await storePat(agentId, newPat);
    } catch (err) {
      console.error(`[runnerLauncher] PAT 재발급 실패:`, err);
      this.states.set(agentId, { agentId, status: 'failed', exitCode: -1 });
      this.emitStateChange();
      return;
    }

    this.states.set(agentId, { agentId, status: 'running', exitCode: null });
    this.emitStateChange();
    await this.spawnRunner(agent, newPat);
  }

  async stopRunner(agentId: string): Promise<void> {
    const runner = this.runners.get(agentId);
    if (runner) {
      window.clearInterval(runner.monitorId);
      try {
        await runner.child.kill();
      } catch { /* ignore */ }
      this.runners.delete(agentId);
    }
    this.states.set(agentId, { agentId, status: 'stopped', exitCode: null });
    this.emitStateChange();
  }

  async restartRunner(agentId: string): Promise<void> {
    await this.stopRunner(agentId);

    const agents = await this.api.listAgents();
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;

    const pat = await getStoredPat(agentId);
    if (pat) {
      await this.spawnRunner(agent, pat);
    }
  }

  dispose(): void {
    for (const runner of this.runners.values()) {
      window.clearInterval(runner.monitorId);
      try {
        runner.child.kill();
      } catch { /* ignore */ }
    }
    this.runners.clear();
    this.states.clear();
  }
}