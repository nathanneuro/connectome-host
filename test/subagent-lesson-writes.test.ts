/**
 * A spawned subagent starts without its caller's context and gets no lesson
 * injection, so by default it may read lessons but not write them. Naming a
 * write tool in `tools` grants it; a fork inherits context and keeps all.
 *
 * Harness follows subagent-prose-routing.test.ts: real framework + mock
 * membrane, runEphemeralToCompletion stubbed to capture the ephemeral Agent.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';
import { LessonsModule } from '../src/modules/lessons-module.js';

interface CapturedAgent { canUseTool(name: string): boolean }

async function makeHarness() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-lessons-'));
  const membrane = new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({
    parentAgentName: 'parent',
    defaultModel: 'mock',
    defaultMaxTokens: 256,
    maxRetries: 0,
  });
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent', maxTokens: 256 }],
    modules: [subagent as unknown as Module, new LessonsModule() as unknown as Module],
  });
  subagent.setFramework(framework);

  let captured: CapturedAgent | null = null;
  const fw = framework as unknown as {
    runEphemeralToCompletion: (agent: unknown) => Promise<{ speech: string; toolCallsCount: number }>;
  };
  fw.runEphemeralToCompletion = async (agent: unknown) => {
    captured = agent as CapturedAgent;
    return { speech: 'done', toolCallsCount: 0 };
  };

  const spawn = async (tools?: string[]) => {
    const result = await subagent.handleToolCall({
      id: 'tc-1',
      name: 'spawn',
      callerAgentName: 'parent',
      input: { name: 'probe', systemPrompt: 'probe', task: 'probe', sync: true, ...(tools ? { tools } : {}) },
    } as unknown as ToolCall);
    expect(result.success).toBe(true);
    expect(captured).not.toBeNull();
    return captured!;
  };
  const cleanup = async () => {
    await framework.stop().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  };
  return { subagent, spawn, cleanup };
}

describe('subagent lesson writes', () => {
  test('a default spawn reads lessons but cannot write them', async () => {
    const h = await makeHarness();
    try {
      const agent = await h.spawn();
      expect(agent.canUseTool('lessons--query')).toBe(true);
      expect(agent.canUseTool('lessons--list')).toBe(true);
      for (const w of ['create', 'update', 'deprecate', 'boost', 'demote']) {
        expect(agent.canUseTool(`lessons--${w}`)).toBe(false);
      }
      expect(agent.canUseTool('subagent--spawn')).toBe(true);
      expect(agent.canUseTool('subagent--return')).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  test('naming a write tool in `tools` grants it', async () => {
    const h = await makeHarness();
    try {
      const agent = await h.spawn(['lessons--create']);
      expect(agent.canUseTool('lessons--create')).toBe(true);
      expect(agent.canUseTool('lessons--update')).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  test('a fork keeps every tool', async () => {
    const h = await makeHarness();
    try {
      const filter = (h.subagent as unknown as {
        filterToolNames(t: string[] | undefined, d: number, k: 'spawn' | 'fork'): 'all' | string[];
      }).filterToolNames.bind(h.subagent);
      expect(filter(undefined, 0, 'fork')).toBe('all');
    } finally {
      await h.cleanup();
    }
  });
});
