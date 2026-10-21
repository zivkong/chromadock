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
  expect((await band.find({ type: 'Text', text: /0\/0|agent/ }))?.text).toContain('1 agent')
  expect((await band.find({ type: 'Text', text: /audit/ }))?.text).toContain('audit')
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
