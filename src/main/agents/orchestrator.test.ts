import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@shared/protocol'
import type { AgentRole } from '@shared/agents'
import { MockProvider, type ScriptedTurn } from '../../../test/support/mock-provider'
import { WorkspaceGuard } from '../security/workspace-guard'
import { ToolRegistry } from '../tools/registry'
import { readFileTool, listDirectoryTool, writeFileTool } from '../tools/file-ops'
import { pptxAddSlideTool, pptxComposeSlideTool, pptxSaveDeckTool, pptxStartDeckTool } from '../tools/deck'
import { officeReadDocumentTool } from '../tools/office-docs/read'
import type { ToolContext } from '../tools/types'
import { createAgents } from './roles'
import { Orchestrator, type Agent, type ConfirmDecision, type OrchestratorEvent, type ToolConfirmRequest } from './orchestrator'

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

  it('in Auto mode, the top level can use a specialist-labeled mutating tool directly, without delegating, still through real confirmation and correct (undefined) attribution (TASKS.md #96)', async () => {
    // Confirmed intentional, not a bug: the top-level orchestrator is
    // constructed with the *entire* default tool registry (registry.list()
    // below, exactly matching how ipc/register.ts really constructs it),
    // not just delegation tools — write_file is "Coding's tool" only by
    // prompt convention, not by actual access control. This test is the
    // regression coverage #96 asks for: confirmation and role/audit
    // attribution must both still behave correctly on this direct path,
    // not just the delegated one covered by the test above.
    const registry = buildRegistry()
    const agents = createAgents(registry)
    const confirmCalls: { name: string; input: Record<string, unknown> }[] = []
    const confirmAndApprove = async (request: ToolConfirmRequest): Promise<ConfirmDecision> => {
      confirmCalls.push({ name: request.name, input: request.input })
      return { approved: true, input: request.input }
    }
    const provider = new MockProvider([
      { toolCalls: [{ id: 'call_write', name: 'write_file', input: { path: 'direct.txt', content: 'no delegate' } }] },
      { text: 'Wrote it directly.', stopReason: 'end_turn' }
    ])
    const orchestrator = new Orchestrator(
      provider,
      'mock-model',
      agents,
      'You are Sachivji.',
      registry.list(),
      confirmAndApprove,
      ctx,
      signal
    )

    const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'write direct.txt' }] }])

    // Real confirmation actually ran — not silently bypassed just because
    // this call didn't go through a delegate_to_x tool first.
    expect(confirmCalls).toEqual([{ name: 'write_file', input: { path: 'direct.txt', content: 'no delegate' } }])
    expect(await readFile(join(root, 'direct.txt'), 'utf-8')).toBe('no delegate')

    const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)
    const writeStart = streamEvents.find((e) => e.type === 'tool_use_start' && e.name === 'write_file')
    // Correctly attributed to the orchestrator itself (undefined), not
    // mislabeled as any specialist just because it's "usually" Coding's tool.
    expect((writeStart as { agentRole?: string } | undefined)?.agentRole).toBeUndefined()
    const toolResult = streamEvents.find((e) => e.type === 'tool_result')
    expect(toolResult).toMatchObject({ type: 'tool_result', isError: false })
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
      { type: 'status', message: 'Model (mock-model) is thinking… (round 1/20)' },
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

  describe('classify-gate: skipping the classifier call for obviously simple requests (TASKS.md #95)', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('an unambiguous short message skips the classify call entirely when not sampled for calibration', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.99) // above CALIBRATION_SAMPLE_RATE — no sampling this turn
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([{ text: 'Hello!', stopReason: 'end_turn' }])
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

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

      // Only the one normal round — no classify call at all.
      expect(provider.requests).toHaveLength(1)
    })

    it('a message with a compound signal still always goes through the real classifier, gate or no gate', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.99)
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { text: '{"complexity": "simple", "steps": []}', stopReason: 'end_turn' },
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
        signal,
        { planningEnabled: true }
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'find X and save it' }] }])

      expect(provider.requests).toHaveLength(2) // classify call + one normal round
    })

    it('phase 2: a skip-worthy message is still occasionally sampled through the real classifier, for calibration', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0) // below CALIBRATION_SAMPLE_RATE — always samples
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { text: '{"complexity": "simple", "steps": []}', stopReason: 'end_turn' },
        { text: 'Hello!', stopReason: 'end_turn' }
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

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

      // Sampled anyway despite being a skip-worthy message — the real
      // classifier call happened, its result acted on normally.
      expect(provider.requests).toHaveLength(2)
    })

    it('logs the gate verdict alongside the real classifier result, only when the classifier actually ran', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.99)
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const samples: { gateVerdict: string; classifierComplexity: string; messageLength: number }[] = []
      const provider = new MockProvider([
        { text: '{"complexity": "compound", "steps": [{"role": "research", "description": "x"}, {"role": "data", "description": "y"}]}', stopReason: 'end_turn' },
        { text: 'step', stopReason: 'end_turn' },
        { text: 'step', stopReason: 'end_turn' },
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
        signal,
        { planningEnabled: true, logClassifyGateSample: (sample) => samples.push(sample) }
      )

      const message = 'find X and Y'
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: message }] }])

      expect(samples).toEqual([{ gateVerdict: 'run', classifierComplexity: 'compound', messageLength: message.length }])
    })

    it('does not log anything when the gate skips and no sampling happens — nothing real to compare against', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.99)
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const samples: unknown[] = []
      const provider = new MockProvider([{ text: 'Hello!', stopReason: 'end_turn' }])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal,
        { planningEnabled: true, logClassifyGateSample: (sample) => samples.push(sample) }
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

      expect(samples).toEqual([])
    })
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

      // "hi and thanks" (not just "hi") deliberately bypasses the
      // classify-gate (#95) so this stays a direct test of classifyAndPlan
      // itself, not of the gate's own skip decision (covered separately in
      // classify-gate.test.ts).
      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(provider.requests).toHaveLength(2) // the classify call, then the one normal round
      expect(streamEvents.some((e) => e.type === 'plan')).toBe(false)
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Hello! How can I help?' })
    })

    it('Stop clicked during the classify call ends the whole turn immediately — it must not silently fall through into a brand-new full round', async () => {
      // Real bug, found live: classifyAndPlan's own catch swallows an abort
      // and returns `undefined` quietly (same shape as "no plan needed"),
      // relying on the caller to notice the signal is already aborted.
      // run() didn't check that before falling through to a normal runLoop
      // round — so clicking Stop while classify-and-plan was in flight
      // silently discarded the cancellation and started a whole new model
      // call anyway. The second scripted turn below is a real, successful
      // response the bug would have let through; the fix must never reach
      // it at all.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const controller = new AbortController()
      controller.abort()
      const provider = new MockProvider([
        { throwError: 'simulated SDK abort error' },
        { text: 'This should never be reached', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        controller.signal,
        { planningEnabled: true }
      )

      // Bypasses the classify-gate (#95) deliberately — see the identical
      // note on the first test in this describe block.
      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents).toEqual([{ type: 'message_stop', stopReason: 'aborted' }])
      expect(provider.requests).toHaveLength(1)
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
      // "and" bypasses the classify-gate (#95) deliberately — see the note
      // on the first test in this describe block.
      const latest: Message = { role: 'user', content: [{ type: 'text', text: 'latest question and one more' }] }
      await collect(orchestrator, [priorTurn, latest])

      expect(provider.requests[0].messages).toEqual([latest])
    })

    it('never lists page-creator as a classify-able role, and tells the model deck-building is never a plan step', async () => {
      // Real bug, found live: page-creator is deliberately excluded from
      // AGENT_ROLES/VALID_STEP_ROLES (shared/agents.ts's own doc comment —
      // it's isolated, delegate-only, expects a one-slide brief) but
      // buildClassifySystemPrompt previously listed it anyway (iterating
      // the raw agents map, not the same AGENT_ROLES-filtered set
      // VALID_STEP_ROLES validates against) — a classify call could "pick"
      // an option that was always going to make parsePlan silently reject
      // the whole plan. Separately: a presentation request was seen live
      // getting planned as a "coding" step, which has no deck-building
      // tools at all and fell back to a much worse plain-bullet-list tool
      // instead — the prompt now says so explicitly.
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

      // Bypasses the classify-gate (#95) deliberately — see the note on the
      // first test in this describe block.
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])

      const classifySystem = provider.requests[0].system ?? ''
      expect(classifySystem).not.toMatch(/-\s*page-creator:/)
      expect(classifySystem).toMatch(/deck-building/i)
      expect(classifySystem).toContain('research')
      expect(classifySystem).toContain('coding')
    })

    it('explicitly tells the classifier not to fold "gather info, then save a file" into one research-only step', async () => {
      // Found live: "search for X and write it into a Word document" was
      // classified as a single "simple" step routed to research, which has
      // no file-writing tools at all — the document part silently never
      // happened, and the user had to ask again to get the file.
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

      // Bypasses the classify-gate (#95) deliberately — see the note on the
      // first test in this describe block.
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])

      const classifySystem = provider.requests[0].system ?? ''
      expect(classifySystem).toMatch(/write it into a Word document/i)
      expect(classifySystem).toMatch(/research has no file-writing tools/i)
    })

    it('explicitly tells the classifier that writing code and running it are two separate steps, not one', async () => {
      // Found live: "generate a chart image from this data" was classified
      // as a single "coding" step. Coding wrote the Python script, tried to
      // run it directly, hit "Unknown tool" (coding has no shell access at
      // all), and reported success anyway without the file ever existing —
      // it only got created several delegate calls later, once the
      // top-level orchestrator gave up delegating and ran shell_execute
      // itself.
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

      // Bypasses the classify-gate (#95) deliberately — see the note on the
      // first test in this describe block.
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])

      const classifySystem = provider.requests[0].system ?? ''
      expect(classifySystem).toMatch(/code to be written AND actually run/i)
      expect(classifySystem).toMatch(/coding has no shell access at all/i)
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

    it('a plan with more than the step cap is truncated, with a warning, rather than run in full (TASKS.md #94)', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const sevenSteps = Array.from({ length: 7 }, (_, i) => `{"role": "research", "description": "step ${i + 1}"}`).join(', ')
      const provider = new MockProvider([
        { text: `{"complexity": "compound", "steps": [${sevenSteps}]}`, stopReason: 'end_turn' },
        // Only 5 steps should actually dispatch, so only 5 nested + 1 synthesis call are scripted.
        { text: 'step 1 done', stopReason: 'end_turn' },
        { text: 'step 2 done', stopReason: 'end_turn' },
        { text: 'step 3 done', stopReason: 'end_turn' },
        { text: 'step 4 done', stopReason: 'end_turn' },
        { text: 'step 5 done', stopReason: 'end_turn' },
        { text: 'all done', stopReason: 'end_turn' }
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

      // Bypasses the classify-gate (#95) deliberately — see the note on the
      // first test in this describe block.
      const events = await collect(orchestrator, [
        { role: 'user', content: [{ type: 'text', text: 'do seven things and report back' }] }
      ])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      const planEvent = streamEvents.find((e) => e.type === 'plan')
      expect(planEvent).toMatchObject({ type: 'plan', steps: expect.any(Array) })
      expect(planEvent && 'steps' in planEvent ? planEvent.steps.length : -1).toBe(5)
      expect(streamEvents.some((e) => e.type === 'plan_step_start' && e.index === 5)).toBe(false)
      expect(
        streamEvents.some((e) => e.type === 'warning' && e.message.includes('more steps than the 5-step limit'))
      ).toBe(true)
      expect(streamEvents.at(-1)).toEqual({ type: 'message_stop', stopReason: 'end_turn' })
    })

    it("a failed plan step's result is marked FAILED in the shared conversation, not left indistinguishable from real data", async () => {
      // Found live via review, not yet in production: `plan_step_done`'s
      // `isError` only ever reached the renderer's ✓/✗ UI — the actual text
      // folded into the conversation (the only copy of a step's outcome any
      // later step or the final synthesis round ever sees) formatted a
      // failure identically to a real result. A later step (e.g. Coding,
      // asked to write a report from step 1's data) had no structural
      // reason to notice "Unknown data connection" wasn't real data.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        {
          text: '{"complexity": "compound", "steps": [{"role": "data", "description": "get sales figures"}, {"role": "coding", "description": "write a report from the figures"}]}',
          stopReason: 'end_turn'
        },
        // Step 1 (data) genuinely fails — a real provider/tool error, not a timeout.
        { throwError: 'Unknown data connection "sales_db".' },
        // Step 2 (coding) still runs regardless — this app's deliberate
        // design (see the wrap-up-call comments elsewhere in this file):
        // report what's real rather than aborting the rest of the plan.
        { text: "I can't write the report — no sales data was available.", stopReason: 'end_turn' },
        { text: 'The report could not be completed.', stopReason: 'end_turn' }
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
        { role: 'user', content: [{ type: 'text', text: 'get sales figures and write a report' }] }
      ])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)
      expect(streamEvents).toContainEqual({ type: 'plan_step_done', index: 0, isError: true })

      const userMessages = events.filter((e) => e.kind === 'message' && e.role === 'user')
      const step1Text = userMessages
        .flatMap((e) => (e.kind === 'message' ? e.content : []))
        .find((c) => c.type === 'text' && c.text.includes('[Plan step 1 — Data]'))
      expect(step1Text && step1Text.type === 'text' ? step1Text.text : '').toMatch(
        /\[Plan step 1 — Data\] \(FAILED — no usable result\):/
      )
      expect(
        step1Text && step1Text.type === 'text' ? step1Text.text : ''
      ).toContain('Unknown data connection "sales_db".')

      // A step that actually succeeded must NOT get the FAILED marker.
      const step2Text = userMessages
        .flatMap((e) => (e.kind === 'message' ? e.content : []))
        .find((c) => c.type === 'text' && c.text.includes('[Plan step 2 — Coding]'))
      expect(step2Text && step2Text.type === 'text' ? step2Text.text : '').toMatch(/^\[Plan step 2 — Coding\]:/)
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

      // Bypasses the classify-gate (#95) deliberately — see the note on the
      // first test in this describe block.
      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
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

    it('subtracts real system-prompt/tool-schema overhead, not just the conversation (TASKS.md #97)', async () => {
      // Before #97, only `countTokens(conversation)` was subtracted from the
      // context window — the system prompt and tool schemas sent in the same
      // request were silently assumed to fit in the margin. Picking a
      // tokensUsed large enough that the old behavior would've hit the local
      // model's 32768 ceiling, but the new overhead-aware behavior lands
      // below it, proves the overhead call's result is actually subtracted,
      // not just made.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      // remaining (old, conversation only) = 131072 - 40000 = 91072,
      // budget = floor(91072*0.5) = 45536, clamped to ceiling 32768.
      // remaining (new, conversation + overhead) = 131072 - 40000 - 40000 =
      // 51072, budget = floor(51072*0.5) = 25536 — under the ceiling, so the
      // clamp no longer hides the difference.
      const provider = new MockProvider([{ text: 'Hello!', stopReason: 'end_turn' }], {
        loadedContextWindow: 131072,
        tokensUsed: 40000
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

      expect(provider.countTokensCalls).toHaveLength(2)
      // The second call is the overhead probe — a single synthetic message
      // carrying the real orchestrator system prompt and serialized tool
      // schemas, not the actual conversation.
      const overheadCall = provider.countTokensCalls[1]
      const overheadText = overheadCall[0]?.content[0]
      expect(overheadText).toMatchObject({ type: 'text' })
      if (overheadText?.type === 'text') {
        expect(overheadText.text).toContain('You are Sachivji.')
        expect(overheadText.text).toContain('read_file')
      }
      expect(provider.requests[0].maxTokens).toBe(25536)
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

    it('a round that ends cleanly (not max_tokens) with no text and no tool call reports a warning instead of ending in total silence', async () => {
      // Found live against gpt-oss/Ollama on a long, tool-heavy conversation:
      // the stream ended with finish_reason "stop" (the output budget was
      // never hit — a real "max_tokens" round would have a different
      // warning, tested above) yet produced no visible content and no tool
      // call at all. Before this existed, the turn just ended with nothing
      // persisted and nothing shown — indistinguishable from the app having
      // silently done nothing.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([{ text: '', stopReason: 'end_turn' }])
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
      expect((warning as { message: string }).message).toMatch(/no visible output/i)

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

      // Bypasses the classify-gate (#95) deliberately — see this file's
      // "classify-and-plan (planningEnabled)" describe block for the same note.
      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
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

      // Bypasses the classify-gate (#95) deliberately — see this file's
      // "classify-and-plan (planningEnabled)" describe block for the same note.
      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents.find((e) => e.type === 'warning')).toBeUndefined()
      expect(events.some((e) => e.kind === 'message' && e.content.some((c) => c.type === 'warning'))).toBe(false)
      // Still falls open to normal behavior — the real reply still happens.
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Hi there!' })
    })
  })

  describe('exhausting the MAX_TOTAL_ROUNDS budget (previously untested — a real bug found live)', () => {
    // Mirrors orchestrator.ts's own private MAX_TOTAL_ROUNDS — see that
    // describe block's own such mirrors elsewhere in this file for why
    // (drives real scripted-turn counts/assertions instead of importing it).
    const MAX_TOTAL_ROUNDS = 20

    it('synthesizes a real answer from what was actually gathered instead of a bare "stopped" stub', async () => {
      // Reported directly: real, on-topic content had already been found
      // via tool calls across many rounds, but the user got nothing but a
      // bare "Stopped after N agent rounds" message — everything gathered
      // was discarded. This scripts exactly that: a full budget's worth of
      // rounds of a real tool call (never finishing on its own), then one
      // final text-only turn the fix's wrap-up call should reach.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      await writeFileTool.execute({ path: 'note.txt', content: 'real gathered content' }, ctx)

      const toolCallTurn: ScriptedTurn = {
        toolCalls: [{ id: 'call', name: 'read_file', input: { path: 'note.txt' } }],
        stopReason: 'tool_use'
      }
      const turns: ScriptedTurn[] = Array.from({ length: MAX_TOTAL_ROUNDS }, () => toolCallTurn)
      turns.push({ text: 'Based on everything gathered above, here is the real synthesized answer.', stopReason: 'end_turn' })

      const provider = new MockProvider(turns)
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

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'keep going' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents).toContainEqual({
        type: 'text_delta',
        text: 'Based on everything gathered above, here is the real synthesized answer.'
      })
      expect(provider.requests).toHaveLength(MAX_TOTAL_ROUNDS + 1) // N real rounds + 1 wrap-up
      const wrapUpRequest = provider.requests[MAX_TOTAL_ROUNDS]
      expect(wrapUpRequest.tools).toBeUndefined() // forces a text-only reply — genuinely cannot loop further
      expect(wrapUpRequest.system).toMatch(new RegExp(`used all ${MAX_TOTAL_ROUNDS} rounds`, 'i'))

      // The renderer's "is this turn actually finished" detection depends on
      // a real message_stop for this wrap-up round specifically, not just
      // the earlier per-round ones — an earlier draft of this fix silently
      // dropped it, which would have left the composer looking stuck even
      // with a real answer already delivered.
      const finalStop = streamEvents.find((e) => e.type === 'message_stop' && e.stopReason !== 'tool_use')
      expect(finalStop).toBeDefined()
    })

    it('falls back to the honest "stopped" stub, still visible to the user, if the wrap-up call itself produces nothing', async () => {
      // Goes through real delegation (delegate_to_coding), not a plain
      // top-level call. dispatchDelegate wraps runLoop's returned text into
      // a real tool_result unconditionally, so the stub is genuinely
      // visible either way; a plain top-level exhaustion's return value is
      // never wrapped into a message at all, which isn't what this is checking.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      await writeFileTool.execute({ path: 'note.txt', content: 'x' }, ctx)

      const toolCallTurn: ScriptedTurn = {
        toolCalls: [{ id: 'call', name: 'read_file', input: { path: 'note.txt' } }],
        stopReason: 'tool_use'
      }
      const turns: ScriptedTurn[] = [
        // Round 1 (top-level): delegate to Coding.
        { toolCalls: [{ id: 'd1', name: 'delegate_to_coding', input: { task: 'keep reading' } }], stopReason: 'tool_use' },
        // The delegate's own fresh budget (MAX_TOTAL_ROUNDS - 1 real calls, since
        // it's already used its first round on the initial delegate dispatch itself
        // from the top level's perspective — but its OWN nested counter starts at
        // 0, so it gets the full budget): real tool calls, never finishing on their own.
        ...Array.from({ length: MAX_TOTAL_ROUNDS }, () => toolCallTurn),
        // Nested wrap-up (the delegate's OWN round budget now exhausted): produces nothing.
        { stopReason: 'end_turn' },
        // Top-level's own synthesis — its own counter is barely touched (just the
        // one delegate-dispatch round), so it gets a full, uncascaded round budget
        // and can produce a real answer even though the delegate ran out.
        { text: 'The Coding specialist ran out of rounds without finishing; here is what it found regardless.', stopReason: 'end_turn' }
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
        signal,
        { planningEnabled: false }
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'keep going' }] }])
      const toolResults = events
        .filter((e) => e.kind === 'stream' && e.event.type === 'tool_result')
        .map((e) => (e.kind === 'stream' && e.event.type === 'tool_result' ? e.event.content : ''))

      expect(toolResults).toContainEqual(`Stopped after ${MAX_TOTAL_ROUNDS} agent rounds.`)
      // The real point of per-delegate budgets: the top level is NOT also
      // immediately exhausted just because its delegate was — it still
      // produces a real final answer instead of cascading into its own stub.
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)
      expect(streamEvents).toContainEqual({
        type: 'text_delta',
        text: 'The Coding specialist ran out of rounds without finishing; here is what it found regardless.'
      })
    })

    it("one delegate exhausting its own round budget does not starve a second delegate's or the top level's own budget", async () => {
      // The concrete fix: previously all of this drew from one shared
      // MAX_TOTAL_ROUNDS pool, so a heavy first delegate call could leave
      // nothing for a second one invoked later in the same turn. Now each
      // gets its own fresh pool.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      await writeFileTool.execute({ path: 'note.txt', content: 'x' }, ctx)

      const toolCallTurn: ScriptedTurn = {
        toolCalls: [{ id: 'call', name: 'read_file', input: { path: 'note.txt' } }],
        stopReason: 'tool_use'
      }
      const turns: ScriptedTurn[] = [
        // Round 1 (top-level): delegate to Coding, which then burns its
        // *entire own* fresh budget without ever finishing.
        { toolCalls: [{ id: 'd1', name: 'delegate_to_coding', input: { task: 'dig deep' } }], stopReason: 'tool_use' },
        ...Array.from({ length: MAX_TOTAL_ROUNDS }, () => toolCallTurn),
        { stopReason: 'end_turn' }, // Coding's own wrap-up: exhausted, produces nothing.
        // Round 2 (top-level): now delegate to Data — a completely fresh
        // delegate call, which must get its own full, unstarved budget.
        {
          toolCalls: [{ id: 'd2', name: 'delegate_to_data', input: { task: 'look this up instead' } }],
          stopReason: 'tool_use'
        },
        // Data's very first round already produces a real answer — proving
        // it wasn't handed an already-exhausted counter from Research.
        { text: 'Found it via Data instead.', stopReason: 'end_turn' },
        // Top-level's own final synthesis.
        { text: 'Here is the answer, found via the Data specialist.', stopReason: 'end_turn' }
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
        signal,
        { planningEnabled: false }
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'find this' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Found it via Data instead.', agentRole: 'data' })
      expect(streamEvents).toContainEqual({
        type: 'text_delta',
        text: 'Here is the answer, found via the Data specialist.'
      })
    })

    it('asks before abandoning when options.confirmContinue is set, and actually finishes the work if granted more budget', async () => {
      // The point of the whole feature: a turn making genuine, still-
      // succeeding progress (found live: a real multi-step Docker
      // build/debug cycle) shouldn't be silently wrapped into a summary
      // just because it needed one round more than the budget allowed.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      await writeFileTool.execute({ path: 'note.txt', content: 'x' }, ctx)

      const toolCallTurn: ScriptedTurn = {
        toolCalls: [{ id: 'call', name: 'read_file', input: { path: 'note.txt' } }],
        stopReason: 'tool_use'
      }
      const turns: ScriptedTurn[] = [
        ...Array.from({ length: MAX_TOTAL_ROUNDS }, () => toolCallTurn),
        // Granted one more round after confirmContinue says yes — finishes for real here.
        { text: 'Finished for real after being granted more time.', stopReason: 'end_turn' }
      ]

      const provider = new MockProvider(turns)
      let askedWith: { reason: string; roundsUsed: number; maxRounds: number } | undefined
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        signal,
        {
          planningEnabled: false,
          confirmContinue: async (request) => {
            askedWith = request
            return { continueWorking: true }
          }
        }
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'keep going' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(askedWith).toEqual({
        requestId: expect.any(String),
        reason: 'rounds',
        roundsUsed: MAX_TOTAL_ROUNDS,
        maxRounds: MAX_TOTAL_ROUNDS
      })
      // Never reached the wrap-up's tools-disabled synthesis call at all —
      // continuing re-entered the real round loop instead.
      expect(streamEvents).toContainEqual({
        type: 'text_delta',
        text: 'Finished for real after being granted more time.'
      })
      expect(streamEvents.some((e) => e.type === 'warning')).toBe(false)
    })

    it('proceeds to the normal wrap-up stub if the user chooses to stop when asked', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      await writeFileTool.execute({ path: 'note.txt', content: 'x' }, ctx)

      const toolCallTurn: ScriptedTurn = {
        toolCalls: [{ id: 'call', name: 'read_file', input: { path: 'note.txt' } }],
        stopReason: 'tool_use'
      }
      const turns: ScriptedTurn[] = [
        ...Array.from({ length: MAX_TOTAL_ROUNDS }, () => toolCallTurn),
        { text: 'Here is what was found before stopping.', stopReason: 'end_turn' } // the wrap-up call
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
        signal,
        { planningEnabled: false, confirmContinue: async () => ({ continueWorking: false }) }
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'keep going' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(provider.requests).toHaveLength(MAX_TOTAL_ROUNDS + 1) // N real rounds + 1 wrap-up, no extra continued rounds
      expect(streamEvents).toContainEqual({
        type: 'text_delta',
        text: 'Here is what was found before stopping.'
      })
    })

    it('a genuine user Stop while the continue-or-stop question is pending resolves it as "stop" immediately', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      await writeFileTool.execute({ path: 'note.txt', content: 'x' }, ctx)

      const toolCallTurn: ScriptedTurn = {
        toolCalls: [{ id: 'call', name: 'read_file', input: { path: 'note.txt' } }],
        stopReason: 'tool_use'
      }
      const turns: ScriptedTurn[] = Array.from({ length: MAX_TOTAL_ROUNDS }, () => toolCallTurn)

      const provider = new MockProvider(turns)
      const controller = new AbortController()
      // Resolved by confirmContinue itself the instant it's actually called
      // — waiting on this real signal instead of guessing how many
      // microtask ticks MAX_TOTAL_ROUNDS real rounds take to run through.
      let reachedConfirm: () => void = () => {}
      const confirmReached = new Promise<void>((resolve) => {
        reachedConfirm = resolve
      })
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        controller.signal,
        {
          planningEnabled: false,
          // The returned decision promise never resolves on its own — only
          // the Stop-click's abort race should settle it.
          confirmContinue: () => {
            reachedConfirm()
            return new Promise(() => {})
          }
        }
      )

      const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'keep going' }] }])
      await confirmReached
      controller.abort()
      await resultPromise
      // No throw, no hang — resolving via the abort race is enough to prove
      // this doesn't wait on a promise that (by design in this test) never settles.
    })
  })

  describe('round timeout and turn deadline (a real turn sat unresponsive for over an hour, found live)', () => {
    // Mirrors orchestrator.ts's own private constants (not exported — these
    // tests drive real wall-clock time via fake timers rather than
    // importing them, so a change to any of them shows up here as a real,
    // meaningful test failure instead of silently staying in sync).
    const ROUND_TIMEOUT_MS = 5 * 60 * 1000
    const ROUND_TIMEOUT_FLOOR_MS = 30 * 1000
    const ROUND_TIMEOUT_SAFETY_MARGIN_MS = 60 * 1000
    const TURN_DEADLINE_MS = 15 * 60 * 1000

    /**
     * Mirrors startRoundTimer's adaptive budget formula: a round's timeout
     * grows with each consecutive retry (roughly doubling), bounded by the
     * actual remaining turn budget (minus a safety margin) and a floor. Lets
     * these tests advance fake time by exactly the real amount each round
     * will wait, rather than assuming every round waits a flat 5 minutes.
     */
    function roundBudgetMs(remainingMs: number, consecutiveRoundTimeouts: number): number {
      return Math.max(
        ROUND_TIMEOUT_FLOOR_MS,
        Math.min(remainingMs - ROUND_TIMEOUT_SAFETY_MARGIN_MS, ROUND_TIMEOUT_MS * (consecutiveRoundTimeouts + 1))
      )
    }

    /**
     * The exact sequence of hang-round advances needed to cross a shared
     * TURN_DEADLINE_MS purely via consecutive round-timeouts, starting from
     * however much of the deadline is already elapsed. Because later
     * rounds' budgets shrink as the deadline nears (floored at 30s), this
     * is 4 rounds under today's constants, not 3 — a direct, worked-out
     * consequence of the adaptive design (verified via simulation), not a
     * guess.
     */
    function hangRoundAdvancesToDeadline(elapsedAtStart = 0): number[] {
      const advances: number[] = []
      let elapsed = elapsedAtStart
      let consecutive = 0
      while (elapsed < TURN_DEADLINE_MS) {
        const budget = roundBudgetMs(TURN_DEADLINE_MS - elapsed, consecutive)
        const advance = budget + 1000
        advances.push(advance)
        elapsed += advance
        consecutive++
      }
      return advances
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('a single round that never produces anything is stopped after ROUND_TIMEOUT_MS, cleanly — not left hanging, not rethrown as a genuine error', async () => {
      // Found live: a real round sat with zero pending network activity and
      // zero pending promises anywhere in the process, yet never resolved
      // and never told the renderer it was done — Stop had nothing left to
      // cancel, and the composer stayed stuck forever. `hang: true` (see
      // mock-provider.ts) simulates exactly that shape: a stream that only
      // ever settles via its AbortSignal, the same way a real fetch-based
      // provider behaves when aborted mid-request.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { hang: true },
        { text: 'Recovered after the stuck round.', stopReason: 'end_turn' }
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
        { planningEnabled: false }
      )

      const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      await vi.advanceTimersByTimeAsync(ROUND_TIMEOUT_MS + 1000)
      const events = await resultPromise
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      const warning = streamEvents.find((e) => e.type === 'warning')
      expect(warning).toBeDefined()
      // Wording deliberately attributes the delay to the model, not a
      // "stuck tool" — the actual confusion reported live.
      expect((warning as { message: string }).message).toMatch(/not a tool being stuck/i)
      expect((warning as { message: string }).message).toMatch(/after over 5 minute/i)
      // The turn didn't just die with the stuck round — unlike a genuine
      // user Stop (which still ends the turn immediately, untouched by
      // this fix), a timed-out round is treated as one failed attempt and
      // the loop moves on to a real next round, ending normally.
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Recovered after the stuck round.' })
      expect(streamEvents).toContainEqual({ type: 'message_stop', stopReason: 'end_turn' })
      expect(streamEvents.some((e) => e.type === 'message_stop' && e.stopReason === 'aborted')).toBe(false)
      expect(provider.requests).toHaveLength(2)
    })

    it('a genuine user Stop during a hung round still ends the whole turn immediately — only a *timeout* is treated as recoverable', async () => {
      // The critical distinction the round-timeout fix must preserve: an
      // actual Stop click is not "one round failed, try again" — the user
      // asked for the whole thing to stop, right now, same as it always
      // has.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const controller = new AbortController()
      const provider = new MockProvider([
        { hang: true },
        { text: 'Should never be reached — the user stopped it.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        controller.signal,
        { planningEnabled: false }
      )

      const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      controller.abort()
      const events = await resultPromise
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents).toContainEqual({ type: 'message_stop', stopReason: 'aborted' })
      expect(streamEvents.some((e) => e.type === 'warning')).toBe(false) // no "took too long" — this wasn't a timeout
      expect(provider.requests).toHaveLength(1) // never reached the 2nd scripted turn
    })

    it('a hung round that ends SILENTLY on abort (no thrown error — the real openai/Ollama shape) is also retried, not misread as an empty response', async () => {
      // The actual bug found live: Anthropic's/Google's SDKs throw when a
      // stalled request's AbortSignal fires (the `hang: true` shape tested
      // above), but the `openai` SDK — used for both OpenAI and Ollama —
      // does not: confirmed by reading its source and by a direct
      // reproduction against a real HTTP server. Its stream just ends
      // cleanly, which streamOpenAICompatible's own end-of-stream fallback
      // turns into an ordinary-looking empty `end_turn`. Before this fix,
      // that was indistinguishable from a genuine empty response and ended
      // the whole round with "a known quirk with local reasoning models"
      // instead of ever retrying — `provider.requests` stayed at 1 for the
      // rest of the turn's budget in a real repro of this exact shape.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { hangSilently: true },
        { text: 'Recovered after the silently-stuck round.', stopReason: 'end_turn' }
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
        { planningEnabled: false }
      )

      const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      await vi.advanceTimersByTimeAsync(ROUND_TIMEOUT_MS + 1000)
      const events = await resultPromise
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      const warning = streamEvents.find((e) => e.type === 'warning')
      expect(warning).toBeDefined()
      expect((warning as { message: string }).message).toMatch(/not a tool being stuck/i)
      expect((warning as { message: string }).message).toMatch(/after over 5 minute/i)
      // Must NOT have been misread as "the model produced no output" — that
      // warning has completely different wording and, critically, ends the
      // turn instead of retrying.
      expect(streamEvents.some((e) => e.type === 'warning' && /no visible output/i.test(e.message))).toBe(false)
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Recovered after the silently-stuck round.' })
      expect(streamEvents).toContainEqual({ type: 'message_stop', stopReason: 'end_turn' })
      expect(streamEvents.some((e) => e.type === 'message_stop' && e.stopReason === 'aborted')).toBe(false)
      expect(provider.requests).toHaveLength(2)
    })

    it('a genuine user Stop during a SILENTLY-hung round still ends the whole turn immediately, not misread as an empty response', async () => {
      // The other half of the same distinction: a real Stop during the
      // silent-end shape must still report 'aborted', not fall into the
      // "model said nothing" warning path just because nothing threw.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const controller = new AbortController()
      const provider = new MockProvider([
        { hangSilently: true },
        { text: 'Should never be reached — the user stopped it.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        controller.signal,
        { planningEnabled: false }
      )

      const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      controller.abort()
      const events = await resultPromise
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents).toContainEqual({ type: 'message_stop', stopReason: 'aborted' })
      expect(streamEvents.some((e) => e.type === 'warning')).toBe(false)
      expect(provider.requests).toHaveLength(1) // never reached the 2nd scripted turn
    })

    it('a whole turn past TURN_DEADLINE_MS stops starting new rounds and synthesizes from what was already gathered, distinct wording from a round-count exhaustion', async () => {
      // Consecutive round-timeouts each get a growing budget (see
      // roundBudgetMs above) rather than a flat 5 minutes every time, so it
      // takes 4 hung rounds under today's constants — not 3 — to actually
      // cross the 15-minute turn deadline (worked out via
      // hangRoundAdvancesToDeadline, not assumed). Once the last one's own
      // timeout fires past the deadline, a further round is never even
      // attempted; the wrap-up path fires instead, with wording that
      // reflects "took too long" rather than "used all N rounds" (a real,
      // separate exhaustion reason from MAX_TOTAL_ROUNDS, well under it
      // here — only 4 of the shared 12 rounds were actually used).
      const advances = hangRoundAdvancesToDeadline()
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        ...advances.map(() => ({ hang: true }) as const),
        { text: 'Here is what was gathered before time ran out.', stopReason: 'end_turn' as const }
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
        { planningEnabled: false }
      )

      const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      for (const advance of advances) {
        await vi.advanceTimersByTimeAsync(advance)
      }
      const events = await resultPromise
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents).toContainEqual({
        type: 'text_delta',
        text: 'Here is what was gathered before time ran out.'
      })
      // N timed-out rounds + 1 wrap-up — a further real round was never
      // attempted once the turn deadline had passed.
      expect(provider.requests).toHaveLength(advances.length + 1)
      const wrapUpRequest = provider.requests[advances.length]
      expect(wrapUpRequest.tools).toBeUndefined()
      expect(wrapUpRequest.system).toMatch(/taking too long/i)
      expect(wrapUpRequest.system).not.toMatch(/used all \d+ rounds/i)
    }, 20000)

    it('an isolated delegate inherits the parent turn\'s deadline — its fresh round *count* does not also mean a fresh 15 minutes', async () => {
      // #77's isolated delegation gives a role like `email` (isolated:
      // true, maxRounds: 4) its own fresh roundsUsed budget so it can't
      // eat the rest of the turn's shared round pool — and its own fresh
      // consecutiveRoundTimeouts counter (see dispatchDelegate), so the
      // escalation sequence below starts from 0 again even though it's
      // reusing the parent's already-ticking deadline. Confirmed here that
      // this does NOT also hand it a fresh wall-clock deadline: dispatched
      // early (round 1, cheap), then a run of hang rounds *inside* the
      // delegate's own isolated runLoop exhausts the shared 15-minute
      // budget — its wrap-up call still fires for the *time* reason, not
      // the round-count one (never reaching its own maxRounds:4 on its own
      // terms — hangRoundAdvancesToDeadline() below needs more than 4
      // attempts), proving it saw the real (inherited, already
      // mostly-spent) deadline rather than a fresh one starting from its
      // own dispatch.
      const advances = hangRoundAdvancesToDeadline()
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        {
          toolCalls: [{ id: 'call_delegate', name: 'delegate_to_email', input: { task: 'email someone' } }],
          stopReason: 'tool_use'
        },
        ...advances.map(() => ({ hang: true }) as const),
        // The delegate's own (nested, tagged) wrap-up call.
        { text: 'Partial draft before time ran out.', stopReason: 'end_turn' as const },
        // The top-level's own wrap-up, once the delegate's result comes back.
        { text: 'Reporting back what the Email specialist managed.', stopReason: 'end_turn' as const }
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
        { planningEnabled: false }
      )

      const resultPromise = collect(orchestrator, [
        { role: 'user', content: [{ type: 'text', text: 'email someone about this' }] }
      ])
      for (const advance of advances) {
        await vi.advanceTimersByTimeAsync(advance)
      }
      const events = await resultPromise
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      // 1 (delegate dispatch) + N (hung, inside the delegate) + 1 (the
      // delegate's own wrap-up) + 1 (top-level's own wrap-up) — never the
      // delegate's own fresh 4-round budget playing out in full, which
      // would mean more requests than this.
      expect(provider.requests).toHaveLength(advances.length + 3)
      const nestedWrapUpRequest = provider.requests[advances.length + 1]
      expect(nestedWrapUpRequest.system).toMatch(/taking too long/i)
      expect(nestedWrapUpRequest.system).not.toMatch(/used all \d+ rounds/i)
      expect(streamEvents).toContainEqual({
        type: 'text_delta',
        text: 'Reporting back what the Email specialist managed.'
      })
    }, 20000)
  })

  describe('tool execution timeout (a stuck tool.execute() with no timeout of its own, found live)', () => {
    // Mirrors orchestrator.ts's own private TOOL_EXECUTE_TIMEOUT_MS.
    const TOOL_EXECUTE_TIMEOUT_MS = 5 * 60 * 1000

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    function buildRegistryWithHangingTool(): ToolRegistry {
      const registry = buildRegistry()
      registry.register({
        name: 'hang_tool',
        description: "A tool whose execute() never resolves, for testing dispatchTool's own timeout.",
        inputSchema: { type: 'object', properties: {} },
        mutates: true,
        execute: () => new Promise<string>(() => {})
      })
      return registry
    }

    it('a tool call that never resolves is abandoned after TOOL_EXECUTE_TIMEOUT_MS instead of hanging the whole turn forever', async () => {
      // Found live: office_create_document, given malformed model input
      // (GPT-OSS sent a `{ text: string }` object where the schema calls
      // for a plain string), crashed inside its own synchronous JS — but
      // only surfaced that after the turn had already sat stuck for the
      // better part of an hour with the confirmation already approved and
      // zero pending network activity. `dispatchTool`'s `await
      // tool.execute(...)` had no timeout of its own (unlike
      // provider.stream, which got one in the round-timeout fix above), so
      // nothing could ever move the turn past it, and Stop had nothing
      // wired up to cancel it either.
      const registry = buildRegistryWithHangingTool()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'call_hang', name: 'hang_tool', input: {} }], stopReason: 'tool_use' },
        { text: 'Recovered after the stuck tool call.', stopReason: 'end_turn' }
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
        { planningEnabled: false }
      )

      const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      await vi.advanceTimersByTimeAsync(TOOL_EXECUTE_TIMEOUT_MS + 1000)
      const events = await resultPromise
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      const toolResult = streamEvents.find((e) => e.type === 'tool_result')
      expect(toolResult).toBeDefined()
      expect((toolResult as { isError: boolean }).isError).toBe(true)
      expect((toolResult as { content: string }).content).toMatch(/did not finish within 5 minute/i)
      // The turn didn't just die with the stuck tool call — it's treated as
      // one failed tool result and the loop moves on to a real next round.
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Recovered after the stuck tool call.' })
      expect(streamEvents).toContainEqual({ type: 'message_stop', stopReason: 'end_turn' })
    })

    it('a genuine user Stop during a stuck tool call is not made to wait out the full timeout', async () => {
      // If the abort signal weren't wired into the tool-execution wait too,
      // this would only resolve after advancing fake time by the full
      // TOOL_EXECUTE_TIMEOUT_MS (or hang forever under real timers).
      // Resolving here, with zero fake time advanced, proves the abort
      // short-circuits the wait immediately — the same guarantee Stop
      // already had for a stuck provider round.
      const registry = buildRegistryWithHangingTool()
      const agents = createAgents(registry)
      const controller = new AbortController()
      const provider = new MockProvider([
        { toolCalls: [{ id: 'call_hang', name: 'hang_tool', input: {} }], stopReason: 'tool_use' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        controller.signal,
        { planningEnabled: false }
      )

      const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      controller.abort()
      const events = await resultPromise
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents.some((e) => e.type === 'message_stop')).toBe(true)
    })

    it('a cancellable tool actually receives an abort signal on Stop, and its wait ends immediately (TASKS.md #93)', async () => {
      // Before #93, `tool.execute` had no way to know the turn was stopped —
      // the orchestrator's own *wait* was bounded, but the tool itself never
      // learned to stop. This asserts the signal passed to a real,
      // opted-in-cancellable tool actually reflects the abort, not just that
      // dispatchTool's promise resolves.
      // mutates: false deliberately — a mutating tool would also race the
      // confirmation dialog against the same abort signal (confirmOrAbort),
      // which could resolve as a denial before execute() is ever called at
      // all. Keeping this read-only isolates exactly what #93 changed:
      // executeWithTimeout's own signal propagation into tool.execute.
      let receivedSignal: AbortSignal | undefined
      const registry = buildRegistry()
      registry.register({
        name: 'cancellable_hang_tool',
        description: 'A cancellable tool whose execute() never resolves on its own, only reacts to the signal.',
        inputSchema: { type: 'object', properties: {} },
        mutates: false,
        cancellable: true,
        execute: (_input, _ctx, signal) =>
          new Promise<string>((_resolve, reject) => {
            receivedSignal = signal
            signal?.addEventListener('abort', () => reject(new Error('cancelled')))
          })
      })
      const agents = createAgents(registry)
      const controller = new AbortController()
      const provider = new MockProvider([
        { toolCalls: [{ id: 'call_hang', name: 'cancellable_hang_tool', input: {} }], stopReason: 'tool_use' }
      ])
      const orchestrator = new Orchestrator(
        provider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        ctx,
        controller.signal,
        { planningEnabled: false }
      )

      const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      // Flush pending microtasks (resolveMaxOutputTokens, the round's
      // provider.stream, dispatchTool) until the tool's own execute() has
      // actually started and captured its signal — aborting immediately,
      // with no flush at all, would race ahead of the turn even reaching
      // the tool call.
      for (let i = 0; i < 50 && !receivedSignal; i++) await Promise.resolve()
      expect(receivedSignal).toBeDefined()
      controller.abort()
      const events = await resultPromise
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(receivedSignal?.aborted).toBe(true)
      expect(streamEvents.some((e) => e.type === 'message_stop')).toBe(true)
    })

    it('a non-cancellable tool that times out says the operation may still be running, not that it was stopped', async () => {
      const registry = buildRegistryWithHangingTool() // hang_tool has no `cancellable` flag
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'call_hang', name: 'hang_tool', input: {} }], stopReason: 'tool_use' },
        { text: 'done', stopReason: 'end_turn' }
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
        { planningEnabled: false }
      )

      const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      await vi.advanceTimersByTimeAsync(TOOL_EXECUTE_TIMEOUT_MS + 1000)
      const events = await resultPromise
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      const toolResult = streamEvents.find((e) => e.type === 'tool_result') as { content: string } | undefined
      expect(toolResult?.content).toMatch(/may still be running in the background/i)
    })
  })

  describe('mid-turn context re-fit against the window, not just once before the turn (TASKS.md #98)', () => {
    it('collapses an old, large, read-only tool result to fit the budget, but never a mutating one, even though each is a single call (so capRepeatedToolResults/collapseDuplicateToolResults would not touch either)', async () => {
      // 'mock-model' matches no known prefix, so both its context window
      // (8192, model-metadata.ts's DEFAULT_CONTEXT_WINDOW) and output
      // ceiling (4096, DEFAULT_MAX_OUTPUT_TOKENS) are the generic fallbacks —
      // deliberately chosen because MIN_MAX_OUTPUT_TOKENS also happens to be
      // 4096, which pins state.maxOutputTokens at exactly 4096 regardless of
      // tokensUsed below, keeping the rest of the math predictable:
      // roughBudget = floor(8192*0.7) - 4096 = 1638; with tokensUsed=1000,
      // the real (mocked) overhead/actual calls both return 1000, giving a
      // real budget of 1638-1000=638 tokens (~1914 rough chars) once the
      // real check fires — well under either 3000-char tool result's own
      // rough estimate (~1000 tokens), so the real check *does* fire and
      // *does* find itself over budget.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const bigReadOnlyContent = 'X'.repeat(3000)
      const bigMutatingContent = 'Y'.repeat(3000)
      const priorConversation: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'earlier request' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'old_read', name: 'read_file', input: { path: 'a.txt' } },
            { type: 'tool_use', id: 'old_write', name: 'write_file', input: { path: 'b.txt', content: 'x' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'old_read', content: bigReadOnlyContent, isError: false },
            { type: 'tool_result', toolUseId: 'old_write', content: bigMutatingContent, isError: false }
          ]
        },
        { role: 'assistant', content: [{ type: 'text', text: 'done with that earlier request' }] },
        { role: 'user', content: [{ type: 'text', text: 'new question' }] }
      ]
      const provider = new MockProvider([{ text: 'ok', stopReason: 'end_turn' }], { tokensUsed: 1000 })
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

      await collect(orchestrator, priorConversation)

      const sentMessages = provider.requests[0].messages
      const findResult = (toolUseId: string): string | undefined => {
        for (const m of sentMessages) {
          for (const b of m.content) {
            if (b.type === 'tool_result' && b.toolUseId === toolUseId) return b.content
          }
        }
        return undefined
      }
      expect(findResult('old_read')).toMatch(/omitted to fit this round/i)
      expect(findResult('old_write')).toBe(bigMutatingContent)
    })

    it('does nothing to an ordinary small conversation — the cheap local estimate alone is enough to skip the real check', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([{ text: 'ok', stopReason: 'end_turn' }])
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

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

      // The real countTokens call inside resolveMaxOutputTokens (used) and
      // its overhead probe still happen (2 calls) — refitConversationToBudget
      // itself must add zero more for a conversation this small.
      expect(provider.countTokensCalls).toHaveLength(2)
    })
  })

  describe('capping repeated same-tool results within a single turn (context-bloat fix)', () => {
    it('collapses all but the most recent 3 results for a repeatedly-called read-only tool in what is sent to the provider', async () => {
      // Reported directly: a real complex request made 9 separate
      // web_search calls in one turn, most of them refinements that hadn't
      // found what was needed yet — every one of those stayed fully
      // expanded in every later round's request, since nothing trims
      // *within* a turn (prepareConversation only runs once, before the
      // turn starts). Scripts 5 read_file calls (read_file is registered
      // as mutates:false, same as web_search) to the same effect, cheaper
      // to set up than a real web_search mock.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      for (let i = 1; i <= 5; i++) {
        await writeFileTool.execute({ path: `file${i}.txt`, content: `content-${i}` }, ctx)
      }

      const turns: ScriptedTurn[] = [
        ...Array.from({ length: 5 }, (_, i) => ({
          toolCalls: [{ id: `call${i + 1}`, name: 'read_file', input: { path: `file${i + 1}.txt` } }],
          stopReason: 'tool_use' as const
        })),
        { text: 'Done.', stopReason: 'end_turn' }
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
        signal,
        { planningEnabled: false }
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'read all 5 files' }] }])

      // The final round's request reflects every earlier round's accumulated
      // conversation — the real regression surface (a request growing
      // unboundedly across rounds within one turn).
      const finalRequest = provider.requests[provider.requests.length - 1]
      const toolResultContents = finalRequest.messages
        .flatMap((m) => m.content)
        .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.content)

      expect(toolResultContents).toHaveLength(5)
      // Oldest 2 (5 calls - MAX_KEPT_RESULTS_PER_TOOL of 3) collapsed to the marker.
      expect(toolResultContents[0]).toMatch(/omitted to save context/)
      expect(toolResultContents[1]).toMatch(/omitted to save context/)
      // Most recent 3 stay real, untouched content.
      expect(toolResultContents[2]).toBe('content-3')
      expect(toolResultContents[3]).toBe('content-4')
      expect(toolResultContents[4]).toBe('content-5')

      // Never affects what's actually persisted/shown — the live
      // tool_result stream events (what the UI/DB actually get, and what
      // register.ts persists to SQLite) carry the real, full content
      // regardless of what capRepeatedToolResults sent to the provider.
      const liveToolResults = events
        .filter((e) => e.kind === 'stream' && e.event.type === 'tool_result')
        .map((e) => (e.kind === 'stream' && e.event.type === 'tool_result' ? e.event.content : ''))
      expect(liveToolResults).toEqual(['content-1', 'content-2', 'content-3', 'content-4', 'content-5'])
    })

    it('never collapses a mutating tool\'s result, even called repeatedly', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)

      const turns: ScriptedTurn[] = [
        ...Array.from({ length: 5 }, (_, i) => ({
          toolCalls: [{ id: `write${i + 1}`, name: 'write_file', input: { path: `f${i + 1}.txt`, content: `v${i + 1}` } }],
          stopReason: 'tool_use' as const
        })),
        { text: 'Done.', stopReason: 'end_turn' }
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
        signal,
        { planningEnabled: false }
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'write 5 files' }] }])

      const finalRequest = provider.requests[provider.requests.length - 1]
      const toolResultContents = finalRequest.messages
        .flatMap((m) => m.content)
        .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.content)

      expect(toolResultContents.every((c) => !c.includes('omitted to save context'))).toBe(true)
    })
  })

  describe('collapsing near-duplicate tool results by URL overlap (context-bloat fix)', () => {
    // Both scripts stay at 3 calls (== MAX_KEPT_RESULTS_PER_TOOL), so the
    // separate pure-recency cap (capRepeatedToolResults, tested above) never
    // fires — isolates this detector's own overlap-based behavior.
    it('collapses a result whose URLs substantially overlap an earlier same-tool result, but leaves a genuinely different one untouched', async () => {
      // Mirrors a real session: several reworded web_search-style queries in
      // one turn, most surfacing the same handful of sources. read_file
      // stands in for web_search (also mutates: false) — cheaper to script,
      // and the detector is generic (keys off literal URLs in the content,
      // not the tool).
      const registry = buildRegistry()
      const agents = createAgents(registry)
      await writeFileTool.execute(
        { path: 'r1.txt', content: 'https://a.com https://b.com https://c.com' },
        ctx
      )
      // Exact same 3 sources as r1 — should collapse.
      await writeFileTool.execute(
        { path: 'r2.txt', content: 'https://a.com https://b.com https://c.com' },
        ctx
      )
      // Completely different sources — should NOT collapse.
      await writeFileTool.execute({ path: 'r3.txt', content: 'https://x.com https://y.com' }, ctx)

      const turns: ScriptedTurn[] = [
        ...['r1.txt', 'r2.txt', 'r3.txt'].map((path, i) => ({
          toolCalls: [{ id: `call${i + 1}`, name: 'read_file', input: { path } }],
          stopReason: 'tool_use' as const
        })),
        { text: 'Done.', stopReason: 'end_turn' }
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
        signal,
        { planningEnabled: false }
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'search around' }] }])

      const finalRequest = provider.requests[provider.requests.length - 1]
      const toolResultContents = finalRequest.messages
        .flatMap((m) => m.content)
        .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.content)

      expect(toolResultContents).toHaveLength(3)
      expect(toolResultContents[0]).toBe('https://a.com https://b.com https://c.com') // r1: first appearance, kept
      expect(toolResultContents[1]).toMatch(/substantially overlap/) // r2: exact duplicate of r1, collapsed
      expect(toolResultContents[2]).toBe('https://x.com https://y.com') // r3: genuinely new, kept
    })

    it('leaves a result untouched when its URL overlap with earlier results is below the threshold', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      await writeFileTool.execute(
        { path: 'r1.txt', content: 'https://a.com https://b.com https://c.com' },
        ctx
      )
      // Only 1 of 3 URLs (a) already seen — 33% overlap, well below the 70%
      // threshold — a genuinely different result, not a reworded retry.
      await writeFileTool.execute(
        { path: 'r2.txt', content: 'https://a.com https://x.com https://z.com' },
        ctx
      )

      const turns: ScriptedTurn[] = [
        ...['r1.txt', 'r2.txt'].map((path, i) => ({
          toolCalls: [{ id: `call${i + 1}`, name: 'read_file', input: { path } }],
          stopReason: 'tool_use' as const
        })),
        { text: 'Done.', stopReason: 'end_turn' }
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
        signal,
        { planningEnabled: false }
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'search around' }] }])

      const finalRequest = provider.requests[provider.requests.length - 1]
      const toolResultContents = finalRequest.messages
        .flatMap((m) => m.content)
        .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.content)

      expect(toolResultContents).toEqual([
        'https://a.com https://b.com https://c.com',
        'https://a.com https://x.com https://z.com'
      ])
    })

    it('never collapses a mutating tool\'s result even when its URLs repeat', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)

      const turns: ScriptedTurn[] = [
        ...Array.from({ length: 3 }, (_, i) => ({
          toolCalls: [
            {
              id: `write${i + 1}`,
              name: 'write_file',
              input: { path: `w${i + 1}.txt`, content: 'https://a.com https://b.com' }
            }
          ],
          stopReason: 'tool_use' as const
        })),
        { text: 'Done.', stopReason: 'end_turn' }
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
        signal,
        { planningEnabled: false }
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'write 3 files' }] }])

      const finalRequest = provider.requests[provider.requests.length - 1]
      const toolResultContents = finalRequest.messages
        .flatMap((m) => m.content)
        .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.content)

      expect(toolResultContents.every((c) => !c.includes('substantially overlap'))).toBe(true)
    })
  })

  describe('isolated delegation (#77)', () => {
    function isolate(agents: Map<AgentRole, Agent>, role: AgentRole, maxRounds?: number): Map<AgentRole, Agent> {
      const isolated = new Map(agents)
      isolated.set(role, { ...agents.get(role)!, isolated: true, maxRounds })
      return isolated
    }

    it('gets only its own task, not the full parent conversation', async () => {
      const registry = buildRegistry()
      const agents = isolate(createAgents(registry), 'coding')

      const turns: ScriptedTurn[] = [
        { toolCalls: [{ id: 'call_delegate', name: 'delegate_to_coding', input: { task: 'write hello.txt' } }] },
        { text: 'Done.', stopReason: 'end_turn' }, // nested isolated round
        { text: 'The Coding specialist wrote the file.', stopReason: 'end_turn' } // outer final
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
        { role: 'user', content: [{ type: 'text', text: 'EARLIER-CONTEXT-MARKER: my favorite color is blue' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Noted!' }] },
        { role: 'user', content: [{ type: 'text', text: 'Please write hello.txt for me.' }] }
      ]
      await collect(orchestrator, conversation)

      // provider.requests[0] is the outer round; [1] is the isolated delegate's own round.
      const nestedRequestText = JSON.stringify(provider.requests[1].messages)
      expect(nestedRequestText).not.toContain('EARLIER-CONTEXT-MARKER')
      expect(nestedRequestText).toContain('write hello.txt')
    })

    it('gets its own fresh, independently-capped round budget — not the shared MAX_TOTAL_ROUNDS pool', async () => {
      const registry = buildRegistry()
      const agents = isolate(createAgents(registry), 'coding', 5)
      await writeFile(join(root, 'note.txt'), 'hi', 'utf-8')

      const turns: ScriptedTurn[] = [
        // 3 outer rounds first, so the shared state.roundsUsed is already
        // well past 0 by the time delegation happens.
        { toolCalls: [{ id: 'r1', name: 'read_file', input: { path: 'note.txt' } }] },
        { toolCalls: [{ id: 'r2', name: 'read_file', input: { path: 'note.txt' } }] },
        { toolCalls: [{ id: 'r3', name: 'read_file', input: { path: 'note.txt' } }] },
        // Outer round 4: delegate.
        { toolCalls: [{ id: 'call_delegate', name: 'delegate_to_coding', input: { task: 'read note.txt twice' } }] },
        // Isolated delegate's own round 1 and 2.
        { toolCalls: [{ id: 'r4', name: 'read_file', input: { path: 'note.txt' } }] },
        { text: 'Read it twice.', stopReason: 'end_turn' },
        // Outer final.
        { text: 'Done.', stopReason: 'end_turn' }
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

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'go' }] }])
      const statusMessages = events
        .filter((e) => e.kind === 'stream' && e.event.type === 'status')
        .map((e) => (e as { event: { message: string; agentRole?: string } }).event)

      const codingStatuses = statusMessages.filter((s) => s.agentRole === 'coding').map((s) => s.message)
      // Its own counter starts at 1 and is capped at its own maxRounds (5),
      // never at the shared pool's 12 — even though the outer loop had
      // already used 4 of the 12 shared rounds by the time it delegated.
      expect(codingStatuses[0]).toContain('(round 1/5)')
      expect(codingStatuses[1]).toContain('(round 2/5)')
      expect(codingStatuses.every((m) => !m.includes('/12'))).toBe(true)
    })
  })

  describe('deck creation (#78)', () => {
    it('a real deck: start, add slide, delegate to the isolated page-creator, compose, save — a real .pptx lands on disk', async () => {
      const registry = buildRegistry()
      registry.register(pptxStartDeckTool)
      registry.register(pptxAddSlideTool)
      registry.register(pptxComposeSlideTool)
      registry.register(pptxSaveDeckTool)
      const agents = createAgents(registry)
      const deckCtx: ToolContext = { ...ctx, activeDecks: new Map() }

      // The mock provider returns scripted inputs verbatim, so a real
      // deckId (generated at runtime by pptx_start_deck) has to be
      // discovered first: run just that one call, read the real id back
      // out of its tool_result, then drive the rest of the pipeline
      // against it in a second run reusing the same live deckCtx.
      const startProvider = new MockProvider([
        { toolCalls: [{ id: 'start', name: 'pptx_start_deck', input: {} }] },
        { text: 'Started.', stopReason: 'end_turn' }
      ])
      const startOrchestrator = new Orchestrator(
        startProvider,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        deckCtx,
        signal
      )
      const startEvents = await collect(startOrchestrator, [{ role: 'user', content: [{ type: 'text', text: 'go' }] }])
      const startResultText = startEvents
        .filter((e) => e.kind === 'stream' && e.event.type === 'tool_result')
        .map((e) => (e as { event: { content: string } }).event.content)[0]
      const deckId = /"([^"]+)"/.exec(startResultText ?? '')?.[1] ?? ''
      expect(deckId).toBeTruthy()

      const turns2: ScriptedTurn[] = [
        { toolCalls: [{ id: 'add', name: 'pptx_add_slide', input: { deckId } }] },
        {
          toolCalls: [
            { id: 'delegate', name: 'delegate_to_page-creator', input: { task: `Compose slide 0 of deck ${deckId}: title "Hello"` } }
          ]
        },
        {
          toolCalls: [
            {
              id: 'compose',
              name: 'pptx_compose_slide',
              input: { deckId, slideIndex: 0, elements: [{ type: 'text', text: 'Hello', x: 0.5, y: 0.5, w: 5, h: 1 }] }
            }
          ]
        },
        { text: 'Composed.', stopReason: 'end_turn' },
        { toolCalls: [{ id: 'save', name: 'pptx_save_deck', input: { deckId, path: 'deck.pptx' } }] },
        { text: 'Deck saved.', stopReason: 'end_turn' }
      ]
      const provider2 = new MockProvider(turns2)
      const orchestrator2 = new Orchestrator(
        provider2,
        'mock-model',
        agents,
        'You are Sachivji.',
        registry.list(),
        autoApprove(),
        deckCtx,
        signal
      )
      const events = await collect(orchestrator2, [{ role: 'user', content: [{ type: 'text', text: 'make a 1-slide deck' }] }])

      // The isolated delegate's own request must carry only its task, not
      // the deck-planning conversation — same #77 property, first real
      // consumer. requests[0]/[1] are the outer round's own two calls
      // (add_slide, then deciding to delegate); [2] is page-creator's own
      // first round.
      const delegateRequest = provider2.requests[2]
      expect(JSON.stringify(delegateRequest.messages)).not.toContain('make a 1-slide deck')
      expect(JSON.stringify(delegateRequest.messages)).toContain('Hello')

      const toolResults = events
        .filter((e) => e.kind === 'stream' && e.event.type === 'tool_result')
        .map((e) => (e as { event: { content: string } }).event.content)
      expect(toolResults.some((c) => c.includes('Saved documents/deck.pptx'))).toBe(true)

      const text = await officeReadDocumentTool.execute({ path: 'documents/deck.pptx' }, deckCtx)
      expect(text).toContain('Hello')
    })
  })
})
