import { expect, test } from 'claude-code/testing'

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
