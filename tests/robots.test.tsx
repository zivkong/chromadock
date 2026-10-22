import { expect, test } from 'claude-code/testing'

const SIDEBAR = {
  plugin: 'chromadock',
  component: 'Pane',
  requestId: 'chromadock',
  surface: 'terminal',
  props: { title: 'chromadock', isFocused: false, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

test('at rest the office is quiet and the main robot wanders', async ($, on) => {
  // Late in a wander stop, so the main robot has arrived and wears its labels.
  on('clock.now', () => ({ value: 9000 * 1001 + 8000 }))

  const ui = await $.ui.mount(SIDEBAR as never)
  expect((await ui.find({ type: 'Text', text: /all quiet/ }))?.text).toContain('nothing on the board')
  expect((await ui.find({ type: 'Text', text: /Claude/ }))?.text).toContain('Claude')
  await ui.unmount()
})

test('an agent gets a desk, a tool bubble, a roster line, and dozes when idle', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: {} }))

  const task = 'audit every CMS lifecycle hook for unpublish and draft handling across all content types'
  await $.agent.spawn({ prompt: 'p', description: task, subagentType: 'general-purpose', parentModel: 'm' } as never)

  // Seated after the walk in: the board counts it and the roster shows the task in full.
  now += 10_000
  const seated = await $.ui.mount(SIDEBAR as never)
  expect((await seated.find({ type: 'Text', text: /1 at work/ }))?.text).toContain('1 at work')
  expect((await seated.find({ type: 'Text', text: /⟳1/ }))?.text).toContain('⟳1')
  expect((await seated.find({ type: 'Text', text: /audit every CMS lifecycle/ }))?.text).toContain(task)
  await seated.unmount()

  // A tool call puts it in the robot's speech bubble and on the roster.
  await $.tool.call({ tool: 'Grep', agentId: 'agent-1', pattern: 'x' } as never)
  const busy = await $.ui.mount(SIDEBAR as never)
  expect((await busy.find({ type: 'Text', text: /⌕ Grep/ }))?.text).toContain('⌕ Grep')
  expect((await busy.find({ type: 'Text', text: /1 tool · Grep/ }))?.text).toContain('1 tool · Grep')
  await busy.unmount()

  // Long after its last tool call, it nods off.
  now += 60_000
  const asleep = await $.ui.mount(SIDEBAR as never)
  expect((await asleep.find({ type: 'Text', text: /Dozing/ }))?.text).toContain('z Dozing')
  await asleep.unmount()
})

test('a finished workflow agent leaves the room while its run goes on, and a resume brings a robot back', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: '' }))

  const spawn = (resume?: { agentId: string }) =>
    $.agent.spawn({ prompt: 'p', description: 'map the ledger', subagentType: 'general-purpose', parentModel: 'm', workflow: { runId: 'wf_1', agentIndex: 1 }, resume } as never)

  await spawn()
  now += 10_000
  await $.turn.complete({ agentId: 'agent-1', reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' } as never)

  // Celebrating at the desk first.
  const cheering = await $.ui.mount(SIDEBAR as never)
  expect((await cheering.find({ type: 'Text', text: /Done!/ }))?.text).toContain('✓ Done!')
  await cheering.unmount()

  // Then out the door: no break-room wait for the run to close, and the desk is free again.
  now += 30_000
  const after = await $.ui.mount(SIDEBAR as never)
  // A robot on its break wears its lone mark beside its head; none is left in the room.
  expect(await after.find({ type: 'Text', text: /^✓$/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /Done!/ })).toBeUndefined()
  // Off the roster too; the board still counts it while its run goes on.
  expect(await after.find({ type: 'Text', text: /map the/ })).toBeUndefined()
  expect((await after.find({ type: 'Text', text: /✓1/ }))?.text).toContain('✓1')
  await after.unmount()

  // The workflow resumes the agent: a fresh robot walks in and gets to work.
  await spawn({ agentId: 'agent-1' })
  now += 10_000
  const back = await $.ui.mount(SIDEBAR as never)
  expect((await back.find({ type: 'Text', text: /1 at work/ }))?.text).toContain('1 at work')
  expect((await back.find({ type: 'Text', text: /Starting/ }))?.text).toContain('Starting')
  await back.unmount()
})

test('after a reload the office picks up the agents and workflow already running', async ($, on) => {
  let now = 2_000_000
  on('clock.now', () => ({ value: now }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'chromadock' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { context: { tokens: 0, window: 1_000_000, percent: 0 }, rateLimits: [], startedAt: 900_000 } }))
  on('session.cwd', () => ({ value: '/' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('store.get', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))

  // What the previous load left in the session's state: one workflow agent at work.
  const row = {
    id: 'agent-r', label: 'reconcile the vault ledger', type: 'general-purpose', model: 'claude-sonnet-5-5', runId: 'wf_r',
    startedAt: now - 60_000, endedAt: null, status: 'running' as const, tools: 3, lastTool: 'Read', lastToolAt: now - 5_000,
  }
  // Served once each, as the new load reads them back on start; after that the session's own state answers.
  const left: Record<string, unknown> = {
    agents: [row],
    flows: [{ runId: 'wf_r', name: 'ledger-audit', startedAt: now - 60_000, lastSpawnAt: now - 60_000 }],
  }
  on('state.get', ($s, e, next) => {
    const key = (e as { key: string }).key
      if (!(key in left)) return next(e)
    const value = left[key]
    delete left[key]
    return { value: { value, version: 1 } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // Its next tool call is counted, and its robot walks back in through the door: no teleport to the desk.
  await $.tool.call({ tool: 'Grep', agentId: 'agent-r', pattern: 'x' } as never)
  const entering = await $.ui.mount(SIDEBAR as never)
  expect((await entering.find({ type: 'Text', text: /4 tools · Grep/ }))?.text).toContain('4 tools · Grep')
  expect(await entering.find({ type: 'Text', text: /⌕ Grep/ })).toBeUndefined()
  await entering.unmount()

  // Seated once the walk is over, wearing its tool.
  now += 10_000
  const back = await $.ui.mount(SIDEBAR as never)
  expect((await back.find({ type: 'Text', text: /⌕ Grep/ }))?.text).toContain('⌕ Grep')
  await back.unmount()

  // And its finish is seen too.
  await $.turn.complete({ agentId: 'agent-r', reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't2' } as never)
  const done = await $.ui.mount(SIDEBAR as never)
  expect((await done.find({ type: 'Text', text: /Done!/ }))?.text).toContain('✓ Done!')
  await done.unmount()
})

test('an agent that finishes on its way in reaches its desk before it celebrates', async ($, on) => {
  let now = 3_000_000
  on('clock.now', () => ({ value: now }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-q' }))
  on('turn.complete', () => ({ text: '' }))

  await $.agent.spawn({ prompt: 'p', description: 'quick lookup', subagentType: 'Explore', parentModel: 'm' } as never)
  now += 300
  await $.turn.complete({ agentId: 'agent-q', reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't3' } as never)

  // Still walking in: no celebration at a desk it has not reached.
  const walking = await $.ui.mount(SIDEBAR as never)
  expect(await walking.find({ type: 'Text', text: /Done!/ })).toBeUndefined()
  await walking.unmount()
})

test('the roster drops finished agents, and a workflow notification closes its run and its stragglers', async ($, on) => {
  let now = 12_000_000
  let k = 0
  on('clock.now', () => ({ value: now }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-w${(k += 1)}` }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', () => ({ text: '' }))

  const spawn = (description: string, i: number) =>
    $.agent.spawn({ tool_use_id: 'toolu_wave', prompt: 'p', description, subagentType: 'general-purpose', parentModel: 'm', workflow: { runId: 'wf_wave', agentIndex: i } } as never)
  await spawn('review #301 security', 1)
  await spawn('merge #301', 2)
  now += 5_000
  await $.turn.complete({ agentId: 'agent-w1', reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't4' } as never)

  // The finished review is off the roster; the board still counts it.
  const mid = await $.ui.mount(SIDEBAR as never)
  expect(await mid.find({ type: 'Text', text: /[●✓] review #301 security/ })).toBeUndefined()
  expect((await mid.find({ type: 'Text', text: /● merge #301/ }))?.text).toContain('merge #301')
  expect((await mid.find({ type: 'Text', text: /✓1/ }))?.text).toContain('✓1')
  await mid.unmount()

  // The run is stopped: its notification names the Workflow call; the merge never reported back.
  now += 5_000
  await $.prompt.submit({
    text: '<task-notification>\n<task-id>wtask1</task-id>\n<tool-use-id>toolu_wave</tool-use-id>\n<status>killed</status>\n<summary>stopped</summary>\n</task-notification>',
    origin: { kind: 'task-notification' },
  } as never)
  const after = await $.ui.mount(SIDEBAR as never)
  expect(await after.find({ type: 'Text', text: /[●✓✗] merge #301/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /wf_wave/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /⟳1/ })).toBeUndefined()
  await after.unmount()
})

test('a ghost run restored from old state, with nothing heard for half an hour, is closed', async ($, on) => {
  const now = 20_000_000
  on('clock.now', () => ({ value: now }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'chromadock' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { context: { tokens: 0, window: 1_000_000, percent: 0 }, rateLimits: [], startedAt: 900_000 } }))
  on('session.cwd', () => ({ value: '/' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('store.get', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))

  const left: Record<string, unknown> = {
    agents: [{
      id: 'agent-g', label: 'build #145', type: 'general-purpose', model: 'claude-opus-5-5', runId: 'wf_ghost',
      startedAt: now - 3_600_000, endedAt: null, status: 'running', tools: 32, lastTool: 'Bash', lastToolAt: now - 2_400_000, activeAt: now - 2_400_000,
    }],
    flows: [{ runId: 'wf_ghost', name: 'wf_ghost', startedAt: now - 3_600_000, lastSpawnAt: now - 3_600_000 }],
  }
  on('state.get', ($s, e, next) => {
    const key = (e as { key: string }).key
    if (!(key in left)) return next(e)
    const value = left[key]
    delete left[key]
    return { value: { value, version: 1 } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(SIDEBAR as never)
  expect(await ui.find({ type: 'Text', text: /● build #145/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /wf_ghost/ })).toBeUndefined()
  await ui.unmount()
})

test('each agent shows its tokens, its workflow their sum, and a stale run can be dismissed', async ($, on) => {
  let now = 30_000_000
  let k = 0
  on('clock.now', () => ({ value: now }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-t${(k += 1)}` }))
  // A model step that read 150k of cached context and wrote a little.
  let usage = { input_tokens: 200, output_tokens: 1_800, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 4_000, model: 'claude-opus-5-5' }
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage }
  } as never)
  const step = async (agentId: string) => {
    const stream = $.turn.step({ turnId: 't', index: 0, agentId, model: 'claude-opus-5-5' } as never)
    for await (const _ of stream) void _
  }

  const spawn = (description: string, i: number) =>
    $.agent.spawn({ tool_use_id: 'toolu_tok', prompt: 'p', description, subagentType: 'general-purpose', parentModel: 'm', workflow: { runId: 'wf_tok', agentIndex: i } } as never)
  await spawn('build #401', 1)
  await spawn('review #401', 2)
  await step('agent-t1')
  usage = { ...usage, cache_read_input_tokens: 40_000 }
  await step('agent-t2')

  now += 10_000
  const ui = await $.ui.mount(SIDEBAR as never)
  // 200 + 1,800 + 150,000 + 4,000: the size of its latest request, as /workflows counts it.
  expect((await ui.find({ type: 'Text', text: /156k tok/ }))?.text).toContain('156k tok')
  expect((await ui.find({ type: 'Text', text: /46k tok/ }))?.text).toContain('46k tok')
  // The board line: the run's total.
  expect((await ui.find({ type: 'Text', text: /202k/ }))?.text).toContain('202k')

  // Dismissed from the board: the run and its agents are gone.
  await ui.press({ key: 'bd-x-wf_tok' } as never)
  await ui.unmount()
  const after = await $.ui.mount(SIDEBAR as never)
  expect(await after.find({ type: 'Text', text: /202k/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /● build #401/ })).toBeUndefined()
  await after.unmount()
})

test('the token count holds its place on the roster line, whatever tool the agent last called', async ($, on) => {
  let now = 40_000_000
  on('clock.now', () => ({ value: now }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-f' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 0, output_tokens: 4_000, cache_read_input_tokens: 210_000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' } }
  } as never)

  await $.agent.spawn({ prompt: 'p', description: 'browse the docs', subagentType: 'general-purpose', parentModel: 'm' } as never)
  const stream = $.turn.step({ turnId: 't', index: 0, agentId: 'agent-f', model: 'claude-opus-5-5' } as never)
  for await (const _ of stream) void _
  // A long tool name, over an hour in: the line still fits, the tokens whole, the tool name cut.
  await $.tool.call({ tool: 'mcp__plugin_playwright_playwright__browser_navigate', agentId: 'agent-f', url: 'https://example.com' } as never)
  now += 3_900_000

  const ui = await $.ui.mount(SIDEBAR as never)
  const line = await ui.find({ type: 'Text', text: /214k tok/ })
  expect(line?.text).toContain('214k tok')
  expect([...(line?.text ?? '')].length).toBeLessThanOrEqual(54)
  expect(line?.text).toContain('…')
  await ui.unmount()
})

test('usage folds to one line, and its toggle opens it', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('store.set', () => ({ value: undefined }))

  const ui = await $.ui.mount(SIDEBAR as never)
  expect((await ui.find({ type: 'Text', text: /5h … · wk … · f …/ }))?.text).toContain('5h … · wk … · f …')
  expect(await ui.find({ type: 'Text', text: /^week/ })).toBeUndefined()

  await ui.press({ key: 'usage-toggle' } as never)
  await ui.unmount()
  const open = await $.ui.mount(SIDEBAR as never)
  expect((await open.find({ type: 'Text', text: /^week/ }))?.text).toContain('week')
  await open.unmount()
})

test('a folded usage heading carries the whole summary', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  // A session start with the engine answered: usage carries two capped windows, Fable none.
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'chromadock' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({
    value: {
      context: { tokens: 120_000, window: 1_000_000, percent: 12 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 34 }, { kind: 'seven_day', percentUsed: 12 }],
      startedAt: 900_000,
    },
  }))
  on('session.cwd', () => ({ value: '/' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('store.get', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(SIDEBAR as never)
  const usage = await ui.find({ type: 'Text', text: /USAGE/ })
  expect(usage?.text).toContain('5h 34% · wk 12% · f ∞')
  expect(usage?.text.endsWith('5h 34% · wk 12% · f ∞')).toBe(true)
  await ui.unmount()
})

test('in Ghostty the office is a pixel-art picture', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'chromadock' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { context: { tokens: 0, window: 1_000_000, percent: 0 }, rateLimits: [], startedAt: 900_000 } }))
  on('session.cwd', () => ({ value: '/' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('store.get', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'TERM_PROGRAM' ? 'ghostty' : undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(SIDEBAR as never)
  const picture = await ui.find({ type: 'Image' } as never)
  expect(picture).toBeDefined()
  expect(JSON.stringify(picture)).toContain('the office')
  await ui.unmount()
})

test('an idle agent gives up its desk for a break, and walks back to a desk when its task goes on', async ($, on) => {
  let now = 5_000_000
  on('clock.now', () => ({ value: now }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-i' }))
  on('tool.call', () => ({ result: {} }))

  await $.agent.spawn({ prompt: 'p', description: 'wait on the build', subagentType: 'general-purpose', parentModel: 'm', workflow: { runId: 'wf_i', agentIndex: 1 } } as never)
  now += 10_000
  const seated = await $.ui.mount(SIDEBAR as never)
  expect((await seated.find({ type: 'Text', text: /Starting/ }))?.text).toContain('… Starting')
  await seated.unmount()

  // A minute with nothing done: it dozes, then sets off for the break area and sits there.
  now += 70_000
  await (await $.ui.mount(SIDEBAR as never)).unmount()
  now += 15_000
  const resting = await $.ui.mount(SIDEBAR as never)
  expect(await resting.find({ type: 'Text', text: /^◦$/ })).toBeDefined()
  expect(await resting.find({ type: 'Text', text: /Dozing|Starting/ })).toBeUndefined()
  // Still on the roster: a break is not the door.
  expect((await resting.find({ type: 'Text', text: /wait on the build/ }))?.text).toContain('wait on the build')
  await resting.unmount()

  // Its task goes on: back to a desk, wearing the tool.
  await $.tool.call({ tool: 'Grep', agentId: 'agent-i', pattern: 'x' } as never)
  await (await $.ui.mount(SIDEBAR as never)).unmount()
  now += 15_000
  const back = await $.ui.mount(SIDEBAR as never)
  expect((await back.find({ type: 'Text', text: /⌕ Grep/ }))?.text).toContain('⌕ Grep')
  expect(await back.find({ type: 'Text', text: /^◦$/ })).toBeUndefined()
  await back.unmount()
})

test('with every break spot taken, one more idle agent dozes on at its desk', async ($, on) => {
  let now = 9_000_000
  let k = 0
  on('clock.now', () => ({ value: now }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `agent-b${(k += 1)}` }))

  for (let i = 0; i < 7; i += 1) {
    await $.agent.spawn({ prompt: 'p', description: `idle ${i}`, subagentType: 'Explore', parentModel: 'm', workflow: { runId: 'wf_b', agentIndex: i + 1 } } as never)
  }
  now += 70_000
  await (await $.ui.mount(SIDEBAR as never)).unmount()
  now += 20_000
  const full = await $.ui.mount(SIDEBAR as never)
  expect(await full.findAll({ type: 'Text', text: /^◦$/ })).toHaveLength(6)
  expect((await full.find({ type: 'Text', text: /Dozing/ }))?.text).toContain('z Dozing')
  await full.unmount()
})
