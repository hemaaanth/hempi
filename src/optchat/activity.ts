import { stripVTControlCharacters } from 'node:util';
import type { AgentActivity, AgentActivitySource } from '../acp/activity-types.ts';
import type { Children } from './agents.ts';
import type { UsageLedger } from './usage.ts';

type ActivityChildren = Pick<Children, 'subscribe'> & {
  history: Pick<Children['history'], 'list'>;
  live(id: string): { updated?: number } | undefined;
};
type ActivityUsage = { readonly entries: readonly Pick<UsageLedger['entries'][number], 'session' | 'runId' | 'usage'>[] };

const title = (task: string) => stripVTControlCharacters(task).split(/\r\n|[\n\r\u2028\u2029]/)
  .map(line => line.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim()).find(Boolean)?.slice(0, 240) ?? '';

/** Only projects already-loaded metadata; never collects usage or opens transcripts. */
export class ChildActivity implements AgentActivitySource {
  private binding?: { children: ActivityChildren; usage: ActivityUsage; parentSession: string };
  private detach?: () => void;
  private readonly listeners = new Set<() => void>();

  bind(children: ActivityChildren, usage: ActivityUsage, parentSession: string) {
    this.unbind();
    if (!parentSession) { this.changed(); return; }
    const binding = { children, usage, parentSession };
    this.binding = binding;
    this.detach = children.subscribe(() => { if (this.binding === binding) this.changed(); });
    this.changed();
  }

  private unbind() {
    this.binding = undefined;
    this.detach?.(); this.detach = undefined;
  }

  clear() { this.unbind(); this.changed(); }

  private changed() {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* Display observers must not interrupt profile cleanup. */ }
    }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): readonly AgentActivity[] {
    const binding = this.binding;
    if (!binding) return [];
    const { children, usage, parentSession } = binding;
    const totals = new Map<string, number>();
    const overflow = new Set<string>();
    for (const entry of usage.entries) {
      const tokens = entry.usage.totalTokens;
      if (entry.session === parentSession && entry.runId !== undefined && Number.isSafeInteger(tokens) && tokens >= 0) {
        const sum = (totals.get(entry.runId) ?? 0) + tokens;
        if (Number.isSafeInteger(sum)) totals.set(entry.runId, sum);
        else overflow.add(entry.runId);
      }
    }
    return children.history.list().filter(run => run.parentSession === parentSession).map(run => {
      const live = children.live(run.id);
      const active = ['running', 'waiting', 'paused', 'stopping'].includes(run.state);
      const tokens = overflow.has(run.id) ? undefined : totals.get(run.id);
      return {
        id: `optchat:${run.id}`, agent: `optchat ${run.id.slice(0, 8)}`, title: title(run.task),
        harness: 'pi', state: run.state, startedAt: run.started,
        updatedAt: live?.updated ?? run.ended ?? run.started,
        ...(active && live ? { runningAt: run.started } : {}),
        ...(!active && run.ended !== undefined ? { finishedAt: run.ended } : {}),
        ...(tokens !== undefined && Number.isFinite(tokens) ? { reportedTokens: tokens } : {}),
        model: run.model,
      };
    });
  }
}
