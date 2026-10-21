import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'aurora',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const HINT = {
  plugin: 'aurora',
  component: 'PromptHint',
  surface: 'terminal',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

test('the main robot strolls the hint line until an agent opens the band', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  // At rest: no band, and a robot rides the hint line's tail.
  const restBand = await $.ui.mount(BAND as never)
  expect(await restBand.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await restBand.unmount()

  await $.agent.spawn({ prompt: 'p', description: 'audit docs', subagentType: 'general-purpose', parentModel: 'm' } as never)

  // Seated after the walk in: the band draws the board and the robot's name tag.
  now += 10_000
  const band = await $.ui.mount(BAND as never)
  expect((await band.find({ type: 'Text', text: /⟳/ }))?.text).toContain('✓0 ⟳1 ✗0')
  expect((await band.find({ type: 'Text', text: /audit docs/ }))?.text).toContain('audit docs')
  await band.unmount()

  // A tool call puts it in the robot's speech bubble and the roster.
  await $.tool.call({ tool: 'Grep', agentId: 'agent-1', pattern: 'x' } as never)
  const busy = await $.ui.mount(BAND as never)
  expect((await busy.find({ type: 'Text', text: /⌕ Grep/ }))?.text).toContain('⌕ Grep')
  expect((await busy.find({ type: 'Text', text: /1 tool · Grep/ }))?.text).toContain('1 tool · Grep')
  await busy.unmount()

  // Long after its last tool call, it nods off.
  now += 60_000
  const asleep = await $.ui.mount(BAND as never)
  expect(await asleep.find({ type: 'Text', text: /zᶻ/ })).toBeDefined()
  await asleep.unmount()
})

test('a long task shows in full on the roster', async ($, on) => {
  const long = 'audit every CMS lifecycle hook for unpublish and draft handling across all content types'
  on('clock.now', () => ({ value: 5_000_000 }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-long' }))
  await $.agent.spawn({ prompt: 'p', description: long, subagentType: 'general-purpose', parentModel: 'm' } as never)
  const band = await $.ui.mount(BAND as never)
  expect((await band.find({ type: 'Text', text: /audit every/ }))?.text).toContain(long)
  await band.unmount()
})

test('the hint line carries the robot while nothing runs', async ($, on) => {
  let seen = ''
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    seen = String((e.props as { tail?: string }).tail ?? '')

    return <Text>hint</Text>
  })

  const hint = await $.ui.mount(HINT as never)
  expect(seen).toContain('▐◕ᴗ◕▌')
  await hint.unmount()
})
