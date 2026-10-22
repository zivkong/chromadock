import { expect, test } from 'claude-code/testing'
import { sofaEnds, type Crew } from '../hooks/pixel-office'

const SIDEBAR = {
  plugin: 'aurora',
  component: 'Pane',
  requestId: 'aurora',
  surface: 'terminal',
  props: { title: 'aurora', isFocused: false, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
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
  expect(await after.find({ type: 'Text', text: /map the/ })).toBeDefined()
  await after.unmount()

  // The workflow resumes the agent: a fresh robot walks in and gets to work.
  await spawn({ agentId: 'agent-1' })
  now += 10_000
  const back = await $.ui.mount(SIDEBAR as never)
  expect((await back.find({ type: 'Text', text: /1 at work/ }))?.text).toContain('1 at work')
  expect((await back.find({ type: 'Text', text: /Starting/ }))?.text).toContain('Starting')
  await back.unmount()
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
  on('command.register', () => ({ value: { command: 'aurora' } }))
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
  on('command.register', () => ({ value: { command: 'aurora' } }))
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

test('finished agents rest on the sofa two at a time, and keep their place once taken', () => {
  const agent = (id: string, seat: number, endedAt: number | null): Crew => ({
    id, seat, hue: 0, name: id, status: endedAt === null ? 'running' : 'done', startedAt: 0, endedAt, goneAt: null, lastTool: null, lastToolAt: null,
  })
  const office = (crew: Crew[], now: number) => ({ cols: 56, now, isWorking: false, leading: 0, crew, hours: 0, minutes: 0 })

  // Three finish together: the first two take the ends, the third goes straight out.
  const trio = sofaEnds(office([agent('a', 1, 1000), agent('b', 2, 1000), agent('c', 3, 1000)], 2000))
  expect([...trio.values()].filter(end => end >= 0).sort()).toEqual([0, 1])
  expect(trio.get('c')).toBe(-1)

  // Once 'a' has left the crew, 'b' and 'c' keep what they were given.
  const later = sofaEnds(office([agent('b', 2, 1000), agent('c', 3, 1000)], 30_000))
  expect(later.get('b')).toBe(trio.get('b'))
  expect(later.get('c')).toBe(-1)

  // One finishing long after has the sofa free again; one still working is not on it.
  const fresh = sofaEnds(office([agent('d', 1, 60_000), agent('e', 2, null)], 61_000))
  expect(fresh.get('d')).toBeGreaterThanOrEqual(0)
  expect(fresh.has('e')).toBe(false)
})
