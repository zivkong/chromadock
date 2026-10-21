import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { AgentRow, FlowRow, FlowSummary, Git, Limit, Meter, MonthSpend } from '../types'

const meter = atom({ plugin: 'aurora', key: 'meter' } as const, null)
const git = atom({ plugin: 'aurora', key: 'git' } as const, null)
const frame = atom({ plugin: 'aurora', key: 'frame' } as const, 0)
// The robots' own clock, so the band and the hint line animate without redrawing the sidebar.
const beat = atom({ plugin: 'aurora', key: 'beat' } as const, 0)
const model = atom({ plugin: 'aurora', key: 'model' } as const, '')
const effort = atom({ plugin: 'aurora', key: 'effort' } as const, null)
const agents = atom({ plugin: 'aurora', key: 'agents' } as const, [])
const flows = atom({ plugin: 'aurora', key: 'flows' } as const, [])
const lastFlow = atom({ plugin: 'aurora', key: 'lastFlow' } as const, null)
const turn = atom({ plugin: 'aurora', key: 'turn' } as const, null)
const sessionStart = atom({ plugin: 'aurora', key: 'sessionStart' } as const, 0)
const monthSpend = atom({ plugin: 'aurora', key: 'monthSpend' } as const, null)
const session = atom({ plugin: 'aurora', key: 'session' } as const, null)

const PANE = 'aurora'
// The sidebar asks the dock for this many columns; a width the person drags wins.
const PANE_COLUMNS = 42

const TICK_MS = 110
// Idle: redraw roughly every 30 s so clocks and countdowns stay honest.
const IDLE_TICKS = Math.round(30_000 / TICK_MS)
// Agents are reconciled against $.agent.list() about every 2 s while any runs.
const POLL_TICKS = Math.round(2_000 / TICK_MS)
// A workflow with every agent settled and no spawn for this long is over.
const FLOW_SETTLE_MS = 20_000
// This month's spend is re-summed from transcripts this often (the script reads only new lines).
const MONTH_TICKS = Math.round(300_000 / TICK_MS)
// Robots step every this many ticks: briskly while agents are on stage, a stroll at rest.
const STAGE_TICKS = 2
const STROLL_TICKS = 4

// Palette from the Aurora Sidebar design: calm text, pastel rainbow.
const TEXT = '#d4d4d8'
const BRIGHT = '#f4f4f5'
const MUTED = '#8b8b94'
// Section titles: a step brighter than muted text, never as loud as values.
const HEAD = '#b4b4bc'
// Tracks and rules sit on the terminal's own (often pure black) ground: keep them visible.
const TRACK = '#5b5b66'
const RULE = '#46464f'
const GOOD = '#86efac'
const WARN = '#fcd34d'
const BAD = '#fca5a5'
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const SPINNER = ['◜', '◝', '◞', '◟']

let isWorking = false

// ── colour ────────────────────────────────────────────────────────────────

const hsl = (hue: number, sat = 0.8, light = 0.76): string => {
  const h = ((hue % 360) + 360) % 360
  const a = sat * Math.min(light, 1 - light)
  const channel = (n: number) => {
    const k = (n + h / 30) % 12
    const c = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))

    return Math.round(c * 255).toString(16).padStart(2, '0')
  }

  return `#${channel(0)}${channel(8)}${channel(4)}`
}

// Green at empty, through amber, to rose at full.
const heatHue = (pct: number): number => 140 - Math.min(100, Math.max(0, pct)) * 1.4

// ── formatting ────────────────────────────────────────────────────────────

const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path

const tokensLabel = (n: number): string => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`

  return `${n}`
}

// 38s · 1:04 · 2h 05m
const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))

  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

// 4m 12s · 2h 41m · 3d 4h
const span = (ms: number): string => {
  const mins = Math.floor(Math.max(0, ms) / 60_000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${String(mins % 60).padStart(2, '0')}m`
  if (mins > 0) return `${mins}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`

  return `${Math.floor(Math.max(0, ms) / 1000)}s`
}

// `claude-opus-5-5[1m]` → `Opus 5.5 · 1M`; `claude-haiku-4-5-20251001` → `Haiku 4.5`.
const prettyModel = (id: string): string => {
  if (id === '') return '…'

  const isLong = id.includes('[1m]')
  const parts = id.replace(/\[.*\]$/, '').replace(/^.*?claude-/, '').split('-').filter(p => !/^\d{8}$/.test(p))
  const [family = id, ...version] = parts
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1)}${version.length > 0 ? ` ${version.join('.')}` : ''}`

  return isLong ? `${name} · 1M` : name
}

// The model family alone, for the tight agent rows: `sonnet`, `opus`, `haiku`, `fable`.
const familyOf = (id: string): string => {
  const known = ['fable', 'opus', 'sonnet', 'haiku'].find(f => id.toLowerCase().includes(f))

  return known ?? (id === '' ? '' : (id.split(/[-/]/)[0] ?? id))
}

// One hue per model family, so a family reads the same everywhere in the sidebar.
const FAMILY_HUE: Record<string, number> = { opus: 300, fable: 190, sonnet: 30, haiku: 140 }

const modelHue = (id: string): number => FAMILY_HUE[familyOf(id)] ?? 250

const fit = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`

const findLimit = (limits: readonly Limit[], match: (kind: string) => boolean): Limit | undefined =>
  limits.find(l => match(l.kind.toLowerCase()))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const toMeter = (context: SessionContextUsage, limits: readonly SessionRateLimit[], cost: SessionCost | undefined): Meter => ({
  tokens: context.tokens,
  window: context.window,
  percent: context.percent,
  limits: limits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
  costUsd: cost?.usd,
})

// ── git ───────────────────────────────────────────────────────────────────

async function readGit($: EngineInterface): Promise<Git> {
  const cwd = await $.session.cwd()
  const head = await $.process
    .run(['git', 'rev-parse', '--abbrev-ref', 'HEAD', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { cwd, timeoutMs: 3000 })
    .catch(() => null)

  if (head === null || head.exitCode !== 0) {
    return { project: basename(cwd), branch: '', worktree: null, dirty: 0 }
  }

  const [branch = '', top = cwd, gitDir = '', commonDir = ''] = head.stdout.trim().split('\n')
  const isWorktree = gitDir.includes('/worktrees/')
  const mainRoot = isWorktree ? commonDir.replace(/\/\.git\/?$/, '') : top
  const status = await $.process.run(['git', 'status', '--porcelain'], { cwd, timeoutMs: 3000 }).catch(() => null)
  const dirty = status?.exitCode === 0 ? status.stdout.split('\n').filter(Boolean).length : 0

  return {
    project: basename(mainRoot),
    branch: branch === 'HEAD' ? 'detached' : branch,
    worktree: isWorktree ? basename(top) : null,
    dirty,
  }
}

// ── this month's spend ────────────────────────────────────────────────────

const isMonthSpend = (value: unknown): value is MonthSpend =>
  isRecord(value) &&
  typeof value.month === 'string' &&
  typeof value.usd === 'number' &&
  typeof value.sessions === 'number' &&
  isRecord(value.models) &&
  Object.values(value.models).every(v => typeof v === 'number')

// Sums ended sessions from transcripts (scripts/month-spend.py); the open session is
// left out there and added live at draw time, since its cost is only written at its end.
async function refreshMonth($: EngineInterface) {
  const root = $.plugin.root.replace(/\/\.claude-plugin\/?$/, '')
  const sessionId = await $.session.id()
  const ran = await $.process
    .run(['python3', `${root}/scripts/month-spend.py`, '--exclude', sessionId], { timeoutMs: 120_000 })
    .catch(() => null)

  if (ran === null || ran.exitCode !== 0) return

  try {
    const parsed: unknown = JSON.parse(ran.stdout)

    if (isMonthSpend(parsed)) await update($, monthSpend, () => parsed)
  } catch {
    // A malformed answer leaves the last good figure on screen.
  }
}

// The session's title lives only in its transcript (custom-title from /rename, else ai-title).
async function refreshSession($: EngineInterface) {
  const root = $.plugin.root.replace(/\/\.claude-plugin\/?$/, '')
  const id = await $.session.id()
  const ran = await $.process.run(['python3', `${root}/scripts/session-title.py`, id], { timeoutMs: 10_000 }).catch(() => null)
  let title: string | null = null

  try {
    const parsed: unknown = ran?.exitCode === 0 ? JSON.parse(ran.stdout) : null

    if (isRecord(parsed) && typeof parsed.title === 'string') title = parsed.title
  } catch {
    // No title yet: the row shows the id alone.
  }

  await update($, session, () => ({ id, title }))
}

const money = (usd: number): string =>
  `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ── agents & workflows in flight (module state; a reload starts them over) ──

const live = new Map<string, AgentRow>()
const runs = new Map<string, FlowRow>()

async function publish($: EngineInterface) {
  syncCast([...live.values()], await $.clock.now())
  await update($, agents, () => [...live.values()].map(a => ({ ...a })))
  await update($, flows, () => [...runs.values()].map(r => ({ ...r })))
}

function settle(row: AgentRow, status: 'done' | 'failed', at: number) {
  if (row.status !== 'running') return

  row.status = status
  row.endedAt = at

  // A loose subagent leaves the panel when it ends; a workflow's stays until its run does.
  if (row.runId === null) live.delete(row.id)
}

// Settle agents the engine has finished, and close workflows whose agents all have.
async function reconcile($: EngineInterface) {
  const now = await $.clock.now()
  const listed = await $.agent.list().catch(() => null)

  if (listed !== null) {
    for (const info of listed) {
      const row = live.get(info.id)

      if (row === undefined) continue
      if (info.status === 'failed' || info.status === 'killed') settle(row, 'failed', now)
      if (info.status === 'completed') settle(row, 'done', now)
    }
  }

  for (const run of runs.values()) {
    const members = [...live.values()].filter(a => a.runId === run.runId)
    const isIdle = members.length > 0 && members.every(a => a.status !== 'running') && now - run.lastSpawnAt > FLOW_SETTLE_MS

    if (!isIdle) continue

    const ended = Math.max(...members.map(a => a.endedAt ?? now))
    const summary: FlowSummary = {
      name: run.name,
      done: members.filter(a => a.status === 'done').length,
      total: members.length,
      failed: members.filter(a => a.status === 'failed').length,
      ms: ended - run.startedAt,
    }
    await update($, lastFlow, () => summary)
    for (const a of members) live.delete(a.id)
    runs.delete(run.runId)
  }

  await publish($)
}

async function trackAgent($: EngineInterface, id: string, label: string, type: string, modelId: string, runId: string | null) {
  const now = await $.clock.now()
  live.set(id, { id, label, type, model: modelId, runId, startedAt: now, endedAt: null, status: 'running', tools: 0, lastTool: null })

  if (runId !== null && runId !== '') {
    const run = runs.get(runId) ?? { runId, name: runId.slice(0, 9), startedAt: now, lastSpawnAt: now }
    run.lastSpawnAt = now
    runs.set(runId, run)
  }

  await publish($)
}

async function trackRun($: EngineInterface, runId: string, workflowName: unknown) {
  const name = typeof workflowName === 'string' ? workflowName : runId.slice(0, 9)
  const now = await $.clock.now()
  const run = runs.get(runId) ?? { runId, name, startedAt: now, lastSpawnAt: now }
  run.name = name
  runs.set(runId, run)
  await publish($)
}

async function countTool($: EngineInterface, agentId: string | undefined, tool: string) {
  if (agentId === undefined) {
    await update($, turn, t => (t === null ? t : { ...t, tools: t.tools + 1 }))

    return
  }

  const row = live.get(agentId)

  if (row === undefined) return

  row.tools += 1
  row.lastTool = tool
  await publish($)
}

async function startTurn($: EngineInterface) {
  const now = await $.clock.now()
  await update($, turn, () => ({ startedAt: now, endedAt: null, tools: 0 }))
}

// ── robots ────────────────────────────────────────────────────────────────
// At rest the main robot strolls along the hint line under the prompt. Once an agent
// is spawned the band above the prompt opens: the main robot conducts from its corner,
// and each agent walks in from an edge, sits down and types, then cheers (✓) or fizzles
// (✗) and walks off. The band closes when the last one has left.

// A sprite row is runs of text: body-coloured, or a face drawn dark on the body colour.
type Run = { text: string; isFace?: boolean }
type Sprite = [Run[], Run[], Run[]]
type Pose = 'stand' | 'walk' | 'type' | 'cheer' | 'fizzle' | 'conduct'

type Actor = { row: AgentRow; seat: number; fromLeft: boolean; hue: number; goneAt: number | null }

const SPRITE_COLS = 9
const SEAT_COLS = 10
// The conductor's corner, left of the first seat.
const CORNER_COLS = 12
// Rows of the stage: one for marks and hops above the heads, three for the robots.
const STAGE_ROWS = 4
const WALK_COLS_PER_S = 16
// How long a finished robot cheers or fizzles in its seat before it walks off.
const CHEER_MS = 1400
const FACE_INK = '#18181b'

// Module state like `live`: a reload clears the stage.
const cast = new Map<string, Actor>()

const hashOf = (id: string): number => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)

const face = (b: number, pose: Pose): string => {
  if (pose === 'fizzle') return ' ×_× '
  if (pose === 'cheer') return ' ◕▿◕ '
  if (pose === 'type') return ' •ᴗ• '
  // A blink every few seconds.
  return b % 23 === 22 ? ' –ᴗ– ' : ' ◕ᴗ◕ '
}

function sprite(pose: Pose, b: number): Sprite {
  const head: Run[] = [{ text: '  ▄▄▄▄▄  ' }]
  const body = (left: string, right: string): Run[] => [{ text: left }, { text: face(b, pose), isFace: true }, { text: right }]
  const stride = b % 2 === 0 ? '  ▝▀ ▀▘  ' : '  ▀▘ ▝▀  '

  switch (pose) {
    case 'walk':
      return [head, body(' ▐', '▌ '), [{ text: stride }]]
    case 'type':
      // The laptop's lid faces us; the hands tap at either side of it.
      return [head, body(' ▐', '▌ '), [{ text: b % 2 === 0 ? '▖▕▀▀◦▀▀▏ ' : ' ▕▀▀◦▀▀▏▗' }]]
    case 'cheer':
      return [head, body(' ╲', '╱ '), [{ text: '  ▀▀ ▀▀  ' }]]
    case 'conduct':
      return [head, body(' ▐', b % 4 < 2 ? '▌╱' : '▌╲'), [{ text: '  ▀▀ ▀▀  ' }]]
    default:
      return [head, body(' ▐', '▌ '), [{ text: '  ▀▀ ▀▀  ' }]]
  }
}

const seatX = (seat: number): number => CORNER_COLS + seat * SEAT_COLS

// Follows the published agents: a newcomer takes the lowest free seat, and one that
// leaves `live` without an outcome (a loose subagent) counts as done from that moment.
function syncCast(rows: readonly AgentRow[], now: number) {
  const seen = new Set<string>()

  for (const row of rows) {
    seen.add(row.id)
    const actor = cast.get(row.id)

    if (actor !== undefined) {
      actor.row = row
      continue
    }
    if (row.status !== 'running') continue

    const taken = new Set([...cast.values()].map(a => a.seat))
    let seat = 0
    while (taken.has(seat)) seat += 1
    const h = hashOf(row.id)
    cast.set(row.id, { row, seat, fromLeft: h % 2 === 0, hue: (seat * 47 + 200) % 360, goneAt: null })
  }

  for (const actor of cast.values()) {
    if (!seen.has(actor.row.id) && actor.row.endedAt === null && actor.goneAt === null) actor.goneAt = now
  }
}

type Placed = { id: string; x: number; top: number; pose: Pose; hue: number; mark: string; markColor: string }

// Where every robot stands now, worked out from the clock; robots that have walked off are dropped.
function stage(now: number, cols: number): { placed: Placed[]; hidden: number } {
  const seats = Math.max(1, Math.floor((cols - CORNER_COLS) / SEAT_COLS))
  const walked = (ms: number) => (Math.max(0, ms) / 1000) * WALK_COLS_PER_S
  const placed: Placed[] = []
  let hidden = 0

  for (const actor of cast.values()) {
    const home = seatX(actor.seat)
    const start = actor.fromLeft ? -SPRITE_COLS : cols
    const endedAt = actor.row.endedAt ?? actor.goneAt
    const isFailed = actor.row.status === 'failed'

    if (endedAt !== null && now - endedAt > CHEER_MS) {
      // Off by the nearer edge.
      const isLeftward = home + SPRITE_COLS / 2 < cols / 2
      const x = Math.round(isLeftward ? home - walked(now - endedAt - CHEER_MS) : home + walked(now - endedAt - CHEER_MS))

      if (x < -SPRITE_COLS || x > cols) {
        cast.delete(actor.row.id)
        continue
      }
      if (actor.seat >= seats) continue
      placed.push({ id: actor.row.id, x, top: 1, pose: 'walk', hue: actor.hue, mark: '', markColor: MUTED })
      continue
    }

    if (actor.seat >= seats) {
      hidden += 1
      continue
    }

    if (endedAt !== null) {
      const mark = isFailed ? '✗' : '✓'
      placed.push({ id: actor.row.id, x: home, top: 1, pose: isFailed ? 'fizzle' : 'cheer', hue: actor.hue, mark, markColor: isFailed ? BAD : GOOD })
      continue
    }

    const travelled = walked(now - actor.row.startedAt)
    const distance = Math.abs(home - start)

    if (travelled < distance) {
      const x = Math.round(actor.fromLeft ? start + travelled : start - travelled)
      placed.push({ id: actor.row.id, x, top: 1, pose: 'walk', hue: actor.hue, mark: '', markColor: MUTED })
      continue
    }

    placed.push({ id: actor.row.id, x: home, top: 1, pose: 'type', hue: actor.hue, mark: fit(actor.row.label, SPRITE_COLS), markColor: hsl(actor.hue, 0.5, 0.72) })
  }

  return { placed, hidden }
}

// ── hooks ─────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'aurora', description: 'Open the aurora sidebar' })
    void $.ui.open({ id: PANE, title: 'aurora', columns: PANE_COLUMNS })

    const usage = await $.session.usage()
    await update($, meter, () => toMeter(usage.context, usage.rateLimits, usage.cost))
    await update($, sessionStart, () => usage.startedAt)
    const g = await readGit($)
    await update($, git, () => g)
    const m = await $.session.model()
    await update($, model, () => m)

    void refreshMonth($)
    void refreshSession($)

    let ticks = 0
    $.clock.every(TICK_MS, () => {
      ticks += 1
      if (ticks % MONTH_TICKS === 0) void refreshMonth($)
      const isBusy = isWorking || live.size > 0

      if (isBusy || ticks % IDLE_TICKS === 0) void update($, frame, f => f + 1)
      if (ticks % (live.size > 0 || cast.size > 0 ? STAGE_TICKS : STROLL_TICKS) === 0) void update($, beat, b => b + 1)
      if (ticks % POLL_TICKS === 0 && live.size > 0) void reconcile($)
    })

    return started
  })

  on('command.run', { command: 'aurora' }, async $ => {
    await $.ui.open({ id: PANE, title: 'aurora', columns: PANE_COLUMNS })

    return { text: 'aurora sidebar opened.' }
  })

  on('session.measure', async ($, e, next) => {
    await update($, meter, () => toMeter(e.context, e.rateLimits, e.cost))

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    isWorking = true
    await startTurn($).catch(() => undefined)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const level = e.effort === undefined ? null : String(e.effort)

      if ((await read($, effort)) !== level) await update($, effort, () => level)
      if ((await read($, model)) !== e.model) await update($, model, () => e.model)
    }

    return yield* next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)

    // Bookkeeping only: it never fails the spawn itself.
    if ('agentId' in started && typeof started.agentId === 'string') {
      const runId = e.workflow?.runId ?? null
      await trackAgent($, started.agentId, e.description, e.subagentType, started.model, runId).catch(() => undefined)
    }

    return started
  })

  on('tool.call', async ($, e, next) => {
    await countTool($, e.agentId, e.tool).catch(() => undefined)
    const done = await next(e)

    if (e.tool === 'Workflow') {
      const result: unknown = done.result

      if (isRecord(result) && typeof result.runId === 'string') {
        await trackRun($, result.runId, result.workflowName).catch(() => undefined)
      }
    }

    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const now = await $.clock.now()

    if (e.agentId === undefined) {
      isWorking = false
      await update($, turn, t => (t === null ? t : { ...t, endedAt: now }))
      await refreshSession($).catch(() => undefined)
      const g = await readGit($)
      await update($, git, () => g)
    } else {
      const row = live.get(e.agentId)

      if (row !== undefined) {
        settle(row, 'done', now)
        await publish($)
      }
    }

    return done
  })

  // ── the band above the prompt: open while any robot is on stage ──
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, beat)
    const agentRows = await read($, agents)
    const flowRows = await read($, flows)
    const now = await $.clock.now()

    if (e.props.hasSurvey || cast.size === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const W = Math.max(CORNER_COLS + SEAT_COLS, e.props.bodyColumns)
    const { placed, hidden } = stage(now, W)
    const isRunning = agentRows.some(a => a.status === 'running')
    const drift = b * 9

    const draw = (s: Sprite, hue: number, color: string, key: string) =>
      s.map((runs, r) => (
        <Text key={`${key}-${r}`}>
          {runs.map((run, i) => (
            <Text key={`${key}-${r}-${i}`} color={run.isFace ? FACE_INK : color} backgroundColor={run.isFace ? hsl(hue, 0.7, 0.74) : undefined}>
              {run.text}
            </Text>
          ))}
        </Text>
      ))

    // The board: each workflow's name and count, then any loose agents.
    const loose = agentRows.filter(a => a.runId === null && a.status === 'running').length
    const boards = flowRows.map(run => {
      const members = agentRows.filter(a => a.runId === run.runId)
      const settled = members.filter(a => a.status !== 'running').length

      return `${run.name} ${settled}/${members.length} · ${clock(now - run.startedAt)}`
    })
    const board = [...boards, ...(loose > 0 ? [`${loose} agent${loose === 1 ? '' : 's'}`] : [])].join('   ')
    const spinner = SPINNER[b % SPINNER.length] ?? '◜'

    // The conductor waves while anyone types, and hops once the last has finished.
    const conductorHue = 330 + drift
    const isHopping = !isRunning && b % 4 < 2

    return (
      <Box flexDirection="column" width={W}>
        <Text wrap="truncate-end">
          <Text color={hsl(conductorHue, 0.85, 0.7)} bold>{'▍ '}</Text>
          <Text color={isRunning ? hsl(215 + drift) : GOOD}>{isRunning ? `${spinner} ` : '✓ '}</Text>
          <Text color={TEXT}>{fit(board === '' ? 'wrapping up' : board, W - 6)}</Text>
        </Text>
        <Box height={STAGE_ROWS} width={W}>
          <Box key="conductor" position="absolute" left={1} top={isHopping ? 0 : 1} flexDirection="column">
            {draw(sprite(isRunning ? 'conduct' : 'cheer', b), conductorHue, hsl(conductorHue), 'c')}
          </Box>
          {placed.map(p => (
            <Box key={`bot-${p.id}`} position="absolute" left={p.x} top={0} flexDirection="column">
              <Text color={p.markColor} wrap="truncate-end">{p.mark === '' ? ' ' : p.mark.length === 1 ? `    ${p.mark}` : p.mark}</Text>
              {draw(sprite(p.pose, b), p.hue, hsl(p.hue), `b${p.id}`)}
            </Box>
          ))}
          {hidden > 0 && (
            <Box key="crowd" position="absolute" left={Math.max(0, W - 10)} top={2}>
              <Text color={MUTED}>+{hidden} more</Text>
            </Box>
          )}
        </Box>
      </Box>
    )
  })

  // ── the hint line under the prompt: the main robot strolls there while the band is shut ──
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const b = await read($, beat)

    if (cast.size > 0) return next(e)

    const room = Math.max(6, Math.min(40, (e.viewport?.columns ?? 80) - e.props.hint.length - 14))
    // Back and forth along `room` columns, a step a beat.
    const lap = b % (room * 2)
    const x = lap < room ? lap : room * 2 - lap
    const look = e.props.isWorking ? '◕▿◕' : b % 23 === 22 ? '–ᴗ–' : '◕ᴗ◕'
    const robot = `▐${look}▌${e.props.isWorking ? (b % 2 === 0 ? 'ҩ' : '·') : ''}`

    return next({ ...e, props: { ...e.props, tail: `${' '.repeat(3 + x)}${robot}` } })
  })

  // ── the sidebar ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const m = await read($, meter)
    const g = await read($, git)
    const f = await read($, frame)
    const modelId = await read($, model)
    const level = await read($, effort)
    const agentRows = await read($, agents)
    const flowRows = await read($, flows)
    const last = await read($, lastFlow)
    const t = await read($, turn)
    const born = await read($, sessionStart)
    const spend = await read($, monthSpend)
    const sess = await read($, session)
    const now = await $.clock.now()
    // Content width: the body less one column of left padding and one spare at the right edge.
    const W = Math.max(20, e.props.bodyColumns - 2)
    const { Box, Text } = $.ui.resolve(e)

    // Colour drifts while anything runs; at rest it holds still.
    const isAlive = isWorking || agentRows.some(a => a.status === 'running')
    const drift = isAlive ? f * 6 : 0

    // ── primitives ──
    const gap = (key: string, rows = 1) => (
      <Box key={key} height={rows}>
        <Text> </Text>
      </Box>
    )

    // Label on the left, value on the right, one row, nothing wraps.
    const row = (left: RenderChildren, right: RenderChildren, key: string) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" width={W}>
        <Text wrap="truncate-end">{left}</Text>
        <Text>{right}</Text>
      </Box>
    )

    const rainbow = (text: string, from: number, sweep: number, bold = false) =>
      [...text].map((ch, i) => (
        <Text key={`r${from}-${i}`} color={hsl(from + drift + (i / Math.max(1, text.length - 1)) * sweep)} bold={bold}>
          {ch}
        </Text>
      ))

    // ▍ TITLE ─────────────── status, two quiet rows above, one below. No letter-spacing:
    // in a monospace cell grid a space between letters doubles the word instead of airing it.
    const heading = (title: string, hue: number, status: string, statusColor: string, key: string, glow = false) => {
      const word = title.toUpperCase()
      const tail = status === '' ? '' : ` ${status}`
      const fill = Math.max(2, W - 2 - word.length - 1 - tail.length)

      return (
        <Box key={key} flexDirection="column">
          {gap(`${key}-g`, 2)}
          <Text wrap="truncate-end">
            <Text color={hsl(hue + drift, 0.85, 0.7)} bold>{'▍ '}</Text>
            {glow ? rainbow(word, hue, 90, true) : <Text color={HEAD} bold>{word}</Text>}
            <Text color={RULE}>{` ${'─'.repeat(fill)}`}</Text>
            <Text color={statusColor}>{tail}</Text>
          </Text>
          {gap(`${key}-b`)}
        </Box>
      )
    }

    const bar = (pct: number, cells: number, hueOf: (i: number) => number, key: string, track = '─') => {
      // A segmented meter (▰▱) fills whole segments; a solid bar (█─) also draws the eighth.
      const isSegmented = track === '▱'
      const glyph = isSegmented ? '▰' : '█'
      const exact = (Math.min(100, Math.max(0, pct)) / 100) * cells
      const full = isSegmented ? Math.round(exact) : Math.floor(exact)
      const partial = isSegmented ? '' : (EIGHTHS[Math.round((exact - full) * 8) % 8] ?? '')

      return Array.from({ length: cells }, (_, i) => {
        if (i < full) return <Text key={`${key}${i}`} color={hsl(hueOf(i))}>{glyph}</Text>
        if (i === full && partial !== '') return <Text key={`${key}${i}`} color={hsl(hueOf(i))}>{partial}</Text>

        return <Text key={`${key}${i}`} color={track === '─' ? RULE : TRACK}>{track}</Text>
      })
    }

    // ── header: one line ──  ◆ project ⎇ branch ········ ● 3 · 2h 41m
    // A worktree swaps ⎇ for a violet ◇ and names its branch; the right edge carries
    // the tree's state (● n uncommitted, ✓ clean) and the session's age.
    const project = g?.project ?? '…'
    const age = born > 0 ? span(now - born) : ''
    const state = g === null || g.branch === '' ? '' : g.dirty > 0 ? `● ${g.dirty}` : '✓'
    const rightText = [state, age].filter(Boolean).join(' · ')
    const branchRoom = Math.max(4, W - 2 - project.length - 3 - rightText.length - 2)
    const isTree = g?.worktree != null
    const header = row(
      <Text>
        <Text color={hsl(330 + drift)}>{'◆ '}</Text>
        {rainbow(project, 0, 300, true)}
        {g !== null && g.branch !== '' && (
          <Text>
            <Text color={isTree ? hsl(265) : hsl(200)}>{isTree ? '  ◇ ' : '  ⎇ '}</Text>
            <Text color={isTree ? hsl(265, 0.6, 0.82) : TEXT}>{fit(g.branch, branchRoom)}</Text>
          </Text>
        )}
      </Text>,
      <Text>
        {state !== '' && <Text color={g !== null && g.dirty > 0 ? WARN : GOOD}>{state}</Text>}
        {state !== '' && age !== '' && <Text color={RULE}>{' · '}</Text>}
        <Text color={MUTED}>{age}</Text>
      </Text>,
      'header',
    )

    // ── session: its title, and the short id it resumes by ──
    const shortId = sess === null ? '' : sess.id.slice(0, 8)
    const sessionRow = row(
      <Text>
        <Text color={hsl(45, 0.7, 0.72)}>{'❯ '}</Text>
        {sess?.title == null ? (
          <Text color={MUTED} italic>untitled</Text>
        ) : (
          <Text color={TEXT}>{fit(sess.title, Math.max(6, W - shortId.length - 4))}</Text>
        )}
      </Text>,
      <Text color={MUTED}>{shortId}</Text>,
      'session',
    )

    // ── usage ──
    const limits = m?.limits ?? []
    const LABEL = 6
    const meterCells = Math.max(6, Math.min(14, W - LABEL - 6))
    const limitBlock = (label: string, hue: number, limit: Limit | undefined, key: string) => {
      const name = <Text color={hsl(hue)} bold>{label.padEnd(LABEL)}</Text>

      if (m === null) return row(name, <Text color={MUTED}>…</Text>, key)

      // A window the account does not report has no cap.
      if (limit === undefined) {
        return row(<Text>{name}<Text color={MUTED}>unlimited</Text></Text>, <Text>{rainbow('∞', 190, 0, true)}</Text>, key)
      }

      const pct = Math.round(limit.percentUsed)
      const resetIn = limit.resetsAt === undefined ? 0 : Date.parse(limit.resetsAt) - now

      return (
        <Box key={key} flexDirection="column">
          {row(
            <Text>{name}{bar(pct, meterCells, i => heatHue(((i + 1) / meterCells) * 100), `${key}m`, '▱')}</Text>,
            <Text color={hsl(heatHue(pct))} bold>{pct}%</Text>,
            `${key}-r`,
          )}
          {Number.isFinite(resetIn) && resetIn > 0 && (
            <Text color={MUTED}>{' '.repeat(LABEL)}resets in {span(resetIn)}</Text>
          )}
        </Box>
      )
    }

    // ── context ──
    const pct = m?.percent ?? (m?.tokens !== undefined && m.window > 0 ? Math.round((m.tokens / m.window) * 100) : 0)
    const glint = isWorking ? f % (W + 10) : -10
    const filled = Math.floor((Math.min(100, pct) / 100) * W)
    const ctxBar = bar(pct, W, i => (i / W) * 300 + drift, 'ctx').map((cell, i) =>
      i === glint && i < filled ? <Text key={`glint${i}`} color={BRIGHT} bold>█</Text> : cell,
    )

    // ── spend by model: ended sessions; the open one has no split until it ends ──
    const NAME = 11
    const MONEY = 10
    const models = Object.entries(spend?.models ?? {}).filter(([, usd]) => usd >= 0.01)
    const topModel = Math.max(0.01, ...models.map(([, usd]) => usd))
    const spendCells = Math.max(4, W - NAME - MONEY)
    const spendRows = models.map(([id, usd], i) =>
      row(
        <Text>
          <Text color={hsl(modelHue(id))}>{fit(prettyModel(id), NAME - 1).padEnd(NAME)}</Text>
          {bar((usd / topModel) * 100, spendCells, () => modelHue(id), `sp${i}`, ' ')}
        </Text>,
        <Text color={TEXT}>{money(usd)}</Text>,
        `spend-${i}`,
      ),
    )

    // ── ultracode ──
    const isUltra = level === 'xhigh' || level === 'max'
    const turnMs = t === null ? 0 : (t.endedAt ?? now) - t.startedAt

    return (
      <Box flexDirection="column" width={W + 1} paddingLeft={1}>
        {gap('top')}
        {header}
        {sessionRow}

        {heading('usage', 40, '', MUTED, 'usage')}
        {limitBlock('5h', 30, findLimit(limits, k => k === 'five_hour'), 'five')}
        {gap('u1')}
        {limitBlock('week', 140, findLimit(limits, k => k === 'seven_day'), 'week')}
        {gap('u2')}
        {limitBlock('fable', 300, findLimit(limits, k => k.includes('fable')), 'fable')}

        {heading('context', 185, prettyModel(modelId), MUTED, 'context')}
        {row(
          <Text>
            <Text color={BRIGHT} bold>{tokensLabel(m?.tokens ?? 0)}</Text>
            <Text color={MUTED}> of {tokensLabel(m?.window ?? 0)}</Text>
          </Text>,
          <Text color={hsl(heatHue(pct))} bold>{pct}%</Text>,
          'ctx-n',
        )}
        <Text>{ctxBar}</Text>

        {spend !== null && (
          <Box key="spend" flexDirection="column">
            {heading(
              'spend',
              55,
              new Date(`${spend.month}-01T12:00:00`).toLocaleString(undefined, { month: 'long' }),
              MUTED,
              'spend-h',
            )}
            {spendRows}
            {(m?.costUsd ?? 0) > 0 &&
              row(
                <Text color={MUTED}>this session</Text>,
                <Text color={MUTED}>{money(m?.costUsd ?? 0)}</Text>,
                'spend-live',
              )}
            {gap('spend-g')}
            {row(
              <Text color={TEXT} bold>total</Text>,
              <Text color={BRIGHT} bold>{money(spend.usd + (m?.costUsd ?? 0))}</Text>,
              'spend-t',
            )}
            <Text color={MUTED}>{spend.sessions + 1} sessions · API prices</Text>
          </Box>
        )}

        {isUltra && (
          <Box key="ultra" flexDirection="column">
            {heading('ultracode', 25, isWorking ? '⚡' : 'ready', isWorking ? hsl(30 + drift) : MUTED, 'ultra-h', true)}
            {row(<Text color={MUTED}>effort</Text>, <Text color={TEXT}>{level}</Text>, 'ultra-e')}
            {row(<Text color={MUTED}>orchestration</Text>, <Text color={GOOD}>auto</Text>, 'ultra-o')}
            {t !== null &&
              row(
                <Text color={MUTED}>{t.endedAt === null ? 'this turn' : 'last turn'}</Text>,
                <Text color={TEXT}>{span(turnMs)} · {t.tools} tool{t.tools === 1 ? '' : 's'}</Text>,
                'ultra-t',
              )}
            {flowRows.length === 0 && last !== null && (
              <Box key="ultra-last" flexDirection="column">
                {row(<Text color={MUTED}>last workflow</Text>, <Text color={TEXT}>{fit(last.name, W - 15)}</Text>, 'ultra-l')}
                {row(
                  '',
                  <Text color={last.failed > 0 ? BAD : MUTED}>
                    {last.done}/{last.total} {last.failed > 0 ? `✕${last.failed}` : '✓'} · {span(last.ms)}
                  </Text>,
                  'ultra-ls',
                )}
              </Box>
            )}
          </Box>
        )}

        {gap('bottom')}
      </Box>
    )
  })
}
