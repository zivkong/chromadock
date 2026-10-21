import { expect, test } from 'claude-code/testing'

const SIDEBAR = {
  plugin: 'aurora',
  component: 'Pane',
  requestId: 'aurora',
  surface: 'terminal',
  props: { title: 'aurora', isFocused: false, bodyColumns: 42, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

test('at rest the office is quiet and the main robot wanders', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))

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
  expect((await seated.find({ type: 'Text', text: /audit every/ }))?.text).toContain(task)
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
  expect((await asleep.find({ type: 'Text', text: /zᶻ/ }))?.text).toContain('zᶻ')
  await asleep.unmount()
})
