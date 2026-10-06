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
import { downloadImageTool } from '../tools/download-image'
import { showMediaTool } from '../tools/show-media'
import type { Tool, ToolContext } from '../tools/types'
import { createAgents } from './roles'
import { Orchestrator, detectsSourceRestriction, parseJsonObjectLoosely, type Agent, type ConfirmDecision, type OrchestratorEvent, type ToolConfirmRequest } from './orchestrator'

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

  it('forwards options.temperature to every provider.stream() call this turn makes; omits it when unset (2026-10-01)', async () => {
    // Found live: the classify step, at a provider's own default temperature, occasionally misrouted
    // an otherwise-correctly-worded request on a local model — Settings > Model behavior's whole point
    // is that this is reachable and actually takes effect, not just plumbed through and silently dropped.
    const registry = buildRegistry()
    const agents = createAgents(registry)

    const withTemp = new MockProvider([{ text: 'Hello!', stopReason: 'end_turn' }])
    const orchestratorWithTemp = new Orchestrator(
      withTemp, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, { planningEnabled: false, temperature: 0.2 }
    )
    await collect(orchestratorWithTemp, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    expect(withTemp.requests[0].temperature).toBe(0.2)

    const withoutTemp = new MockProvider([{ text: 'Hello!', stopReason: 'end_turn' }])
    const orchestratorWithoutTemp = new Orchestrator(
      withoutTemp, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, { planningEnabled: false }
    )
    await collect(orchestratorWithoutTemp, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    expect(withoutTemp.requests[0].temperature).toBeUndefined()
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

    expect(result).toMatchObject({ type: 'tool_result', isError: true, content: '[Rejected by user] The user denied this tool call.' })
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
    expect(writeResult).toMatchObject({ isError: true, content: '[Rejected by user] The user denied this tool call.' })

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

  it('an unknown pinned role falls back to Auto with a visible, persisted notice — it no longer fails the turn (design 11.4)', async () => {
    const registry = buildRegistry()
    const agents = createAgents(registry)
    const provider = new MockProvider([{ text: 'Hello from Auto.', stopReason: 'end_turn' }])
    const orchestrator = new Orchestrator(provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal)

    const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'sql-reporter')

    const warning = events.find((e) => e.kind === 'stream' && e.event.type === 'warning')
    expect(warning && warning.kind === 'stream' && warning.event.type === 'warning' ? warning.event.message : '').toMatch(/pinned "Sql Reporter" agent is not available.*using Auto instead/)
    expect(events.some((e) => e.kind === 'message' && e.role === 'assistant' && e.content.some((c) => c.type === 'warning'))).toBe(true)
    // ...and the turn ran normally as Auto: the router's own prompt and delegate tools, and an ordinary reply.
    expect(provider.requests[0].tools?.some((t) => t.name === 'delegate_to_coding')).toBe(true)
    expect(events.flatMap((e) => (e.kind === 'stream' && e.event.type === 'text_delta' ? [e.event.text] : [])).join('')).toBe('Hello from Auto.')
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
    // short-circuited by the already-aborted signal. The warning is TASKS.md
    // #102: a top-level turn stopped with literally nothing produced gets an
    // explicit "stopped, no answer" note, so this doesn't get silently
    // resent as unanswered "real" context on the next send.
    expect(streamEvents).toEqual([
      { type: 'status', message: 'Model (mock-model) is thinking… (round 1/20)' },
      { type: 'warning', message: 'This request was stopped before producing a response. No answer was given.', failureCategory: 'stopped_by_user' },
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

  describe('prompt-cache stability (design step 7)', () => {
    // Prefix caching (Anthropic cache_control; automatic on OpenAI-compatible providers) only pays if the system prompt and the tool list
    // are BYTE-identical from one round to the next. Anything that varied per round — a timestamp, a counter, an unordered Map — would
    // silently turn every request into a cache miss.
    const prefixOf = (req: { system?: string; tools?: unknown }): string => JSON.stringify({ system: req.system, tools: req.tools })

    it('the router\'s system prompt and tool list are byte-identical on every round of a multi-round turn', async () => {
      const registry = buildRegistry()
      await writeFile(join(root, 'a.txt'), 'hello')
      const provider = new MockProvider([
        { toolCalls: [{ id: '1', name: 'read_file', input: { path: 'a.txt' } }] },
        { toolCalls: [{ id: '2', name: 'list_directory', input: { path: '.' } }] },
        { text: 'done', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal)
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'look around' }] }])
      expect(provider.requests).toHaveLength(3)
      expect(new Set(provider.requests.map(prefixOf)).size).toBe(1)
    })

    it('a specialist\'s prefix is byte-identical across its own rounds', async () => {
      const registry = buildRegistry()
      await writeFile(join(root, 'a.txt'), 'hello')
      const provider = new MockProvider([
        { toolCalls: [{ id: 'd', name: 'delegate_to_coding', input: { task: 'read it twice' } }] },
        { toolCalls: [{ id: '1', name: 'read_file', input: { path: 'a.txt' } }] }, // specialist round 1
        { toolCalls: [{ id: '2', name: 'read_file', input: { path: 'a.txt' } }] }, // specialist round 2
        { text: 'read it', stopReason: 'end_turn' }, // specialist round 3
        { text: 'done', stopReason: 'end_turn' } // router final
      ])
      const orchestrator = new Orchestrator(provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal)
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'go' }] }])
      const nested = provider.requests.slice(1, 4)
      expect(new Set(nested.map(prefixOf)).size).toBe(1)
      // ...and it differs from the router's (different role, different tools), so the two are cached independently.
      expect(prefixOf(nested[0])).not.toBe(prefixOf(provider.requests[0]))
    })

    it('two separately-built orchestrators over the same registry produce the same prefix (nothing depends on construction order or time)', async () => {
      const build = async (): Promise<string> => {
        const registry = buildRegistry()
        const provider = new MockProvider([{ text: 'hi', stopReason: 'end_turn' }])
        const orchestrator = new Orchestrator(provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal)
        await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
        return prefixOf(provider.requests[0])
      }
      const first = await build()
      await new Promise((r) => setTimeout(r, 15)) // a wall-clock-dependent prompt would differ now
      expect(await build()).toBe(first)
    })
  })

  describe('router prompt (step 2)', () => {
    it('carries each specialist summary once — in its delegate tool description — not again as a roster in the system prompt', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([{ text: 'hello', stopReason: 'end_turn' }])
      const orchestrator = new Orchestrator(provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal)
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

      const req = provider.requests[0]
      const summary = agents.get('coding')!.summary
      expect(req.system).not.toContain(summary)
      expect(req.system).not.toMatch(/delegate_to_coding\)/)
      const delegate = req.tools?.find((t) => t.name === 'delegate_to_coding')
      expect(delegate?.description).toContain(summary)
      expect(delegate?.description).toContain('Developer')
      // The trailer still tells the model when to delegate, and points code work at the Developer.
      expect(req.system).toMatch(/Developer/)
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

      // TASKS.md #102: nothing ran past the classify pre-pass, so a
      // "stopped, no answer" note is expected here too.
      expect(streamEvents).toEqual([
        { type: 'warning', message: 'This request was stopped before producing a response. No answer was given.', failureCategory: 'stopped_by_user' },
        { type: 'message_stop', stopReason: 'aborted' }
      ])
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
      expect(classifySystem).toMatch(/slide deck\/presentation is never a plan step for any role/i)
      expect(classifySystem).toContain('- research:')
      expect(classifySystem).toContain('- coding:')
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
      // The role facts are GENERATED from each role's own summary (no hand-written per-role prose):
      // Research's line says it does not write files, and the rule tells the classifier to honour that.
      expect(classifySystem).toMatch(/- research: .*Does not .*write files/i)
      expect(classifySystem).toMatch(/never route a step to a role its summary excludes/i)
      expect(classifySystem).toMatch(/saved file\/document\/spreadsheet is its own step/i)
    })

    it('tells the classifier that writing code and running it are ONE step for the Developer (Appendix D: no plan with a write step and no run step)', async () => {
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
      // Step 2 reversed the old rule: Developer writes AND runs, so splitting write-from-run is what's forbidden now.
      expect(classifySystem).toMatch(/- coding: Writes AND runs code/)
      expect(classifySystem).toMatch(/writes AND runs code handles both in ONE step/i)
      expect(classifySystem).not.toMatch(/terminal-devops/)
      expect(classifySystem).not.toMatch(/no shell access/i)
    })

    it('names domain knowledge + data as its own compound pattern, always two steps even in one sentence (design-discussion.md §13.2(a), TASKS #142)', async () => {
      // The #139 probe found the PLF question ("...you may use the information from wiki and database")
      // planned inconsistently — sometimes `simple`, and the first step split between data/research —
      // because "two independent sources" was the only guidance, never named as a recognizable shape.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { text: '{"complexity": "simple", "steps": []}', stopReason: 'end_turn' },
        { text: 'Sure, here you go.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, { planningEnabled: true }
      )
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
      const classifySystem = provider.requests[0].system ?? ''
      expect(classifySystem).toMatch(/domain knowledge.*together with the data those rules apply to.*is always compound/is)
      expect(classifySystem).toMatch(/one step per source, even in a single sentence/i)
    })

    it('names chart/image generation + embedding into a document as ONE Developer step, never split and never routed to Document Creator (2026-10-01, manual_testing.md section 4)', async () => {
      // Found live: the blanket "a file/document is its own step" rule, applied literally, split chart
      // generation (Developer) from "put it in a Word file" (Document Creator) across two steps — but
      // Document Creator cannot embed an image at all and only ever bounces that step back. Worse, with
      // the document part framed as someone else's job, the chart step's own wording never even asked
      // Developer to save the document, so Developer quietly over-delivered it anyway, unasked, on a
      // worse, redundant second pass.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { text: '{"complexity": "simple", "steps": []}', stopReason: 'end_turn' },
        { text: 'Sure, here you go.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, { planningEnabled: true }
      )
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
      const classifySystem = provider.requests[0].system ?? ''
      expect(classifySystem).toMatch(/chart or image generated from data AND embedded into it/i)
      expect(classifySystem).toMatch(/never split the chart generation from the document creation/i)
      expect(classifySystem).toMatch(/never route the document part to Document Creator/i)
    })

    it('the planning call asks the provider for structured output limited to the plannable roles; ordinary rounds never do', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { text: '{"complexity": "simple", "steps": []}', stopReason: 'end_turn' },
        { text: 'Done.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, {
        planningEnabled: true
      })
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'find X and Y' }] }])
      const so = provider.requests[0].structuredOutput as { name: string; schema: { properties: { steps: { items: { properties: { role: { enum: string[] } } } } } } }
      expect(so.name).toBe('classify_and_plan')
      expect(so.schema.properties.steps.items.properties.role.enum).toContain('data')
      expect(so.schema.properties.steps.items.properties.role.enum).not.toContain('page-creator')
      expect(provider.requests[1].structuredOutput).toBeUndefined()
    })

    it('a provider that rejects structured output (HTTP 400) gets the same call as a plain prompt, remembered for the next turn', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const make = (turns: ScriptedTurn[]) => {
        const provider = new MockProvider(turns)
        // A model name no other test uses: the "rejected" memo is per provider:model for the whole app session.
        const o = new Orchestrator(provider, 'mock-model-no-schema', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, {
          planningEnabled: true
        })
        return { provider, o }
      }
      const first = make([
        { throwError: 'response_format is not supported by this model', throwStatus: 400 },
        { text: '{"complexity": "simple", "steps": []}', stopReason: 'end_turn' },
        { text: 'Done.', stopReason: 'end_turn' }
      ])
      const events = await collect(first.o, [{ role: 'user', content: [{ type: 'text', text: 'find X and Y' }] }])
      expect(first.provider.requests.map((r) => Boolean(r.structuredOutput))).toEqual([true, false, false])
      expect(events.filter((e) => e.kind === 'stream').some((e) => e.event.type === 'error')).toBe(false)

      const second = make([
        { text: '{"complexity": "simple", "steps": []}', stopReason: 'end_turn' },
        { text: 'Done.', stopReason: 'end_turn' }
      ])
      await collect(second.o, [{ role: 'user', content: [{ type: 'text', text: 'find X and Y' }] }])
      expect(second.provider.requests.map((r) => Boolean(r.structuredOutput))).toEqual([false, false])
    })

    it('a non-client error on the planning call (no 4xx status) is not blamed on the schema and still surfaces', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([{ throwError: 'socket hang up' }])
      const orchestrator = new Orchestrator(provider, 'mock-model-net', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, {
        planningEnabled: true
      })
      await expect(collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'find X and Y' }] }])).rejects.toThrow('socket hang up')
      expect(provider.requests).toHaveLength(1)
    })

    it('a classifier reply with prose around the JSON (common with local reasoning models) still yields the plan', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        {
          text: 'Sure, here is the classification:\n```json\n{"complexity": "compound", "steps": [{"role": "research", "description": "find X"}, {"role": "data", "description": "find Y"}]}\n```\nLet me know if you need more.',
          stopReason: 'end_turn'
        },
        { text: 'X is 5.', stopReason: 'end_turn' },
        { text: 'Y is 10.', stopReason: 'end_turn' },
        { text: 'X is 5 and Y is 10.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, {
        planningEnabled: true
      })
      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'find X and Y' }] }])
      const plan = events.filter((e) => e.kind === 'stream').map((e) => e.event).find((e) => e.type === 'plan')
      expect(plan).toBeDefined()
      expect(provider.requests).toHaveLength(4)
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
            e.content.some((c) => c.type === 'text' && c.text.includes('[Plan step 1 — Researcher]') && c.text.includes('X is 5.'))
        )
      ).toBe(true)
      expect(
        userMessages.some(
          (e) =>
            e.kind === 'message' &&
            e.content.some((c) => c.type === 'text' && c.text.includes('[Plan step 2 — Data Access]') && c.text.includes('Y is 10.'))
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
        .find((c) => c.type === 'text' && c.text.includes('[Plan step 1 — Data Access]'))
      expect(step1Text && step1Text.type === 'text' ? step1Text.text : '').toMatch(
        /\[Plan step 1 — Data Access\] \(FAILED — no usable result\):/
      )
      expect(
        step1Text && step1Text.type === 'text' ? step1Text.text : ''
      ).toContain('Unknown data connection "sales_db".')

      // A step that actually succeeded must NOT get the FAILED marker.
      const step2Text = userMessages
        .flatMap((e) => (e.kind === 'message' ? e.content : []))
        .find((c) => c.type === 'text' && c.text.includes('[Plan step 2 — Developer]'))
      expect(step2Text && step2Text.type === 'text' ? step2Text.text : '').toMatch(/^\[Plan step 2 — Developer\]:/)
    })

    it('marks a role UNAVAILABLE in the classifier digest when nothing it needs is configured, and not when it is', async () => {
      // A plan must not route "email it to X" to a role with no account to send from, or "query the
      // database" to Data Access with no connection (design 3.6: the digest carries live state).
      const run = async (config: { databases: number; apis: number; email: number; mcp: number }): Promise<string> => {
        const registry = buildRegistry()
        const provider = new MockProvider([
          { text: '{"complexity": "simple", "steps": []}', stopReason: 'end_turn' },
          { text: 'ok', stopReason: 'end_turn' }
        ])
        const orchestrator = new Orchestrator(
          provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal,
          { planningEnabled: true, getConfiguration: () => config }
        )
        await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
        return provider.requests[0].system ?? ''
      }

      const none = await run({ databases: 0, apis: 0, email: 0, mcp: 0 })
      expect(none).toMatch(/- data: .*UNAVAILABLE right now: no database or external API is configured/)
      expect(none).toMatch(/- email: .*UNAVAILABLE right now: no email account is configured/)
      expect(none).toMatch(/- mcp-operator: .*UNAVAILABLE right now: no MCP server is connected/)

      const apiOnly = await run({ databases: 0, apis: 1, email: 1, mcp: 1 })
      expect(apiOnly).not.toMatch(/- data: .*UNAVAILABLE/) // Data Access needs a database OR an API
      expect(apiOnly).not.toMatch(/- email: .*UNAVAILABLE/)
      expect(apiOnly).not.toMatch(/- mcp-operator: .*UNAVAILABLE/)
    })

    it('rewrites an mcp-operator plan step to research when no MCP server is connected (design-discussion.md §13.3, #145)', async () => {
      // No MCP server connected at all is a fact known before any model runs — the step must not be
      // dispatched to mcp-operator (it would just report "no connected server fits" and waste itself);
      // it should be transparently rewritten to research, with the substitution's reason and the
      // original task both visible, before the step is even shown in the live plan. Two steps, since
      // executePlan (where this fix lives) is only reached for a plan with more than one step —
      // a single-step plan runs through the ordinary top-level round instead (a separate, known gap).
      const registry = buildRegistry()
      const provider = new MockProvider([
        {
          text:
            '{"complexity": "compound", "steps": [' +
            '{"role": "mcp-operator", "description": "look up the maintenance policy for inverter faults"}, ' +
            '{"role": "research", "description": "check for any recent public advisories on the same fault"}]}',
          stopReason: 'end_turn'
        },
        { text: 'No wiki is connected, and the web has nothing specific either.', stopReason: 'end_turn' },
        { text: 'No recent public advisories found.', stopReason: 'end_turn' },
        { text: 'Here is what I found.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal,
        { planningEnabled: true, getConfiguration: () => ({ databases: 0, apis: 0, email: 0, mcp: 0 }) }
      )

      const events = await collect(orchestrator, [
        { role: 'user', content: [{ type: 'text', text: 'look up the maintenance policy for the inverter fault and check for public advisories' }] }
      ])

      const planEvent = events.find((e) => e.kind === 'stream' && e.event.type === 'plan')
      const planSteps = planEvent && planEvent.kind === 'stream' && planEvent.event.type === 'plan' ? planEvent.event.steps : undefined
      expect(planSteps?.[0].role).toBe('research') // rewritten from mcp-operator
      expect(planSteps?.[1].role).toBe('research') // untouched, was already research

      const stepText = events
        .filter((e) => e.kind === 'message' && e.role === 'user')
        .flatMap((e) => (e.kind === 'message' ? e.content : []))
        .find((c) => c.type === 'text' && c.text.includes('[Plan step 1 — Researcher]'))
      const text = stepText && stepText.type === 'text' ? stepText.text : ''
      expect(text).toMatch(/No MCP\/knowledge-base server is connected/)
      expect(text).toContain('Original task: look up the maintenance policy for inverter faults')

      // The rewritten step actually ran as research, not mcp-operator — confirmed via the delegate's own request.
      expect(provider.requests[1].system ?? '').toMatch(/Research specialist/)
    })

    it('leaves an mcp-operator plan step untouched when an MCP server is connected', async () => {
      const registry = buildRegistry()
      const provider = new MockProvider([
        {
          text:
            '{"complexity": "compound", "steps": [' +
            '{"role": "mcp-operator", "description": "look up the maintenance policy for inverter faults"}, ' +
            '{"role": "research", "description": "check for any recent public advisories on the same fault"}]}',
          stopReason: 'end_turn'
        },
        { text: 'No connected server fits the request.', stopReason: 'end_turn' },
        { text: 'No recent public advisories found.', stopReason: 'end_turn' },
        { text: 'Here is what I found.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal,
        { planningEnabled: true, getConfiguration: () => ({ databases: 0, apis: 0, email: 0, mcp: 1 }) }
      )

      const events = await collect(orchestrator, [
        { role: 'user', content: [{ type: 'text', text: 'look up the maintenance policy for the inverter fault and check for public advisories' }] }
      ])

      const planEvent = events.find((e) => e.kind === 'stream' && e.event.type === 'plan')
      const planSteps = planEvent && planEvent.kind === 'stream' && planEvent.event.type === 'plan' ? planEvent.event.steps : undefined
      expect(planSteps?.[0].role).toBe('mcp-operator')
      expect(provider.requests[1].system ?? '').toMatch(/MCP Operator specialist/)
    })

    it('inserts a domain-knowledge step when needsDomainKnowledge is true but the plan omitted one, and a server is connected (TASKS #173)', async () => {
      // Found live 2026-10-02: the planner's own step list omitted mcp-operator entirely for a question
      // needing domain interpretation (a connected wiki had directly relevant content for it), on two
      // different models, despite the planning prompt's prose rule saying this should always be compound.
      // Moving the judgment into a structured needsDomainKnowledge field and enforcing it here in code
      // closes the gap regardless of what a given model's own step list says.
      const registry = buildRegistry()
      const provider = new MockProvider([
        {
          text:
            '{"complexity": "compound", "needsDomainKnowledge": true, "needsUserData": true, "steps": [' +
            '{"role": "data", "description": "query the sensor readings"}]}',
          stopReason: 'end_turn'
        },
        { text: 'Rule: a deviation over 5% counts as an anomaly.', stopReason: 'end_turn' },
        { text: 'Readings deviate by 8%.', stopReason: 'end_turn' },
        { text: 'Yes, this is an anomaly by that rule.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal,
        { planningEnabled: true, getConfiguration: () => ({ databases: 1, apis: 0, email: 0, mcp: 1 }) }
      )

      const events = await collect(orchestrator, [
        { role: 'user', content: [{ type: 'text', text: 'analyze the sensor readings and check if they are anomalous per our rules' }] }
      ])

      const planEvent = events.find((e) => e.kind === 'stream' && e.event.type === 'plan')
      const planSteps = planEvent && planEvent.kind === 'stream' && planEvent.event.type === 'plan' ? planEvent.event.steps : undefined
      expect(planSteps).toHaveLength(2)
      expect(planSteps?.[0].role).toBe('mcp-operator') // inserted — not in the model's own plan
      expect(planSteps?.[1].role).toBe('data') // the model's own step, untouched
      expect(provider.requests[1].system ?? '').toMatch(/MCP Operator specialist/)
    })

    it('does not insert a domain-knowledge step when no MCP server is connected, even if needsDomainKnowledge is true', async () => {
      // The no-server case is substituteUnavailableMcpOperator's job, not this one's — inserting a step
      // that can't run would just waste a round on "no connected server fits."
      const registry = buildRegistry()
      const provider = new MockProvider([
        {
          text:
            '{"complexity": "compound", "needsDomainKnowledge": true, "needsUserData": true, "steps": [' +
            '{"role": "data", "description": "query the sensor readings"}]}',
          stopReason: 'end_turn'
        },
        { text: 'Readings deviate by 8%.', stopReason: 'end_turn' },
        { text: 'Here is what I found.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal,
        { planningEnabled: true, getConfiguration: () => ({ databases: 1, apis: 0, email: 0, mcp: 0 }) }
      )

      const events = await collect(orchestrator, [
        { role: 'user', content: [{ type: 'text', text: 'analyze the sensor readings and check if they are anomalous per our rules' }] }
      ])

      // No insertion happened, so the plan stays at 1 step — which never emits a 'plan' event at all and
      // runs through the ordinary top-level round instead (same as any other single-step plan; see the
      // sibling mcp-availability tests' own comment on why a 2-step plan is used there and not here).
      expect(events.find((e) => e.kind === 'stream' && e.event.type === 'plan')).toBeUndefined()
    })

    it('does not insert a duplicate domain-knowledge step when the plan already includes one', async () => {
      const registry = buildRegistry()
      const provider = new MockProvider([
        {
          text:
            '{"complexity": "compound", "needsDomainKnowledge": true, "needsUserData": true, "steps": [' +
            '{"role": "mcp-operator", "description": "look up the anomaly rule"}, ' +
            '{"role": "data", "description": "query the sensor readings"}]}',
          stopReason: 'end_turn'
        },
        { text: 'Rule: a deviation over 5% counts as an anomaly.', stopReason: 'end_turn' },
        { text: 'Readings deviate by 8%.', stopReason: 'end_turn' },
        { text: 'Yes, this is an anomaly by that rule.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal,
        { planningEnabled: true, getConfiguration: () => ({ databases: 1, apis: 0, email: 0, mcp: 1 }) }
      )

      const events = await collect(orchestrator, [
        { role: 'user', content: [{ type: 'text', text: 'analyze the sensor readings and check if they are anomalous per our rules' }] }
      ])

      const planEvent = events.find((e) => e.kind === 'stream' && e.event.type === 'plan')
      const planSteps = planEvent && planEvent.kind === 'stream' && planEvent.event.type === 'plan' ? planEvent.event.steps : undefined
      expect(planSteps).toHaveLength(2) // not 3 — no duplicate inserted
      expect(planSteps?.[0].role).toBe('mcp-operator')
      expect(planSteps?.[1].role).toBe('data')
    })

    it('tells the classifier a later step only sees written results, so an earlier step must return the actual values (Appendix D2: fabricated chart data)', async () => {
      const registry = buildRegistry()
      const provider = new MockProvider([
        { text: '{"complexity": "simple", "steps": []}', stopReason: 'end_turn' },
        { text: 'ok', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal,
        { planningEnabled: true }
      )
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
      const classifySystem = provider.requests[0].system ?? ''
      expect(classifySystem).toMatch(/only sees the written result of earlier steps/i)
      expect(classifySystem).toMatch(/never from assumed or example data/i)
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

    it('a round truncated mid-tool-call (max_tokens with a tool call already started) retries once with an informative tool_result instead of failing the step outright (TASKS #172/#173)', async () => {
      // Found live 2026-10-02: gpt-4o-mini's output hit the per-round token limit mid-tool-call
      // (python_run, right after being told to read captured data from its handoff file rather than
      // embed it), leaving a garbage/empty call that previously just ended the whole step with
      // "(no response)" — no chance to recover.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'call_1', name: 'read_file', input: {}, rawInput: '{"path": "unfinished' }], stopReason: 'max_tokens' },
        { text: 'All done.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(
        provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'read the file' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      // The truncated call was never actually executed — a real read_file call on a missing path
      // would error with a path-not-found message, not this one's specific wording.
      const toolResults = streamEvents.filter((e) => e.type === 'tool_result')
      expect(toolResults).toHaveLength(1)
      expect(toolResults[0]).toMatchObject({ isError: true })
      expect((toolResults[0] as { content: string }).content).toMatch(/cut off by the output-length limit/i)

      // The round recovered instead of failing the whole step/turn.
      const finalText = streamEvents
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e.type === 'text_delta' ? e.text : ''))
        .join('')
      expect(finalText).toBe('All done.')
      expect(provider.requests).toHaveLength(2) // one retry, not more
    })

    it('stops retrying after MAX_TRUNCATED_TOOL_CALL_RETRIES and fails the round like before, rather than looping forever', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'call_1', name: 'read_file', input: {} }], stopReason: 'max_tokens' },
        { toolCalls: [{ id: 'call_2', name: 'read_file', input: {} }], stopReason: 'max_tokens' }
      ])
      const orchestrator = new Orchestrator(
        provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'read the file' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      // One retry happened (2 requests total: the original + the one retry), then it gave up — not
      // an unbounded loop.
      expect(provider.requests).toHaveLength(2)
      const warning = streamEvents.find((e) => e.type === 'warning')
      expect(warning).toMatchObject({ type: 'warning' })
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
      const provider = new MockProvider([
        { text: '', stopReason: 'end_turn' },
        { text: '', stopReason: 'end_turn' },
        { text: '', stopReason: 'end_turn' }
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

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      // The first two empty rounds are retried (see the recovery tests below); only the third is reported.
      expect(provider.requests).toHaveLength(3)
      expect(streamEvents.filter((e) => e.type === 'message_stop')).toHaveLength(1)
      const warning = streamEvents.find((e) => e.type === 'warning')
      expect(warning).toMatchObject({ type: 'warning' })
      expect((warning as { message: string }).message).toMatch(/no visible output/i)

      const messages = events.filter((e) => e.kind === 'message')
      const persistedWarning = messages.find(
        (e) => e.kind === 'message' && e.content.some((c) => c.type === 'warning')
      )
      expect(persistedWarning).toBeDefined()
    })

    it('an empty round right after a tool result is retried with a nudge and the turn completes (real case: gpt-oss went silent after db_introspect_schema)', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }] },
        { text: '', stopReason: 'end_turn' },
        { text: 'Here is the answer.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal)

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'read a.txt and summarise' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents.some((e) => e.type === 'warning')).toBe(false)
      expect(streamEvents.some((e) => e.type === 'text_delta' && e.text === 'Here is the answer.')).toBe(true)
      // The stream ends exactly once, with the real answer — the empty round's own end_turn was not forwarded as the end of the turn.
      const stops = streamEvents.filter((e) => e.type === 'message_stop')
      expect(stops.at(-1)).toMatchObject({ stopReason: 'end_turn' })
      expect(stops.map((s) => (s as { stopReason: string }).stopReason)).toEqual(['tool_use', 'end_turn'])
      // The retry carries the nudge as its last message; the round before it did not.
      const lastOf = (i: number) => JSON.stringify(provider.requests[i].messages.at(-1))
      expect(lastOf(2)).toContain('previous reply was empty')
      expect(lastOf(1)).not.toContain('previous reply was empty')
      // The nudge is never persisted into the conversation record.
      expect(events.some((e) => e.kind === 'message' && JSON.stringify(e.content).includes('previous reply was empty'))).toBe(false)
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

    it('a direct delegate_to_mcp-operator tool call is rewritten to research when no MCP server is connected, with matching attribution (design-discussion.md §13.3, TASKS #146)', async () => {
      // The more common shape than a multi-step plan (#145): the top-level model calls a delegate tool
      // directly. The persisted tool_use name must match the specialist that actually ran — rewriting
      // AFTER dispatch would leave a `delegate_to_mcp-operator` tool_use next to a Researcher's result.
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'call_delegate', name: 'delegate_to_mcp-operator', input: { task: 'look up the inverter maintenance policy' } }] },
        { text: 'No wiki connected, and the web has nothing specific.', stopReason: 'end_turn' },
        { text: 'Here is what I found.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, {
        planningEnabled: false,
        getConfiguration: () => ({ databases: 0, apis: 0, email: 0, mcp: 0 })
      })

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'look up the inverter maintenance policy' }] }])

      const toolUse = events
        .filter((e) => e.kind === 'message' && e.role === 'assistant')
        .flatMap((e) => (e.kind === 'message' ? e.content : []))
        .find((c): c is Extract<typeof c, { type: 'tool_use' }> => c.type === 'tool_use')
      expect(toolUse).toMatchObject({ name: 'delegate_to_research' })
      const task = toolUse?.input.task
      expect(task).toMatch(/No MCP\/knowledge-base server is connected/)
      expect(task).toContain('Original task: look up the inverter maintenance policy')

      // Actually dispatched as Researcher, not left unresolved or sent to mcp-operator.
      expect(provider.requests[1]?.system ?? '').toMatch(/Research specialist/)
    })

    it('leaves a direct delegate_to_mcp-operator tool call untouched when an MCP server is connected', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'call_delegate', name: 'delegate_to_mcp-operator', input: { task: 'look up the inverter maintenance policy' } }] },
        { text: 'No connected server fits the request.', stopReason: 'end_turn' },
        { text: 'Here is what I found.', stopReason: 'end_turn' }
      ])
      const orchestrator = new Orchestrator(provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, {
        planningEnabled: false,
        getConfiguration: () => ({ databases: 0, apis: 0, email: 0, mcp: 1 })
      })

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'look up the inverter maintenance policy' }] }])

      const toolUse = events
        .filter((e) => e.kind === 'message' && e.role === 'assistant')
        .flatMap((e) => (e.kind === 'message' ? e.content : []))
        .find((c) => c.type === 'tool_use')
      expect(toolUse).toMatchObject({ name: 'delegate_to_mcp-operator' })
      expect(provider.requests[1]?.system ?? '').toMatch(/MCP Operator specialist/)
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

    it('a classify-and-plan call returning a genuinely empty reply (no text at all, not cut off) retries once and recovers a real plan — TASKS #140/#141', async () => {
      // Found live against Ollama gpt-oss-custom: the classify call returned literally no text (hidden
      // reasoning exhausted the output budget) and the request fell open to "no plan" on the very first
      // such reply, with no recovery — losing a compound request's step split. Distinct from the malformed-
      // but-non-empty case above (routine, left alone) and the output-token-limit case (already surfaced).
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { text: '', stopReason: 'end_turn' }, // attempt 1: genuinely empty
        {
          text: JSON.stringify({
            complexity: 'compound',
            steps: [
              { role: 'research', description: 'find X' },
              { role: 'data', description: 'find Y' }
            ]
          }),
          stopReason: 'end_turn'
        }, // attempt 2 (the one retry): a real plan
        { text: 'X is 5.', stopReason: 'end_turn' }, // step 1 — Researcher
        { text: 'Y is 10.', stopReason: 'end_turn' }, // step 2 — Data Access
        { text: 'Both found.', stopReason: 'end_turn' } // final synthesis
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

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      // requests: [0] classify attempt 1 (empty), [1] classify attempt 2 (the plan), [2] research, [3] data, [4] final
      expect(provider.requests).toHaveLength(5)
      expect(streamEvents.some((e) => e.type === 'plan')).toBe(true)
      expect(streamEvents.find((e) => e.type === 'warning')).toBeUndefined()
      expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Both found.' })
    })

    it('two genuinely empty classify-and-plan replies in a row still fall open to no plan — only one retry, not a loop', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { text: '', stopReason: 'end_turn' }, // attempt 1: empty
        { text: '', stopReason: 'end_turn' }, // attempt 2 (the one retry): still empty
        { text: 'Hi there!', stopReason: 'end_turn' } // falls open — ordinary round proceeds
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

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      // requests: [0] classify attempt 1, [1] classify attempt 2 (the one retry) — not a third attempt.
      expect(provider.requests).toHaveLength(3)
      // Falls open silently (console-only), same as the malformed-non-empty case above.
      expect(streamEvents.find((e) => e.type === 'warning')).toBeUndefined()
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
      // No "took too long" timeout warning — this wasn't a timeout. The
      // "stopped, no answer" warning (TASKS.md #102) is expected, though —
      // a top-level turn that produced literally nothing still gets that
      // explicit note so it isn't silently resent as unanswered context.
      expect(streamEvents.some((e) => e.type === 'warning' && /took too long|not a tool being stuck/i.test(e.message))).toBe(
        false
      )
      expect(streamEvents).toContainEqual({
        type: 'warning',
        message: 'This request was stopped before producing a response. No answer was given.',
        failureCategory: 'stopped_by_user'
      })
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
      // Same as the "hung round" Stop test above: no timeout warning, but
      // the "stopped, no answer" note (TASKS.md #102) is expected.
      expect(streamEvents.some((e) => e.type === 'warning' && /took too long|not a tool being stuck/i.test(e.message))).toBe(
        false
      )
      expect(streamEvents).toContainEqual({
        type: 'warning',
        message: 'This request was stopped before producing a response. No answer was given.',
        failureCategory: 'stopped_by_user'
      })
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

    describe('rate limiting (TASKS.md #91) — nested here for the shared fake-timer setup and TURN_DEADLINE_MS helpers', () => {
      const RATE_LIMIT_MAX_WAIT_MS = 2 * 60 * 1000
      const MAX_RATE_LIMIT_RETRIES = 5

      it('retries a rate-limited round and succeeds once the provider stops 429-ing, with a distinct, honest warning', async () => {
        const registry = buildRegistry()
        const agents = createAgents(registry)
        const provider = new MockProvider([
          { throwRateLimit: {} },
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
          { planningEnabled: false }
        )

        const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
        await vi.advanceTimersByTimeAsync(60_000) // comfortably past the first (2s) backoff
        const events = await resultPromise
        const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

        expect(provider.requests).toHaveLength(2)
        const warning = streamEvents.find((e) => e.type === 'warning')
        expect(warning).toBeDefined()
        expect((warning as { message: string }).message).toMatch(/rate limit/i)
        expect((warning as { message: string }).message).toMatch(/attempt 1\/5/i)
        // Transient: the renderer drops it after the wait (2s backoff + 4s grace), and it is never persisted as a message.
        expect((warning as { transientMs?: number }).transientMs).toBe(6000)
        expect(events.some((e) => e.kind === 'message' && e.content.some((c) => c.type === 'warning'))).toBe(false)
        expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Hello!' })
        expect(streamEvents.at(-1)).toEqual({ type: 'message_stop', stopReason: 'end_turn' })
      })

      it("respects the provider's own Retry-After header exactly, not the default backoff", async () => {
        const registry = buildRegistry()
        const agents = createAgents(registry)
        const provider = new MockProvider([
          { throwRateLimit: { headers: { 'retry-after': '5' } } },
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
          { planningEnabled: false }
        )

        const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
        await vi.advanceTimersByTimeAsync(4_999)
        expect(provider.requests).toHaveLength(1) // not retried yet — hasn't waited the real 5s
        await vi.advanceTimersByTimeAsync(2)
        const events = await resultPromise
        const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

        expect(provider.requests).toHaveLength(2)
        const warning = streamEvents.find((e) => e.type === 'warning')
        expect((warning as { message: string }).message).toMatch(/waiting 5s/i)
      })

      it('falls back to exponential backoff when the provider gives no Retry-After at all (the real shape of a Google/@google-genai rate-limit error)', async () => {
        const registry = buildRegistry()
        const agents = createAgents(registry)
        const provider = new MockProvider([{ throwRateLimit: {} }, { text: 'Hello!', stopReason: 'end_turn' }])
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
        await vi.advanceTimersByTimeAsync(1_999) // under the first backoff step (2s)
        expect(provider.requests).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(2)
        await resultPromise
        expect(provider.requests).toHaveLength(2)
      })

      it('caps a single wait at RATE_LIMIT_MAX_WAIT_MS even when Retry-After asks for much longer', async () => {
        const registry = buildRegistry()
        const agents = createAgents(registry)
        const provider = new MockProvider([
          { throwRateLimit: { headers: { 'retry-after': '600' } } }, // 10 minutes asked for
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
          { planningEnabled: false }
        )

        const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
        await vi.advanceTimersByTimeAsync(RATE_LIMIT_MAX_WAIT_MS - 1)
        expect(provider.requests).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(2)
        await resultPromise
        expect(provider.requests).toHaveLength(2) // retried at the 2-minute cap, not after the full 10 minutes asked for
      })

      it(`gives up after ${MAX_RATE_LIMIT_RETRIES} retries with a clear, specific message — not the raw SDK error, and it becomes a real communication_failure note (TASKS.md #102)`, async () => {
        const registry = buildRegistry()
        const agents = createAgents(registry)
        const provider = new MockProvider(
          Array.from({ length: MAX_RATE_LIMIT_RETRIES + 1 }, () => ({ throwRateLimit: {} }) as const)
        )
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

        // Exhausted retries throw a genuine error out of orchestrator.run()
        // (same as any other real failure — see "a genuine provider error
        // still propagates" above); `ipc/register.ts`'s own outer catch is
        // what turns this into a persisted `communication_failure` note
        // (TASKS.md #102) — a separate layer this orchestrator-level test
        // doesn't exercise.
        const resultPromise = collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
        // Attached immediately, before advancing any timers — otherwise the
        // promise can reject during the loop below with no handler
        // attached yet, tripping Node's unhandled-rejection warning even
        // though the test itself still passes.
        const rejection = expect(resultPromise).rejects.toThrow(
          new RegExp(`still in effect after ${MAX_RATE_LIMIT_RETRIES} retries`, 'i')
        )
        for (let i = 0; i < MAX_RATE_LIMIT_RETRIES; i++) {
          await vi.advanceTimersByTimeAsync(RATE_LIMIT_MAX_WAIT_MS + 1_000)
        }
        await rejection
        expect(provider.requests).toHaveLength(MAX_RATE_LIMIT_RETRIES + 1) // the initial attempt + every retry, no more
      })

      it('a Stop click during a rate-limit wait ends the turn immediately with a "stopped, no answer" note, not a generic error', async () => {
        const registry = buildRegistry()
        const agents = createAgents(registry)
        const controller = new AbortController()
        const provider = new MockProvider([
          { throwRateLimit: {} },
          { text: 'Should never be reached.', stopReason: 'end_turn' }
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
        // Let the round actually throw the rate-limit error and start its wait first.
        await vi.advanceTimersByTimeAsync(0)
        controller.abort()
        const events = await resultPromise
        const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

        expect(provider.requests).toHaveLength(1) // never actually retried
        expect(streamEvents).toContainEqual({ type: 'message_stop', stopReason: 'aborted' })
        expect(streamEvents).toContainEqual({
          type: 'warning',
          message: 'This request was stopped before producing a response. No answer was given.',
          failureCategory: 'stopped_by_user'
        })
      })

      it('a rate-limit wait extends the turn deadline rather than being silently eaten by it', async () => {
        // Burns down the shared 15-minute deadline almost entirely via
        // ordinary round-timeouts (the exact same helper the deadline tests
        // above already rely on), leaving only the final hang's own advance
        // worth of "real" budget. That remainder is then covered instead by
        // enough rate-limited retries (each capped at RATE_LIMIT_MAX_WAIT_MS)
        // to sum to at least as much wall-clock time. If `state.deadlineAt`
        // were NOT pushed forward by each wait (the bug this guards
        // against), the loop would stop attempting new rounds partway
        // through these retries — landing in the "took too long" wrap-up —
        // and the final scripted success below would never be reached.
        const advances = hangRoundAdvancesToDeadline()
        const withoutLast = advances.slice(0, -1)
        const lastAdvance = advances[advances.length - 1]
        const retriesNeeded = Math.ceil(lastAdvance / RATE_LIMIT_MAX_WAIT_MS)
        expect(retriesNeeded).toBeLessThanOrEqual(MAX_RATE_LIMIT_RETRIES) // sanity-check the test's own premise against today's constants

        const registry = buildRegistry()
        const agents = createAgents(registry)
        const provider = new MockProvider([
          ...withoutLast.map(() => ({ hang: true }) as const),
          ...Array.from({ length: retriesNeeded }, () => ({ throwRateLimit: {} }) as const),
          { text: 'Finally succeeded once the rate limit cleared.', stopReason: 'end_turn' as const }
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
        for (const advance of withoutLast) await vi.advanceTimersByTimeAsync(advance)
        for (let i = 0; i < retriesNeeded; i++) await vi.advanceTimersByTimeAsync(RATE_LIMIT_MAX_WAIT_MS + 1_000)
        const events = await resultPromise
        const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

        expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Finally succeeded once the rate limit cleared.' })
      }, 20000)

      it('classifyAndPlan falls open on a rate limit exactly like it already does on a timeout — no retry loop for a one-shot probe', async () => {
        const registry = buildRegistry()
        const agents = createAgents(registry)
        const provider = new MockProvider([
          { throwRateLimit: {} }, // the classify pre-pass itself
          { text: 'Hello!', stopReason: 'end_turn' } // the real round right after, proceeding as "simple"
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

        // Bypasses the classify-gate (#95) deliberately — see the note on
        // the first test in the classify-and-plan describe block.
        const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi and thanks' }] }])
        const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

        expect(provider.requests).toHaveLength(2) // classify (fails open immediately, no retry) + the one real round
        expect(streamEvents.some((e) => e.type === 'plan')).toBe(false)
        expect(streamEvents).toContainEqual({ type: 'text_delta', text: 'Hello!' })
      })
    })
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

  describe('show_media — inline image display (TASKS.md #82)', () => {
    it("splits a show_media result into a separate, real image block plus a short tool_result text — never the raw base64 as the model-visible content", async () => {
      const pngBytes = Buffer.from(
        '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
          '01f15c4890000000a49444154789c626001000000050001fce34d970000000049454e44ae426082',
        'hex'
      )
      await writeFile(join(root, 'chart.png'), pngBytes)

      const registry = buildRegistry()
      registry.register(showMediaTool)
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'call_show', name: 'show_media', input: { path: 'chart.png' } }], stopReason: 'tool_use' },
        { text: 'Here is the chart.', stopReason: 'end_turn' }
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

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'show me the chart' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      const imageEvent = streamEvents.find((e) => e.type === 'image')
      expect(imageEvent).toMatchObject({
        type: 'image',
        toolUseId: 'call_show',
        path: 'chart.png',
        mimeType: 'image/png'
      })
      expect((imageEvent as { dataBase64: string }).dataBase64).toBe(pngBytes.toString('base64'))

      // The tool_result the model actually sees is a short confirmation,
      // never the raw image bytes — a display-only feature has no reason to
      // spend real tokens re-sending an encoded image on every later request.
      const toolResultEvent = streamEvents.find((e) => e.type === 'tool_result')
      expect(toolResultEvent).toMatchObject({ type: 'tool_result', toolUseId: 'call_show', isError: false })
      const resultContent = (toolResultEvent as { content: string }).content
      expect(resultContent).toBe('Displayed chart.png to the user.')
      expect(resultContent.length).toBeLessThan(200)

      // What's actually sent to the (mocked) provider on the next round
      // must not carry the image block at all — confirmed against the real
      // per-provider wire-format mapping separately (anthropic.test.ts /
      // openai-compatible), this just confirms the block exists in the
      // *persisted* conversation for the UI to use.
      const persistedResultMessage = events.find(
        (e) => e.kind === 'message' && e.role === 'user' && e.content.some((c) => c.type === 'image')
      )
      expect(persistedResultMessage).toBeDefined()
    })

    it('download_image\'s result is displayed too, not stored as raw base64 text — and the model is told it has not seen the picture (found live: the photo never appeared)', async () => {
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c626001000000050001fce34d970000000049454e44ae426082', 'hex')
      vi.stubGlobal('fetch', vi.fn(async () => new Response(png, { status: 200 })))
      try {
        const registry = buildRegistry()
        registry.register(downloadImageTool)
        const agents = createAgents(registry)
        const provider = new MockProvider([
          { toolCalls: [{ id: 'call_dl', name: 'download_image', input: { url: 'https://img.test/p.png', name: 'p' } }], stopReason: 'tool_use' },
          { text: 'Done.', stopReason: 'end_turn' }
        ])
        const orchestrator = new Orchestrator(provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, { planningEnabled: false })
        const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'get the picture' }] }])
        const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)
        const image = streamEvents.find((e) => e.type === 'image') as { path: string; dataBase64: string } | undefined
        expect(image?.path).toBe('resources/p.png')
        expect(image?.dataBase64).toBe(png.toString('base64'))
        const result = (streamEvents.find((e) => e.type === 'tool_result') as { content: string }).content
        expect(result).toMatch(/^Displayed resources\/p\.png to the user\. You have not seen the image/)
        expect(result).not.toContain('dataBase64')
        expect(result.length).toBeLessThan(400)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('a genuinely failed show_media call (unsupported file type) surfaces as an ordinary tool error, no image block emitted', async () => {
      await writeFile(join(root, 'clip.mp4'), 'x')
      const registry = buildRegistry()
      registry.register(showMediaTool)
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'call_show', name: 'show_media', input: { path: 'clip.mp4' } }], stopReason: 'tool_use' },
        { text: "That file type isn't supported.", stopReason: 'end_turn' }
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

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'show me clip.mp4' }] }])
      const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)

      expect(streamEvents.some((e) => e.type === 'image')).toBe(false)
      const toolResultEvent = streamEvents.find((e) => e.type === 'tool_result')
      expect(toolResultEvent).toMatchObject({ type: 'tool_result', isError: true })
      expect((toolResultEvent as { content: string }).content).toMatch(/not a supported image type/i)
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

    // TASKS.md #149: root-caused live against session `cd81e5f5` — 15 list_directory calls across ~5
    // different real paths all shared one name-only bucket, so unrelated paths' calls evicted each other
    // regardless of which directory they were actually about. This is the direct regression test for that.
    it('#149: different list_directory paths do not compete for the same bucket, even well past the cap in total', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      for (const dir of ['charts', 'code', 'documents', 'resources', 'logs']) {
        await writeFileTool.execute({ path: `${dir}/real.txt`, content: 'x' }, ctx)
      }

      const dirs = ['charts', 'code', 'documents', 'resources', 'logs']
      const turns: ScriptedTurn[] = [
        ...dirs.map((dir, i) => ({
          toolCalls: [{ id: `ls${i + 1}`, name: 'list_directory', input: { path: dir } }],
          stopReason: 'tool_use' as const
        })),
        { text: 'Done.', stopReason: 'end_turn' as const }
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

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'list every folder' }] }])

      const finalRequest = provider.requests[provider.requests.length - 1]
      const toolResultContents = finalRequest.messages
        .flatMap((m) => m.content)
        .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.content)

      // 5 calls total (well past MAX_KEPT_RESULTS_PER_TOOL=3), but 5 genuinely different paths — none should
      // collapse, since each path gets its own bucket and no single path was called more than once.
      expect(toolResultContents).toHaveLength(5)
      expect(toolResultContents.every((c) => c.includes('real.txt'))).toBe(true)
    })

    // TASKS.md #149: the same path called past the cap still collapses — resource-keying must not turn the
    // cap into a no-op, only stop UNRELATED paths from sharing a bucket.
    it('#149: the SAME list_directory path called past the cap still collapses its oldest calls, compactly not content-free', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      await writeFileTool.execute({ path: 'code/keep.py', content: 'x' }, ctx)

      const turns: ScriptedTurn[] = [
        ...Array.from({ length: 4 }, (_, i) => ({
          toolCalls: [{ id: `ls${i + 1}`, name: 'list_directory', input: { path: 'code' } }],
          stopReason: 'tool_use' as const
        })),
        { text: 'Done.', stopReason: 'end_turn' as const }
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

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'list code four times' }] }])

      const finalRequest = provider.requests[provider.requests.length - 1]
      const toolResultContents = finalRequest.messages
        .flatMap((m) => m.content)
        .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.content)

      expect(toolResultContents).toHaveLength(4)
      // The oldest of the 4 (4 - MAX_KEPT_RESULTS_PER_TOOL=3) is collapsed, but compactly — it still names
      // the real file found, not the generic content-free "omitted" marker.
      expect(toolResultContents[0]).not.toMatch(/omitted to save context/)
      expect(toolResultContents[0]).toContain('keep.py')
      expect(toolResultContents[0]).toContain('collapsed to save context but still complete')
      // The 3 most recent stay fully untouched.
      for (const c of toolResultContents.slice(1)) expect(c).toContain('keep.py')
    })

    // TASKS.md #149: an older, already-resolved turn's calls must never be counted together with the
    // current turn's — the function's own doc comment always claimed "within a single turn" but, before
    // #149, actually ran against the whole session array.
    it('#149: an earlier turn\'s list_directory calls are never touched by the current turn\'s cap', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      // The new turn's single call actually executes for real against the workspace — needs `code/` to exist.
      await writeFileTool.execute({ path: 'code/real.py', content: 'x' }, ctx)

      // A prior, already-closed turn: exactly at the cap (3 calls to the same path) — nothing collapsed yet.
      const priorConversation: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'earlier request' }] },
        {
          role: 'assistant',
          content: [1, 2, 3].map((i) => ({
            type: 'tool_use' as const,
            id: `old${i}`,
            name: 'list_directory',
            input: { path: 'code' }
          }))
        },
        {
          role: 'user',
          content: [1, 2, 3].map((i) => ({
            type: 'tool_result' as const,
            toolUseId: `old${i}`,
            content: `old-listing-${i}`
          }))
        },
        { role: 'assistant', content: [{ type: 'text', text: 'done with that earlier request' }] },
        { role: 'user', content: [{ type: 'text', text: 'now list it again' }] }
      ]

      // The NEW turn: just one more list_directory call to the same path. If this wrongly shared a bucket
      // with the prior turn's 3, the total (4) would push the prior turn's oldest call stale.
      const turns: ScriptedTurn[] = [
        { toolCalls: [{ id: 'new1', name: 'list_directory', input: { path: 'code' } }], stopReason: 'tool_use' },
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

      await collect(orchestrator, priorConversation)

      const finalRequest = provider.requests[provider.requests.length - 1]
      const toolResultContents = finalRequest.messages
        .flatMap((m) => m.content)
        .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.content)

      // All 3 of the prior turn's results are still their real, original content — untouched by the new
      // turn's single call, which is exactly what "scoped to the current turn" means.
      expect(toolResultContents).toEqual(['old-listing-1', 'old-listing-2', 'old-listing-3', 'file  real.py'])
    })
  })

  describe('mid-run steering (#158)', () => {
    it('injects a drained comment between rounds: model sees plain text, persisted form keeps user_note, and a live event is streamed', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)

      let drainCalls = 0
      const drainSteeringComments = (): string[] => {
        drainCalls++
        // Nothing pending before round 1; one comment ready before round 2.
        return drainCalls === 2 ? ['wrong path, try code/ instead'] : []
      }

      const turns: ScriptedTurn[] = [
        { toolCalls: [{ id: 'call1', name: 'list_directory', input: { path: '.' } }], stopReason: 'tool_use' },
        { toolCalls: [{ id: 'call2', name: 'list_directory', input: { path: 'code' } }], stopReason: 'tool_use' },
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
        { planningEnabled: false, drainSteeringComments }
      )

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'list things' }] }])

      // The model's OWN request for round 2 (built after the drain) shows the note as ordinary text, never
      // the internal user_note type — normalizeUserNotesForWire applied right before the wire.
      const round2Request = provider.requests[1]
      const round2UserTexts = round2Request.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content)
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
      expect(round2UserTexts).toContain('wrong path, try code/ instead')
      expect(round2Request.messages.flatMap((m) => m.content).some((b) => b.type === 'user_note')).toBe(false)

      // The persisted form (what ipc/register.ts's generic insertMessage/enqueueMessage handling receives)
      // keeps the real user_note type, not normalized away — that's what lets splitIntoTurns/the renderer
      // recognize it later.
      const persistedNote = events.find(
        (e) => e.kind === 'message' && e.role === 'user' && e.content.some((b) => b.type === 'user_note')
      )
      expect(persistedNote).toBeDefined()
      if (persistedNote?.kind === 'message') {
        expect(persistedNote.content).toEqual([{ type: 'user_note', text: 'wrong path, try code/ instead' }])
      }

      // A live stream event fires too, so the UI shows it inline without waiting for a reload.
      const liveNoteEvent = events.find((e) => e.kind === 'stream' && e.event.type === 'user_note')
      expect(liveNoteEvent).toBeDefined()
      if (liveNoteEvent?.kind === 'stream' && liveNoteEvent.event.type === 'user_note') {
        expect(liveNoteEvent.event.text).toBe('wrong path, try code/ instead')
      }
    })

    it('never drains steering comments for a nested specialist\'s own rounds, only the top-level orchestrator\'s', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)

      let drainCalls = 0
      const drainSteeringComments = (): string[] => {
        drainCalls++
        return []
      }

      const turns: ScriptedTurn[] = [
        // Round 1 (top-level): delegate to coding.
        { toolCalls: [{ id: 'call_delegate', name: 'delegate_to_coding', input: { task: 'list files' } }] },
        // Round 2 (nested, agentRole coding): a tool call.
        { toolCalls: [{ id: 'call_ls', name: 'list_directory', input: { path: '.' } }], stopReason: 'tool_use' },
        // Round 3 (nested, agentRole coding): wrap-up, end_turn.
        { text: 'Listed.', stopReason: 'end_turn' },
        // Round 4 (top-level): final reply, end_turn.
        { text: 'The specialist listed the files.', stopReason: 'end_turn' }
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
        { planningEnabled: false, drainSteeringComments }
      )

      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'please list files' }] }])

      // 4 total rounds ran (confirmed by the 4 scripted turns above all being consumed), but only the 2
      // TOP-LEVEL rounds (1 and 4) should have checked for a pending steering comment — the 2 nested
      // specialist rounds (2 and 3) must not.
      expect(drainCalls).toBe(2)
    })
  })

  describe('real reasoning/thinking content (#147)', () => {
    it('persists a thinking block before the text block, and streams it live too', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const turns: ScriptedTurn[] = [{ thinking: 'considering the request', text: 'Here is the answer.', stopReason: 'end_turn' }]
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

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

      // Live: a real thinking_delta stream event fires, separate from text_delta.
      expect(events.some((e) => e.kind === 'stream' && e.event.type === 'thinking_delta' && e.event.text === 'considering the request')).toBe(true)

      // Persisted: the thinking block comes before the text block in the same assistant message.
      const persistedMessage = events.find((e) => e.kind === 'message' && e.role === 'assistant')
      expect(persistedMessage).toBeDefined()
      if (persistedMessage?.kind === 'message') {
        expect(persistedMessage.content).toEqual([
          { type: 'thinking', text: 'considering the request', agentRole: undefined },
          { type: 'text', text: 'Here is the answer.', agentRole: undefined }
        ])
      }
    })

    it('never persists a thinking block when nothing was streamed for it', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const turns: ScriptedTurn[] = [{ text: 'Just the answer, no reasoning streamed.', stopReason: 'end_turn' }]
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

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      const persistedMessage = events.find((e) => e.kind === 'message' && e.role === 'assistant')
      if (persistedMessage?.kind === 'message') {
        expect(persistedMessage.content.some((b) => b.type === 'thinking')).toBe(false)
      }
    })

    it('tags a delegated specialist\'s thinking with its own agentRole, same as text_delta already is', async () => {
      const registry = buildRegistry()
      const agents = createAgents(registry)
      const turns: ScriptedTurn[] = [
        { toolCalls: [{ id: 'call_delegate', name: 'delegate_to_coding', input: { task: 'write hello.txt' } }] },
        { thinking: 'planning the write', text: 'Writing the file now.', stopReason: 'end_turn' },
        { text: 'The specialist is done.', stopReason: 'end_turn' }
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

      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'write hello.txt' }] }])
      const taggedThinking = events.find(
        (e) => e.kind === 'stream' && e.event.type === 'thinking_delta' && e.event.agentRole === 'coding'
      )
      expect(taggedThinking).toBeDefined()
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

  describe('typed handoff between specialists (design step 3, Appendix D2)', () => {
    const rows = JSON.stringify(
      Array.from({ length: 30 }, (_, i) => ({ Year: 1996 + (i % 3), CustomerID: `C${i}`, TotalSales: i * 100.5 })),
      null,
      2
    )
    const fakeSql: Tool = {
      name: 'db_execute_sql',
      description: 'fake',
      inputSchema: { type: 'object', properties: {} },
      mutates: false,
      execute: async () => `30 row(s):\n${rows}`
    }
    const withSql = (): ToolRegistry => {
      const registry = buildRegistry()
      registry.register(fakeSql)
      return registry
    }
    const planOf = (...steps: Array<[string, string]>): ScriptedTurn => ({
      text: JSON.stringify({ complexity: 'compound', steps: steps.map(([role, description]) => ({ role, description })) }),
      stopReason: 'end_turn'
    })
    const run = async (turns: ScriptedTurn[], registry: ToolRegistry = withSql(), message = 'hi and thanks') => {
      const provider = new MockProvider(turns)
      const orchestrator = new Orchestrator(provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, {
        planningEnabled: true
      })
      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: message }] }])
      const userTexts = events
        .filter((e) => e.kind === 'message' && e.role === 'user')
        .flatMap((e) => (e.kind === 'message' ? e.content : []))
        .flatMap((c) => (c.type === 'text' ? [c.text] : []))
      return { provider, events, userTexts }
    }
    // The recorded `messages` array is the live conversation (replies are appended to it after the call), so
    // find the delegate's brief by its content rather than by position.
    const lastUserText = (req: { messages: Message[] }): string => {
      const texts = req.messages.flatMap((m) => m.content.flatMap((c) => (c.type === 'text' && c.text.startsWith('[Orchestrator ->') ? [c.text] : [])))
      return texts.at(-1) ?? ''
    }

    it('D2: the real rows a Data step retrieved reach the next step as a FILE named in its brief — not as a summary it can only guess from', async () => {
      const { provider, userTexts } = await run([
        planOf(['data', 'top 10 customers per year'], ['coding', 'chart them']),
        { toolCalls: [{ id: 'q1', name: 'db_execute_sql', input: { sql: 'select ...' } }] }, // Data round 1: the query
        { text: 'Retrieved the top customers for 1996-1998.', stopReason: 'end_turn' }, // Data round 2: prose summary only
        { text: 'Charting from the file.', stopReason: 'end_turn' }, // Coding
        { text: 'Charts are described above.', stopReason: 'end_turn' } // final synthesis
      ])

      // requests: [0] classify, [1] data r1, [2] data r2, [3] coding, [4] final
      const codingBrief = lastUserText(provider.requests[3])
      expect(codingBrief).toContain('[Orchestrator -> Developer]: chart them')
      expect(codingBrief).toMatch(/Inputs from earlier in this turn/)
      const m = /Data from data: (\.sachiv-handoff\/[^ ]+\.json) — db_execute_sql: 30 rows/.exec(codingBrief)
      expect(m, 'the brief must name the captured data file').not.toBeNull()

      // The file really holds all 30 rows the query returned — as pure, directly-parseable JSON (no
      // "30 row(s):" chat header): found live, a later step's script had to skip that line itself
      // before json.load() would work at all. The row count still reaches the brief above, via the
      // handoff note/summary, never by being embedded in the file.
      const saved = await readFile(join(root, m![1]), 'utf-8')
      expect(saved.startsWith('30 row(s):')).toBe(false)
      expect(JSON.parse(saved)).toHaveLength(30)

      // ...and the plan-step message the final round sees also names it, past the summary.
      expect(userTexts.find((t) => t.includes('[Plan step 1 — Data Access]'))).toContain('Data captured for later steps: .sachiv-handoff/')
    })

    it('lists the files a step actually created, derived from the workspace — including ones a script wrote, not just a tool call', async () => {
      const registry = withSql()
      registry.register({
        name: 'shell_execute',
        description: 'fake shell that runs a script which writes files',
        inputSchema: { type: 'object', properties: {} },
        mutates: false,
        execute: async () => {
          await writeFile(join(root, 'chart_1996.png'), 'png-bytes')
          await writeFile(join(root, 'chart_1997.png'), 'png-bytes')
          return 'exit code: 0'
        }
      })
      const { userTexts } = await run(
        [
          planOf(['coding', 'draw the charts and run the script'], ['research', 'find the caption text']),
          { toolCalls: [{ id: 's1', name: 'shell_execute', input: { command: 'python make.py' } }] },
          { text: 'Ran it.', stopReason: 'end_turn' },
          { text: 'Caption found.', stopReason: 'end_turn' },
          { text: 'Done.', stopReason: 'end_turn' }
        ],
        registry
      )
      const step = userTexts.find((t) => t.includes('[Plan step 1 — Developer]')) ?? ''
      expect(step).toContain('Files created or changed (verified by the app, not self-reported): chart_1996.png, chart_1997.png')
    })

    it('does not list a file the specialist merely CLAIMS to have made', async () => {
      const { userTexts } = await run([
        planOf(['coding', 'make the chart'], ['research', 'find a caption']),
        { text: 'I have created chart.png and report.docx for you!', stopReason: 'end_turn' },
        { text: 'A caption.', stopReason: 'end_turn' },
        { text: 'ok', stopReason: 'end_turn' }
      ])
      const step = userTexts.find((t) => t.includes('[Plan step 1 — Developer]')) ?? ''
      expect(step).toContain('I have created chart.png')
      expect(step).not.toContain('Files created or changed')
    })

    it('needs_input pauses the plan: later steps do not run on missing input, and the step says so', async () => {
      const { provider, userTexts } = await run([
        planOf(['data', 'get the sales figures'], ['coding', 'write a report']),
        { text: 'There are two databases.\n[handoff: needs_input] Which database should I use?', stopReason: 'end_turn' },
        { text: 'Which database should I use?', stopReason: 'end_turn' } // final round asks the user
      ])
      expect(provider.requests).toHaveLength(3) // classify, data, final — the coding step never ran
      const step = userTexts.find((t) => t.includes('[Plan step 1 — Data Access]')) ?? ''
      expect(step).toContain('(NEEDS INPUT — plan paused)')
      expect(step).toContain('Which database should I use?')
      expect(step).not.toContain('[handoff:') // the tag itself is stripped from what later rounds see
      expect(userTexts.some((t) => t.includes('[Plan step 2'))).toBe(false)
    })

    it('out_of_scope redirects the step ONCE to the role the specialist named', async () => {
      const { provider, userTexts } = await run([
        planOf(['coding', 'total the sales by year'], ['research', 'find a caption']),
        { text: 'That needs a database query.\n[handoff: out_of_scope -> data] SQL work', stopReason: 'end_turn' },
        { text: 'Sales by year: 1996=5.', stopReason: 'end_turn' }, // Data Access picks it up
        { text: 'A caption.', stopReason: 'end_turn' },
        { text: 'Here you go.', stopReason: 'end_turn' }
      ])
      expect(provider.requests).toHaveLength(5) // classify, coding, data (redirect), research, final
      expect(lastUserText(provider.requests[2])).toContain('[Orchestrator -> Data Access]: total the sales by year')
      const step = userTexts.find((t) => t.includes('[Plan step 1')) ?? ''
      expect(step).toMatch(/^\[Plan step 1 — Data Access\]:/) // labelled with the role that actually did it
      expect(userTexts.some((t) => t.includes('[Plan step 2 — Researcher]'))).toBe(true) // the plan carried on afterwards
      expect(step).toContain('Sales by year: 1996=5.')
    })

    it('a second out_of_scope is NOT redirected again (no ping-pong) and is reported as not done', async () => {
      const { provider, userTexts } = await run([
        planOf(['coding', 'do the thing'], ['research', 'find a caption']),
        { text: 'Not mine.\n[handoff: out_of_scope -> data]', stopReason: 'end_turn' },
        { text: 'Not mine either.\n[handoff: out_of_scope -> coding]', stopReason: 'end_turn' },
        { text: 'A caption.', stopReason: 'end_turn' },
        { text: 'Neither role could do it.', stopReason: 'end_turn' }
      ])
      expect(provider.requests).toHaveLength(5) // classify, coding, data, research, final — coding is NOT called a second time
      const step = userTexts.find((t) => t.includes('[Plan step 1')) ?? ''
      expect(step).toContain('(OUT OF SCOPE — not done)')
    })

    it('ignores a suggested role that does not exist instead of redirecting into nothing', async () => {
      const { provider } = await run([
        planOf(['coding', 'do the thing'], ['research', 'find a caption']),
        { text: 'Not mine.\n[handoff: out_of_scope -> wizard]', stopReason: 'end_turn' },
        { text: 'A caption.', stopReason: 'end_turn' },
        { text: 'ok', stopReason: 'end_turn' }
      ])
      expect(provider.requests).toHaveLength(4) // classify, coding, research, final — no redirect into a role that does not exist
    })

    it('ignores a suggested role that is real but not plannable (page-creator) instead of redirecting into a dead end', async () => {
      // Found live (manual_testing.md section 4, Prompt B): document-creator declined an image-embedding
      // step and named "page-creator" — a syntactically valid agent id, but isolated/one-slide-only and
      // never a sane target for an arbitrary redirected task. The redirect-once safety net must reject it
      // the same way it already rejects a hallucinated role id, not just dispatch into the dead end.
      const { provider, userTexts } = await run([
        planOf(['document-creator', 'embed charts into a Word document'], ['research', 'find a caption']),
        { text: 'Not mine.\n[handoff: out_of_scope -> page-creator]', stopReason: 'end_turn' },
        { text: 'A caption.', stopReason: 'end_turn' },
        { text: 'Document Creator could not do this part.', stopReason: 'end_turn' }
      ])
      expect(provider.requests).toHaveLength(4) // classify, document-creator, research, final — no redirect into page-creator
      const step = userTexts.find((t) => t.includes('[Plan step 1')) ?? ''
      expect(step).toContain('(OUT OF SCOPE — not done)')
    })

    it('overrides a false out_of_scope tag when the step already captured real data, instead of redirecting into wasted work (2026-10-01)', async () => {
      // Found live (Gemini): Data Access queried successfully, wrote a complete, correct answer from
      // real rows — then appended [handoff: out_of_scope -> document-creator] anyway, despite having
      // fully succeeded. The redirect-once safety net trusted it, triggering a real, wasted specialist
      // call (re-fetched the same data, built a whole document) whose output the step after it then
      // discarded entirely by overwriting the same file. A step that captured real data cannot also be
      // out of scope — the tag is a model slip, not a real capability boundary.
      const { provider, userTexts } = await run([
        planOf(['data', 'top 10 customers per year'], ['coding', 'chart them']),
        { toolCalls: [{ id: 'q1', name: 'db_execute_sql', input: { sql: 'select ...' } }] },
        { text: 'Here are the real top customers: Ernst Handel, QUICK-Stop.\n\n[handoff: out_of_scope -> document-creator]', stopReason: 'end_turn' },
        { text: 'Charting from the file.', stopReason: 'end_turn' },
        { text: 'Here you go.', stopReason: 'end_turn' }
      ])
      expect(provider.requests).toHaveLength(5) // classify, data (tool call + text), coding, final — no redirect into document-creator
      const step = userTexts.find((t) => t.includes('[Plan step 1')) ?? ''
      expect(step).toMatch(/^\[Plan step 1 — Data Access\]:/) // stays Data Access — never redirected
      expect(step).not.toContain('OUT OF SCOPE')
      expect(step).toContain('Here are the real top customers')
      expect(userTexts.some((t) => t.includes('[Plan step 2 — Developer]'))).toBe(true) // the plan carried on normally
    })

    it('no_information is named plainly on the step, and does not pause the plan or trigger a redirect (design-discussion.md §13.2(b), TASKS #143)', async () => {
      const { provider, userTexts } = await run([
        planOf(['mcp-operator', 'look up the inverter maintenance policy'], ['research', 'find a caption']),
        { text: 'Searched the connected wiki for inverter maintenance procedures.\n[handoff: no_information] nothing on file', stopReason: 'end_turn' },
        { text: 'A caption.', stopReason: 'end_turn' },
        { text: 'The wiki had nothing on this.', stopReason: 'end_turn' }
      ])
      // Unlike needs_input, the plan continues — the next step still ran (classify, mcp-operator, research, final).
      expect(provider.requests).toHaveLength(4)
      const step = userTexts.find((t) => t.includes('[Plan step 1 — MCP Operator]')) ?? ''
      expect(step).toContain('(NO INFORMATION FOUND — nothing relevant in the connected source)')
      expect(step).toContain('Searched the connected wiki for inverter maintenance procedures.')
      expect(step).not.toContain('[handoff:') // the tag itself is stripped from what later rounds see
      expect(userTexts.some((t) => t.includes('[Plan step 2 — Researcher]'))).toBe(true)
    })

    it('no_information grants a web fallback with a disclosure requirement, unless the user restricted sourcing (design-discussion.md §13.2(c),(d), §13.5, TASKS #144)', async () => {
      const { userTexts } = await run([
        planOf(['mcp-operator', 'look up the inverter maintenance policy'], ['research', 'find a caption']),
        { text: 'Searched the connected wiki.\n[handoff: no_information] nothing on file', stopReason: 'end_turn' },
        { text: 'A caption.', stopReason: 'end_turn' },
        { text: 'The wiki had nothing, but the web says X.', stopReason: 'end_turn' }
      ])
      const step = userTexts.find((t) => t.includes('[Plan step 1 — MCP Operator]')) ?? ''
      expect(step).toMatch(/may use web_search or delegate_to_research/)
      expect(step).toMatch(/say so plainly in the final answer/)
    })

    it('does NOT grant the web fallback when the user\'s own request restricted sourcing to the wiki', async () => {
      const { userTexts } = await run(
        [
          planOf(['mcp-operator', 'look up the inverter maintenance policy'], ['research', 'find a caption']),
          { text: 'Searched the connected wiki.\n[handoff: no_information] nothing on file', stopReason: 'end_turn' },
          { text: 'A caption.', stopReason: 'end_turn' },
          { text: 'The connected wiki had nothing on this.', stopReason: 'end_turn' }
        ],
        withSql(),
        'Only use the wiki for this and tell me the maintenance policy'
      )
      const step = userTexts.find((t) => t.includes('[Plan step 1 — MCP Operator]')) ?? ''
      expect(step).not.toMatch(/may use web_search or delegate_to_research/)
      expect(step).toMatch(/no web fallback should be attempted/)
    })

    it('incomplete (found something, not enough) inserts a real follow-up Research step, not just a hopeful note (TASKS #178)', async () => {
      // Found live 2026-10-02 retesting #172/#173/#175/#176 end-to-end: an MCP search returned 2 hits
      // from the right document, but the snippets (a table fragment, a citation) were useless — and it
      // got reported as done, with no mechanism to say "found something, but not enough." Unlike
      // no_information's note-only fallback, `incomplete` inserts a real plan step.
      const { provider, userTexts } = await run([
        planOf(['mcp-operator', 'look up the yaw misalignment definition'], ['coding', 'write a note']),
        {
          text: 'Found the right document, but only a table fragment and a citation.\n[handoff: incomplete] the actual methodology section was not in the snippet',
          stopReason: 'end_turn'
        },
        { text: 'Found more detail on the open web.', stopReason: 'end_turn' }, // the inserted Research step
        { text: 'A note.', stopReason: 'end_turn' }, // the originally-planned coding step
        { text: 'Final answer.', stopReason: 'end_turn' }
      ])
      // classify, mcp-operator, (inserted) research, coding, final synthesis — 5, not the original 4.
      expect(provider.requests).toHaveLength(5)

      const step1 = userTexts.find((t) => t.includes('[Plan step 1 — MCP Operator]')) ?? ''
      expect(step1).toContain('(PARTIAL INFORMATION — found something, but not enough)')
      expect(step1).toMatch(/a follow-up step has been added to fill the gap/)

      const step2 = userTexts.find((t) => t.includes('[Plan step 2 — Researcher]')) ?? ''
      expect(step2).toContain('yaw misalignment definition') // the inserted step's own description references the original gap
      expect(step2).toContain('Found more detail on the open web.')

      // The originally-planned step is still there too, just pushed to step 3 — nothing lost.
      expect(userTexts.some((t) => t.includes('[Plan step 3 — Developer]') && t.includes('A note.'))).toBe(true)
    })

    it('caps incomplete follow-up insertion at one per turn, so two incomplete steps cannot each insert their own (TASKS #178)', async () => {
      const { provider, userTexts } = await run([
        planOf(
          ['mcp-operator', 'look up the first definition'],
          ['mcp-operator', 'look up the second definition']
        ),
        { text: 'Thin result.\n[handoff: incomplete] missing detail', stopReason: 'end_turn' },
        { text: 'Follow-up search result.', stopReason: 'end_turn' }, // the one inserted Research step
        { text: 'Also thin.\n[handoff: incomplete] missing detail again', stopReason: 'end_turn' },
        { text: 'Final answer.', stopReason: 'end_turn' }
      ])
      // classify, mcp-operator(1), inserted research, mcp-operator(2), final — exactly one insertion, not two.
      expect(provider.requests).toHaveLength(5)
      expect(userTexts.filter((t) => t.includes('— Researcher]')).length).toBe(1)
      // The second incomplete step still gets its honest marker — it just didn't get its own follow-up.
      const step3 = userTexts.find((t) => t.includes('look up the second definition')) ?? ''
      expect(step3).toContain('(PARTIAL INFORMATION — found something, but not enough)')
      expect(step3).toMatch(/no further source is available to fill the gap/)
    })

    it('an ordinary reply with no tag, no files and no data is passed through exactly as before', async () => {
      const { userTexts } = await run([
        planOf(['research', 'find X'], ['research', 'find Y']),
        { text: 'X is 5.', stopReason: 'end_turn' },
        { text: 'Y is 6.', stopReason: 'end_turn' },
        { text: 'done', stopReason: 'end_turn' }
      ])
      expect(userTexts.find((t) => t.includes('[Plan step 1'))).toBe('[Plan step 1 — Researcher]: find X\n\nResult:\nX is 5.')
    })

    it('a failed specialist is status failed (set in code), regardless of what it wrote', async () => {
      const { userTexts, events } = await run([
        planOf(['data', 'get figures'], ['research', 'find a caption']),
        { throwError: 'Unknown data connection "sales_db".' },
        { text: 'A caption.', stopReason: 'end_turn' },
        { text: 'Could not get the figures.', stopReason: 'end_turn' }
      ])
      expect(userTexts.find((t) => t.includes('[Plan step 1'))).toContain('(FAILED — no usable result)')
      expect(events.filter((e) => e.kind === 'stream').map((e) => e.event)).toContainEqual({ type: 'plan_step_done', index: 0, isError: true })
    })

    it('the same handoff applies without a plan: a second delegate in the same turn is handed the first one\'s captured data', async () => {
      const registry = withSql()
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'd1', name: 'delegate_to_data', input: { task: 'get the rows' } }] }, // router round 1
        { toolCalls: [{ id: 'q1', name: 'db_execute_sql', input: {} }] }, // data r1
        { text: 'Got them.', stopReason: 'end_turn' }, // data r2
        { toolCalls: [{ id: 'd2', name: 'delegate_to_coding', input: { task: 'chart them' } }] }, // router round 2
        { text: 'Charted.', stopReason: 'end_turn' }, // coding
        { text: 'All done.', stopReason: 'end_turn' } // router final
      ])
      const orchestrator = new Orchestrator(provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal)
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'chart the sales' }] }])
      const codingBrief = lastUserText(provider.requests[4])
      expect(codingBrief).toContain('[Orchestrator -> Developer]: chart them')
      expect(codingBrief).toMatch(/Data from data: \.sachiv-handoff\/.+\.json — db_execute_sql: 30 rows/)
    })

    it('a tool the router does not carry but a specialist owns gets a redirect to that specialist, not a dead end', async () => {
      const registry = withSql()
      registry.register({ name: 'shell_execute', description: 'fake', inputSchema: { type: 'object', properties: {} }, mutates: false, execute: async () => 'x' })
      const agents = createAgents(registry)
      const provider = new MockProvider([
        { toolCalls: [{ id: 'c1', name: 'shell_execute', input: {} }] },
        { text: 'I will delegate.', stopReason: 'end_turn' }
      ])
      // The router's own tool list deliberately lacks shell_execute (as after the slim-router step).
      const orchestrator = new Orchestrator(provider, 'mock-model', agents, 'You are Sachivji.', registry.list().filter((t) => t.name !== 'shell_execute'), autoApprove(), ctx, signal)
      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'run it' }] }])
      const result = events.flatMap((e) => (e.kind === 'stream' && e.event.type === 'tool_result' ? [e.event.content] : []))[0]
      expect(result).toContain('belongs to the Developer specialist')
      expect(result).toContain('delegate_to_coding')
    })

    it('logs real tool calls with who made them — the router itself vs a specialist — and never an unknown tool (keeps the slim router\'s hot core honest)', async () => {
      const registry = withSql()
      const agents = createAgents(registry)
      const logged: Array<{ tool: string; agentRole: string }> = []
      const provider = new MockProvider([
        { toolCalls: [{ id: 'r1', name: 'read_file', input: { path: 'a.txt' } }, { id: 'u1', name: 'no_such_tool', input: {} }] }, // router: one real, one unknown
        { toolCalls: [{ id: 'd1', name: 'delegate_to_data', input: { task: 'rows' } }] }, // router delegates
        { toolCalls: [{ id: 'q1', name: 'db_execute_sql', input: {} }] }, // specialist's own call
        { text: 'Got them.', stopReason: 'end_turn' },
        { text: 'Done.', stopReason: 'end_turn' }
      ])
      await writeFile(join(root, 'a.txt'), 'hello')
      const orchestrator = new Orchestrator(provider, 'mock-model', agents, 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal, {
        planningEnabled: false,
        logToolUse: (sample) => logged.push(sample)
      })
      await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'go' }] }])
      expect(logged).toEqual([
        { tool: 'read_file', agentRole: 'router' },
        { tool: 'db_execute_sql', agentRole: 'data' }
      ])
    })

    it('a tool nobody owns is still just "Unknown tool"', async () => {
      const registry = withSql()
      const provider = new MockProvider([{ toolCalls: [{ id: 'c1', name: 'no_such_tool', input: {} }] }, { text: 'ok', stopReason: 'end_turn' }])
      const orchestrator = new Orchestrator(provider, 'mock-model', createAgents(registry), 'You are Sachivji.', registry.list(), autoApprove(), ctx, signal)
      const events = await collect(orchestrator, [{ role: 'user', content: [{ type: 'text', text: 'x' }] }])
      const result = events.flatMap((e) => (e.kind === 'stream' && e.event.type === 'tool_result' ? [e.event.content] : []))[0]
      expect(result).toBe('Unknown tool "no_such_tool".')
    })
  })
})

describe('parseJsonObjectLoosely', () => {
  it('accepts plain JSON, a fenced block, and an object surrounded by prose', () => {
    expect(parseJsonObjectLoosely('{"a": 1}')).toEqual({ a: 1 })
    expect(parseJsonObjectLoosely('```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(parseJsonObjectLoosely('Here you go: {"a": {"b": 2}} — done.')).toEqual({ a: { b: 2 } })
  })

  it('rejects text with no object, arrays and broken JSON', () => {
    expect(parseJsonObjectLoosely('I think this is a simple request.')).toBeUndefined()
    expect(parseJsonObjectLoosely('[1, 2]')).toBeUndefined()
    expect(parseJsonObjectLoosely('{"a": ')).toBeUndefined()
    expect(parseJsonObjectLoosely('')).toBeUndefined()
  })
})

describe('detectsSourceRestriction (design-discussion.md §13.5, TASKS #144)', () => {
  it('fires on an unambiguous restriction phrase', () => {
    expect(detectsSourceRestriction('Only use the wiki for this, what is the maintenance policy?')).toBe(true)
    expect(detectsSourceRestriction("Look this up but don't search the web for it")).toBe(true)
    expect(detectsSourceRestriction('Answer this without searching the internet')).toBe(true)
    expect(detectsSourceRestriction('Find the policy, no web search please')).toBe(true)
  })

  it('defaults to false (fallback allowed) for an ordinary request — a false negative here is safer than a false positive', () => {
    expect(detectsSourceRestriction('look up the maintenance policy for inverter faults and check for public advisories')).toBe(false)
    expect(detectsSourceRestriction('only tell me about the inverter, nothing else')).toBe(false) // "only" with no wiki/web mention
    expect(detectsSourceRestriction('')).toBe(false)
  })
})
