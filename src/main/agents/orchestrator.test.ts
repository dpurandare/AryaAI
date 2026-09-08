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

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-orchestrator-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root) }
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
      'You are Sachiv.',
      registry.list(),
      autoApprove(),
      ctx
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
      'You are Sachiv.',
      registry.list(),
      autoApprove(),
      ctx
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
      'You are Sachiv.',
      registry.list(),
      denyAll,
      ctx
    )

    const events = await collect(orchestrator, [
      { role: 'user', content: [{ type: 'text', text: 'write denied.txt' }] }
    ])
    const streamEvents = events.filter((e) => e.kind === 'stream').map((e) => e.event)
    const result = streamEvents.find((e) => e.type === 'tool_result')

    expect(result).toMatchObject({ type: 'tool_result', isError: true, content: 'The user denied this tool call.' })
    await expect(readFile(join(root, 'denied.txt'), 'utf-8')).rejects.toThrow()
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
      'You are Sachiv.',
      registry.list(),
      autoApprove(),
      ctx
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
      'You are Sachiv.',
      registry.list(),
      autoApprove(),
      ctx
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
      'You are Sachiv.',
      registry.list(),
      autoApprove(),
      ctx
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
      'You are Sachiv.',
      registry.list(),
      autoApprove(),
      ctx
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
  })
})
