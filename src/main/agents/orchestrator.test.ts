import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '@shared/protocol'
import type { AgentRole } from '@shared/agents'
import { MockProvider, type ScriptedTurn } from '../../../test/support/mock-provider'
import { WorkspaceGuard } from '../security/workspace-guard'
import { ToolRegistry } from '../tools/registry'
import { readFileTool, listDirectoryTool, writeFileTool } from '../tools/file-ops'
import type { ToolContext } from '../tools/types'
import { createAgents } from './roles'
import { Orchestrator, type ConfirmDecision, type OrchestratorEvent, type ToolConfirmRequest } from './orchestrator'

// Deliberately builds the tool registry/context directly rather than via
// tools/setup.ts, which imports `electron` at module scope and would crash
// under plain Vitest (see vitest.config.ts / db/index.ts's setDbPath comment
// for the same class of hazard). Never swap this for tools/setup.ts's
// createDefaultRegistry()/createToolContext() convenience factories.
function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(listDirectoryTool)
  registry.register(writeFileTool)
  return registry
}

async function collect(
  orchestrator: Orchestrator,
  conversation: Message[],
  forcedRole?: AgentRole | null
): Promise<OrchestratorEvent[]> {
  const events: OrchestratorEvent[] = []
  for await (const event of orchestrator.run(conversation, forcedRole)) {
    events.push(event)
  }
  return events
}

function autoApprove(): (request: ToolConfirmRequest) => Promise<ConfirmDecision> {
  return async (request) => ({ approved: true, input: request.input })
}

describe('Orchestrator (integration, mocked provider)', () => {
  let root: string
  let ctx: ToolContext
  let signal: AbortSignal

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-orchestrator-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
    signal = new AbortController().signal
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('delegates to the Coding specialist, which writes a real file through real confirmation', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)

    const turns: ScriptedTurn[] = [
      // Round 1 (outer, agentRole undefined): delegate to coding.
      { toolCalls: [{ id: 'call_delegate', name: 'delegate_to_coding', input: { task: 'write hello.txt' } }] },
      // Round 2 (nested, agentRole coding): call write_file.
      {
        toolCalls: [
          { id: 'call_write', name: 'write_file', input: { path: 'hello.txt', content: 'hello from test' } }
        ]
      },
      // Round 3 (nested, agentRole coding): specialist's own wrap-up text, end_turn.
      { text: 'I wrote hello.txt.', stopReason: 'end_turn' },
      // Round 4 (outer, agentRole undefined): orchestrator's final reply, end_turn.
      { text: 'The Coding specialist wrote the file.', stopReason: 'end_turn' }
    ]
    const provider = new MockProvider(turns)

    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      autoApprove(),
      ctx,
      signal
    )

    const conversation: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Please write hello.txt for me.' }] }
    ]
    const events = await collect(orchestrator, conversation)

    // The real tool actually ran: this is a regression test for bug #1 (a
    // delegate's nested conversation must not include the outer round's own
    // not-yet-resolved tool_use block, or OpenAI's real API rejects it) —
    // if that snapshot were wrong the mock provider would still tolerate a
    // malformed conversation, but the file write is proof the whole chain
    // actually executed to completion.
    expect(await readFile(join(root, 'hello.txt'), 'utf-8')).toBe('hello from test')

    const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

    const delegateStart = streamEvents.find(
      (e) => e.type === 'tool_use_start' && e.name === 'delegate_to_coding'
    )
    expect(delegateStart).toMatchObject({ type: 'tool_use_start', name: 'delegate_to_coding' })
    expect((delegateStart as { agentRole?: string }).agentRole).toBeUndefined()

    const writeStart = streamEvents.find((e) => e.type === 'tool_use_start' && e.name === 'write_file')
    expect(writeStart).toMatchObject({ type: 'tool_use_start', name: 'write_file', agentRole: 'coding' })

    // Regression test for bug #2: the nested specialist's own end_turn must be
    // tagged with agentRole so it isn't mistaken for the whole exchange
    // ending. Matching App.svelte's actual "is this final?" check (untagged
    // AND not stopReason:'tool_use'), there must be exactly one such stop,
    // and it must be the very last stream event. The outer loop's round-1
    // stop (untagged, but stopReason:'tool_use' since it delegates) and both
    // nested-round stops (tagged agentRole:'coding') must NOT count as final.
    const stops = streamEvents.filter((e) => e.type === 'message_stop')
    expect(stops).toHaveLength(4) // one per round
    const finalStops = stops.filter(
      (e) => e.type === 'message_stop' && e.agentRole === undefined && e.stopReason !== 'tool_use'
    )
    expect(finalStops).toHaveLength(1)
    expect(streamEvents.at(-1)).toEqual({ type: 'message_stop', stopReason: 'end_turn' })

    // Every round's tool_result actually resolved (no leftover "pending" state).
    const toolResults = streamEvents.filter((e) => e.type === 'tool_result')
    expect(toolResults.every((e) => 'isError' in e && e.isError === false)).toBe(true)
  })

  it('handles a trivial message directly with no delegation', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)
    const provider = new MockProvider([{ text: 'Hello! How can I help?', stopReason: 'end_turn' }])
    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      autoApprove(),
      ctx,
      signal
    )

    const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

    expect(streamEvents.some((e) => e.type === 'tool_use_start')).toBe(false)
    expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Hello! How can I help?' })
    expect(provider.requests).toHaveLength(1)
  })

  it('a denied confirmation surfaces as an error tool_result without writing the file', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)
    const provider = new MockProvider([
      { toolCalls: [{ id: 'call_write', name: 'write_file', input: { path: 'denied.txt', content: 'x' } }] },
      { text: 'Understood, not writing it.', stopReason: 'end_turn' }
    ])
    const denyAll: (request: ToolConfirmRequest) => Promise<ConfirmDecision> = async () => ({
      approved: false
    })
    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      denyAll,
      ctx,
      signal
    )

    const events = await collect(orchestrator, [
      { role: 'user', content: [{ type: 'text', text: 'write denied.txt' }] }
    ])
    const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)
    const result = streamEvents.find((e) => e.type === 'tool_result')

    expect(result).toMatchObject({ type: 'tool_result', isError: true, content: 'The user denied this tool call.' })
    await expect(readFile(join(root, 'denied.txt'), 'utf-8')).rejects.toThrow()
  })

  it('a denial inside a delegated (nested) specialist still resolves the whole run, not just its own round', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)
    const turns: ScriptedTurn[] = [
      // Round 1 (outer, agentRole undefined): delegate to coding.
      { toolCalls: [{ id: 'call_delegate', name: 'delegate_to_coding', input: { task: 'write hello.txt' } }] },
      // Round 2 (nested, agentRole coding): call write_file — denied below.
      {
        toolCalls: [
          { id: 'call_write', name: 'write_file', input: { path: 'hello.txt', content: 'hello from test' } }
        ]
      },
      // Round 3 (nested, agentRole coding): specialist sees the denial, wraps up.
      { text: "Understood, I won't write it.", stopReason: 'end_turn' },
      // Round 4 (outer, agentRole undefined): orchestrator's final reply.
      { text: 'The Coding specialist did not write the file, as you denied it.', stopReason: 'end_turn' }
    ]
    const provider = new MockProvider(turns)
    const denyAll: (request: ToolConfirmRequest) => Promise<ConfirmDecision> = async () => ({
      approved: false
    })

    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      denyAll,
      ctx,
      signal
    )

    const events = await collect(orchestrator, [
      { role: 'user', content: [{ type: 'text', text: 'Please write hello.txt for me.' }] }
    ])

    await expect(readFile(join(root, 'hello.txt'), 'utf-8')).rejects.toThrow()

    const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)
    const writeResult = streamEvents.find((e) => e.type === 'tool_result' && e.toolUseId === 'call_write')
    expect(writeResult).toMatchObject({ isError: true, content: 'The user denied this tool call.' })

    // The whole run must still end cleanly — same "exactly one untagged,
    // non-tool_use message_stop, and it's the very last event" shape as the
    // successful-delegation test, so App.svelte's sending flag actually
    // clears instead of the composer staying stuck disabled forever.
    const stops = streamEvents.filter((e) => e.type === 'message_stop')
    const finalStops = stops.filter(
      (e) => e.type === 'message_stop' && e.agentRole === undefined && e.stopReason !== 'tool_use'
    )
    expect(finalStops).toHaveLength(1)
    expect(streamEvents.at(-1)).toEqual({ type: 'message_stop', stopReason: 'end_turn' })
  })

  it('an unknown tool name (including a bogus delegate_to_x) surfaces as an error result, not a crash', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)
    const provider = new MockProvider([
      { toolCalls: [{ id: 'call_bogus', name: 'delegate_to_marketing', input: { task: 'sell it' } }] },
      { text: 'No such specialist, sorry.', stopReason: 'end_turn' }
    ])
    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      autoApprove(),
      ctx,
      signal
    )

    const events = await collect(orchestrator, [
      { role: 'user', content: [{ type: 'text', text: 'do a marketing thing' }] }
    ])
    const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)
    expect(streamEvents.find((e) => e.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      isError: true,
      content: 'Unknown tool "delegate_to_marketing".'
    })
  })

  it('malformed tool-call JSON input falls back to {} instead of crashing the run', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 'call_bad', name: 'write_file', input: {}, rawInput: '{not valid json' }
        ]
      },
      { text: 'Handled the bad input.', stopReason: 'end_turn' }
    ])
    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      autoApprove(),
      ctx,
      signal
    )

    const events = await collect(orchestrator, [
      { role: 'user', content: [{ type: 'text', text: 'write something' }] }
    ])
    const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

    // With `path`/`content` missing from the {} fallback, write_file still
    // runs (mutates: true -> confirmed -> executes) but resolves an empty
    // path to the workspace root itself and fails writing a file there
    // (EISDIR) — caught by dispatchTool's try/catch as an isError result,
    // not an uncaught exception that would kill the whole run.
    const result = streamEvents.find((e) => e.type === 'tool_result')
    expect(result).toMatchObject({ type: 'tool_result', isError: true })
    expect(streamEvents.at(-1)).toEqual({ type: 'message_stop', stopReason: 'end_turn' })
  })

  it('run() throws for an unknown forced role (observed on the first iteration)', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)
    const provider = new MockProvider([])
    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      autoApprove(),
      ctx,
      signal
    )

    const iterable = orchestrator.run(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      'not-a-real-role' as never
    )
    const iterator = iterable[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow(/Unknown agent role/)
  })

  it('forcedRole runs that specialist directly with no routing/delegate call', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)
    const provider = new MockProvider([
      { toolCalls: [{ id: 'call_write', name: 'write_file', input: { path: 'forced.txt', content: 'forced' } }] },
      { text: 'Done.', stopReason: 'end_turn' }
    ])
    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      autoApprove(),
      ctx,
      signal
    )

    const events = await collect(
      orchestrator,
      [{ role: 'user', content: [{ type: 'text', text: 'write forced.txt' }] }],
      'coding'
    )
    const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

    expect(streamEvents.some((e) => e.type === 'tool_use_start' && e.name === 'delegate_to_coding')).toBe(false)
    const writeStart = streamEvents.find((e) => e.type === 'tool_use_start' && e.name === 'write_file')
    expect(writeStart).toMatchObject({ agentRole: 'coding' })
    expect(await readFile(join(root, 'forced.txt'), 'utf-8')).toBe('forced')

    // Regression test for a live-found bug: in forced-role mode the TOP-LEVEL
    // call itself carries an agentRole (for the "Coding agent" chip above),
    // but its own final message_stop must stay untagged, or App.svelte's
    // "untagged + non-tool_use = truly final" check never fires and the
    // composer's `sending` state gets stuck disabled forever.
    const finalStop = streamEvents.at(-1)
    expect(finalStop).toEqual({ type: 'message_stop', stopReason: 'end_turn' })
  })

  it('reports one clean usage event per round, not one per raw provider usage chunk, and aggregates through a delegate', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)

    const turns: ScriptedTurn[] = [
      // Round 1 (outer): delegate to coding. The mock yields this round's
      // usage TWICE (matching real providers' cumulative-repeat behavior) —
      // a naive sum would double-count it.
      {
        toolCalls: [{ id: 'call_delegate', name: 'delegate_to_coding', input: { task: 'write hello.txt' } }],
        usage: { inputTokens: 100, outputTokens: 10 }
      },
      // Round 2 (nested, coding): specialist's own reply — its usage must
      // also count toward the total, it's a real API call too.
      { text: 'Done.', stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 5 } },
      // Round 3 (outer): orchestrator's final reply.
      { text: 'The Coding specialist handled it.', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 8 } }
    ]
    const provider = new MockProvider(turns)
    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      autoApprove(),
      ctx,
      signal
    )

    const events = await collect(orchestrator, [
      { role: 'user', content: [{ type: 'text', text: 'Please write hello.txt for me.' }] }
    ])
    const usageEvents = events
      .filter((e) => e.kind === 'stream' && e.event.type === 'usage')
      .map((e) => (e as { event: { inputTokens: number; outputTokens: number } }).event)

    // Exactly one usage event per round (3 rounds), not 2 per round even
    // though the mock yielded each round's usage twice.
    expect(usageEvents).toEqual([
      { type: 'usage', inputTokens: 100, outputTokens: 10 },
      { type: 'usage', inputTokens: 50, outputTokens: 5 },
      { type: 'usage', inputTokens: 20, outputTokens: 8 }
    ])
    const total = usageEvents.reduce(
      (acc, e) => ({ input: acc.input + e.inputTokens, output: acc.output + e.outputTokens }),
      { input: 0, output: 0 }
    )
    expect(total).toEqual({ input: 170, output: 23 })
  })

  it('an aborted signal yields a clean message_stop("aborted") instead of a thrown error', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)
    const provider = new MockProvider([{ throwError: 'simulated SDK abort error' }])
    const controller = new AbortController()
    controller.abort()

    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      autoApprove(),
      ctx,
      controller.signal
    )

    const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

    // The round's own `status` event (yielded before the provider call that
    // then throws) still comes through — only the provider call itself is
    // short-circuited by the already-aborted signal.
    expect(streamEvents).toEqual([
      { type: 'status', message: 'Model (mock-model) is thinking…' },
      { type: 'message_stop', stopReason: 'aborted' }
    ])
  })

  it('a genuine provider error still propagates (not swallowed as an abort) when the signal was never fired', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)
    const provider = new MockProvider([{ throwError: 'a real network failure' }])
    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      autoApprove(),
      ctx,
      signal
    )

    const iterable = orchestrator.run([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    const iterator = iterable[Symbol.asyncIterator]()
    // First value is the round's own `status` event, yielded before the
    // provider call that then genuinely throws.
    await expect(iterator.next()).resolves.toMatchObject({ value: { event: { type: 'status' } } })
    await expect(iterator.next()).rejects.toThrow('a real network failure')
  })

  describe('classify-and-plan (planningEnabled)', () => {
    it('a simple request costs one extra classify call but otherwise behaves exactly as before', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { text: '{"complexity": "simple", "steps": []}', stopReason: 'end_turn' },
        { text: 'Hello! How can I help?', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal,
        { planningEnabled: true }
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(provider.requests).toHaveLength(2) // the classify call, then the one normal round
      expect(streamEvents.some((e) => e.type === 'plan')).toBe(false)
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Hello! How can I help?' })
    })

    it('sends only the latest message to the classify call, not the full conversation', async () => {
      // Found live, repeatedly, against the real default model: given the
      // full history (which past the first turn always includes an earlier
      // tool_use/tool_result exchange and a natural-language reply), it
      // drifted into just answering the user's question directly, ignoring
      // the classify instruction entirely — confirmed directly against the
      // real server across several trials (~0% valid-JSON rate with full
      // history vs. ~85% with just the latest message). The full history
      // is never needed for judging structural complexity and actively
      // hurts reliability by giving the model a "just chat" pattern to
      // fall back into.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { text: '{"complexity": "simple", "steps": []}', stopReason: 'end_turn' },
        { text: 'Sure, here you go.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal,
        { planningEnabled: true }
      )

      const priorTurn: Message = { role: 'assistant', content: [{ type: 'text', text: 'An earlier reply.' }] }
      const latest: Message = { role: 'user', content: [{ type: 'text', text: 'latest question' }] }
      await collect(orchestrator, [priorTurn, latest])

      expect(provider.requests[0].messages).toEqual([latest])
    })

    it('a compound plan dispatches each step to its tagged specialist in order, then synthesizes a final answer', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        // Classify call: two steps, two different specialists.
        {
          text: '{"complexity": "compound", "steps": [{"role": "research", "description": "find X"}, {"role": "data", "description": "find Y"}]}',
          stopReason: 'end_turn'
        },
        // Step 1 (nested, research): its own single-round reply.
        { text: 'X is 5.', stopReason: 'end_turn' },
        // Step 2 (nested, data): its own single-round reply.
        { text: 'Y is 10.', stopReason: 'end_turn' },
        // Final synthesis round (outer, untagged).
        { text: 'X is 5 and Y is 10.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal,
        { planningEnabled: true }
      )

      const events = await collect(orchestrator, [
        { role: 'user', content: [{ type: 'text', text: 'find X and Y' }] }
      ])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents).toContainEqual({
        type: 'plan',
        steps: [
          { role: 'research', description: 'find X' },
          { role: 'data', description: 'find Y' }
        ]
      })
      expect(streamEvents).toContainEqual({ type: 'plan_step_start', index: 0 })
      expect(streamEvents).toContainEqual({ type: 'plan_step_done', index: 0, isError: false })
      expect(streamEvents).toContainEqual({ type: 'plan_step_start', index: 1 })
      expect(streamEvents).toContainEqual({ type: 'plan_step_done', index: 1, isError: false })

      // Each step's result was folded into the shared conversation as a real,
      // persisted message (same visibility a normal delegation result gets) —
      // not just a live-only UI signal.
      const userMessages = events.filter((e) => e.kind === 'message' && e.role === 'user')
      expect(
        userMessages.some(
          (e) =>
            e.kind === 'message' &&
            e.content.some((c) => c.type === 'text' && c.text.includes('[Plan step 1 — Research]') && c.text.includes('X is 5.'))
        )
      ).toBe(true)
      expect(
        userMessages.some(
          (e) =>
            e.kind === 'message' &&
            e.content.some((c) => c.type === 'text' && c.text.includes('[Plan step 2 — Data]') && c.text.includes('Y is 10.'))
        )
      ).toBe(true)

      // The final synthesis round is the true end of the run — same untagged,
      // non-tool_use, last-event shape every other test in this file checks.
      expect(streamEvents.at(-1)).toEqual({ type: 'message_stop', stopReason: 'end_turn' })
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'X is 5 and Y is 10.' })
    })

    it('malformed classifier JSON fails open to normal behavior instead of crashing the turn', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { text: 'not valid json at all', stopReason: 'end_turn' },
        { text: 'Hi there!', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal,
        { planningEnabled: true }
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents.some((e) => e.type === 'plan')).toBe(false)
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Hi there!' })
    })

    it('planningEnabled: false skips the classify call entirely', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      // Only one scripted turn — if the classify call fired anyway, this
      // turn would be consumed by it instead and the real reply would throw
      // "MockProvider ran out of scripted turns".
      const provider = new MockProvider([{ text: 'Hi!', stopReason: 'end_turn' }])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal,
        { planningEnabled: false }
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(provider.requests).toHaveLength(1)
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Hi!' })
    })
  })

  describe('resolveMaxOutputTokens (scaling per-round maxTokens off a real model ceiling + context budget)', () => {
    it('scales maxTokens up well past the flat default for a local model with a large, mostly-free live context window', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      // 131072 (a real gpt-oss:20b live reading) with only 1000 tokens
      // already used: remaining=130072, budget=floor(130072*0.5)=65036,
      // clamped to the local-model ceiling (32768 — Ollama has no real
      // per-call rejection risk, unlike a cloud provider's registered max).
      const provider = new MockProvider([{ text: 'Hello!', stopReason: 'end_turn' }], {
        loadedContextWindow: 131072,
        tokensUsed: 1000
      })
      const orchestrator = new Orchestrator(
        provider,
        'gpt-oss:20b', // local-shaped id ("name:tag") — see model-metadata.ts's isLocalModelId
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

      expect(provider.requests).toHaveLength(1)
      expect(provider.requests[0].maxTokens).toBe(32768)
    })

    it('never drops below the 4096 floor even when the live context window is nearly exhausted', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      // remaining = max(0, 5000 - 4900) = 100 tokens — far below any sane
      // floor; the clamp must still guarantee a usable budget.
      const provider = new MockProvider([{ text: 'Hello!', stopReason: 'end_turn' }], {
        loadedContextWindow: 5000,
        tokensUsed: 4900
      })
      const orchestrator = new Orchestrator(
        provider,
        'gpt-oss:20b',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

      expect(provider.requests[0].maxTokens).toBe(4096)
    })

    it('falls back to the static context-window estimate when there is no live reading, still floors at 4096 for an unrecognized model id', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      // No loadedContextWindow option — matches every cloud-provider adapter
      // exactly. 'mock-model' matches no known prefix, so both the window
      // estimate (8192, model-metadata.ts's DEFAULT_CONTEXT_WINDOW) and the
      // output ceiling (4096, DEFAULT_MAX_OUTPUT_TOKENS) are generic
      // fallbacks — remaining=8192, budget=4096, clamped to ceiling 4096.
      // The two independent fallbacks agreeing on 4096 here is coincidence,
      // not a special "no scaling" path — see the two tests below for a
      // *recognized* cloud model actually scaling up and getting clamped.
      const provider = new MockProvider([{ text: 'Hello!', stopReason: 'end_turn' }])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

      expect(provider.requests[0].maxTokens).toBe(4096)
    })

    it('scales a recognized cloud model up dramatically past the old flat 4096, with no live reading needed', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      // 'claude-sonnet-5': static context window 200,000 (CONTEXT_WINDOWS),
      // real output ceiling 128,000 (MAX_OUTPUT_TOKENS) — remaining=200000,
      // budget=floor(200000*0.5)=100000, under the 128000 ceiling so it's
      // not clamped. This is the concrete fix for ordinary Claude replies
      // having been capped to ~4096 (3% of their real ceiling) forever.
      const provider = new MockProvider([{ text: 'Hello!', stopReason: 'end_turn' }])
      const orchestrator = new Orchestrator(
        provider,
        'claude-sonnet-5',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

      expect(provider.requests[0].maxTokens).toBe(100_000)
    })

    it('clamps to the real per-model ceiling even when the computed budget would exceed it', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      // 'gpt-4o': static context window 128,000 (the 'gpt-' CONTEXT_WINDOWS
      // entry), budget=floor(128000*0.5)=64000 — but GPT-4o's real output
      // ceiling is only 16,384, so the clamp must win, not the budget math.
      // Getting this wrong risks a real hard API rejection for exceeding
      // the model's actual max_tokens, exactly the failure mode this
      // design was built to avoid.
      const provider = new MockProvider([{ text: 'Hello!', stopReason: 'end_turn' }])
      const orchestrator = new Orchestrator(
        provider,
        'gpt-4o',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

      expect(provider.requests[0].maxTokens).toBe(16_384)
    })
  })

  describe('truncation reporting (not silently swallowing a hit output-token limit)', () => {
    it('a round ending with stopReason "max_tokens" reports a warning, keeps the partial text, and marks the result as an error', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([{ text: 'This got cut', stopReason: 'max_tokens' }])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      const warning = streamEvents.find((e) => e.type === 'warning')
      expect(warning).toMatchObject({ type: 'warning' })
      expect((warning as { message: string }).message).toMatch(/cut off/i)
      // Partial text is kept, not discarded.
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'This got cut' })

      const messages = events.filter((e) => e.kind === 'message')
      const persistedWarning = messages.find(
        (e) => e.kind === 'message' && e.content.some((c) => c.type === 'warning')
      )
      expect(persistedWarning).toBeDefined()
    })

    it('a delegate whose own round hits the output-token limit surfaces isError on its tool_result, not a silent success', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'call_delegate', name: 'delegate_to_research', input: { task: 'look something up' } }] },
        { text: 'Partial finding', stopReason: 'max_tokens' },
        { text: 'The Research specialist only got a partial result.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal
      )

      const events = await collect(orchestrator, [
        { role: 'user', content: [{ type: 'text', text: 'look something up' }] }
      ])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      const toolResult = streamEvents.find((e) => e.type === 'tool_result')
      expect(toolResult).toMatchObject({ isError: true })
      expect(streamEvents.some((e) => e.type === 'warning' && e.agentRole === 'research')).toBe(true)
    })

    it('a classify-and-plan call that hits the output-token limit reports why, instead of silently falling open unremarked', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        // Empty content + stopReason max_tokens — the exact real shape
        // confirmed live against gpt-oss with too small a budget.
        { text: '', stopReason: 'max_tokens' },
        { text: 'Hello! How can I help?', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal,
        { planningEnabled: true }
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      const warning = streamEvents.find((e) => e.type === 'warning')
      expect(warning).toBeDefined()
      expect((warning as { message: string }).message).toMatch(/output-token limit/i)
      // Still falls open to normal behavior — the real reply still happens.
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Hello! How can I help?' })
    })

    it('a classify-and-plan call returning genuinely malformed (non-truncated) JSON falls open silently — no chat-visible warning, unlike the output-token-limit case above', async () => {
      // Reported directly: a local model (gpt-oss especially) not returning
      // valid JSON for this structured-output probe is the expected,
      // routine case, not a real problem — a persisted chat warning for it
      // had no actionable next step and just read as noise. Distinct from
      // the output-token-limit case above, which stays surfaced since it's
      // a genuine correctness concern (an empty/cut-off response).
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { text: 'not json at all', stopReason: 'end_turn' },
        { text: 'Hi there!', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal,
        { planningEnabled: true }
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents.find((e) => e.type === 'warning')).toBeUndefined()
      expect(events.some((e) => e.kind === 'message' && e.content.some((c) => c.type === 'warning'))).toBe(false)
      // Still falls open to normal behavior — the real reply still happens.
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Hi there!' })
    })
  })
})
