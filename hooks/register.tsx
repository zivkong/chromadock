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
// Whether the spend section is open; kept in $.store so the choice outlives the session.
const spendOpen = atom({ plugin: 'aurora', key: 'spendOpen' } as const, false)
const SPEND_OPEN_KEY = 'spendOpen'

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
// Robots step every this many ticks: briskly while agents are in the office, slowly at rest.
const STAGE_TICKS = 2
const STROLL_TICKS = 3

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
  live.set(id, { id, label, type, model: modelId, runId, startedAt: now, endedAt: null, status: 'running', tools: 0, lastTool: null, lastToolAt: null })

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
  row.lastToolAt = await $.clock.now()
  await publish($)
}

async function startTurn($: EngineInterface) {
  const now = await $.clock.now()
  await update($, turn, () => ({ startedAt: now, endedAt: null, tools: 0 }))
}

// ── robots ────────────────────────────────────────────────────────────────
// The sidebar's office, drawn from above on a navy floor: a grid of desks, plants down
// the left wall and a break area on the right. The main robot keeps the first desk: it
// works there while Claude does, and at rest wanders to the coffee, the water and the
// team. Each agent walks in, takes a desk and works, its status the tool it called last;
// done, it heads for the break area until its run closes, then leaves.

type Pose = 'walk' | 'work' | 'doze' | 'idle' | 'cheer' | 'fizzle'
type Point = { x: number; y: number }
type Actor = { row: AgentRow; seat: number; fromLeft: boolean; hue: number; goneAt: number | null; leftAt: number | null }
type Cell = { ch: string; fg: string; bg: string; bold: boolean }
type Figure = { key: string; at: Point; pose: Pose; hue: number; status: string; name: string; statusColor: string }

const FACE_INK = '#18181b'
const FLOOR = '#141a33'
const FLOOR_DOT = '#283158'
const DESK_TOP = '#a1a1aa'
const MONITOR_OFF = '#3f3f46'
const CHAIR = '#52525b'
const LABEL_INK = '#93c5fd'
const PLACARD = '#6b7280'

// A desk station: monitor, desktop, the robot's two rows (a chair when empty), status, name.
const DESK_COLS = 9
const DESK_ROWS = 6
const DESKS_ACROSS = 3
const DESKS_DOWN = 3
// The plants' wall at the left; the break area takes what is right of the desks.
const WALL_COLS = 2
const ROOM_ROWS = 1 + DESKS_DOWN * (DESK_ROWS + 1) + 1
const WALK_COLS_PER_S = 8
// How long a finished robot celebrates at its desk, then lingers at the break area once its run has closed.
const CHEER_MS = 1400
const LINGER_MS = 4000
// A robot with no tool call for this long nods off.
const DOZE_MS = 30_000
// At rest the main robot moves on to its next spot this often.
const WANDER_MS = 9000
// Agents listed on the roster before the rest fold into "+n more".
const ROSTER_AGENTS = 12
// One glyph per tool for the status labels; anything else gets a dot.
const TOOL_GLYPH: Record<string, string> = {
  Bash: '$', Read: '▤', Grep: '⌕', Glob: '⌕', Edit: '✎', Write: '✎', NotebookEdit: '✎',
  WebFetch: '⇣', WebSearch: '⌕', Agent: '◆', Skill: '★', ToolSearch: '⌕',
}

// Module state like `live`: a reload clears the office.
const cast = new Map<string, Actor>()

const hashOf = (id: string): number => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)

// Follows the published agents: a newcomer takes the lowest free desk after the main robot's,
// and one that leaves `live` is marked gone (without an outcome it counts as done).
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
    let seat = 1
    while (taken.has(seat)) seat += 1
    cast.set(row.id, { row, seat, fromLeft: hashOf(row.id) % 2 === 0, hue: (seat * 47 + 160) % 360, goneAt: null, leftAt: null })
  }

  for (const actor of cast.values()) {
    if (seen.has(actor.row.id)) continue
    if (actor.row.endedAt === null && actor.goneAt === null) actor.goneAt = now
    actor.leftAt ??= now
  }
}

// ── the floor plan, for a room `cols` wide ──

const deskOrigin = (seat: number): Point => ({
  x: WALL_COLS + (seat % DESKS_ACROSS) * DESK_COLS,
  y: 1 + Math.floor(seat / DESKS_ACROSS) * (DESK_ROWS + 1),
})

// Where a robot sits: on the chair, below its desk.
const chairOf = (seat: number): Point => {
  const o = deskOrigin(seat)

  return { x: o.x + 3, y: o.y + 2 }
}

const breakLeft = (): number => WALL_COLS + DESKS_ACROSS * DESK_COLS

const spots = (): { at: Point; says: string }[] => {
  const x = breakLeft()

  return [
    { at: { x: deskOrigin(1).x + 7, y: deskOrigin(1).y + 2 }, says: '◌ Chatting' },
    { at: { x: x + 1, y: 3 }, says: '☕ Coffee' },
    { at: { x: x + 1, y: 10 }, says: '◍ Water' },
    { at: { x: x + 1, y: 16 }, says: '● Snacks' },
    { at: chairOf(0), says: '▤ Reading' },
  ]
}

// Where a finished robot waits out its run.
const breakSlot = (seat: number): Point => {
  const x = breakLeft()
  const slots = [{ x: x + 1, y: 6 }, { x: x + 5, y: 13 }, { x: x + 1, y: 13 }, { x: x + 5, y: 19 }, { x: x + 1, y: 19 }]

  return slots[seat % slots.length] ?? { x: x + 1, y: 6 }
}

// Along x first, then y, at walking pace; `arrived` once there.
function walk(from: Point, to: Point, startedAt: number, now: number): { at: Point; arrived: boolean } {
  const steps = (Math.max(0, now - startedAt) / 1000) * WALK_COLS_PER_S
  const dx = to.x - from.x
  const dy = to.y - from.y

  if (steps >= Math.abs(dx) + Math.abs(dy)) return { at: to, arrived: true }
  if (steps < Math.abs(dx)) return { at: { x: Math.round(from.x + Math.sign(dx) * steps), y: from.y }, arrived: false }

  return { at: { x: to.x, y: Math.round(from.y + Math.sign(dy) * (steps - Math.abs(dx))) }, arrived: false }
}

const travelMs = (from: Point, to: Point): number => ((Math.abs(to.x - from.x) + Math.abs(to.y - from.y)) / WALK_COLS_PER_S) * 1000

// Every agent's robot where it stands now; robots that have walked out are dropped.
function workers(now: number, cols: number): { figures: Figure[]; hidden: number } {
  const desks = DESKS_ACROSS * DESKS_DOWN
  const figures: Figure[] = []
  let hidden = 0

  for (const actor of cast.values()) {
    const { row, seat, hue } = actor
    const chair = chairOf(seat)
    const name = row.label
    const endedAt = row.endedAt ?? actor.goneAt
    const isFailed = row.status === 'failed'

    if (seat >= desks) {
      if (endedAt === null) hidden += 1
      else if (actor.leftAt !== null) cast.delete(row.id)
      continue
    }

    if (endedAt === null) {
      const door: Point = { x: actor.fromLeft ? -3 : cols, y: chair.y }
      const going = walk(door, chair, row.startedAt, now)

      if (!going.arrived) {
        figures.push({ key: row.id, at: going.at, pose: 'walk', hue, status: '→ Arriving', name, statusColor: LABEL_INK })
        continue
      }

      const isDozing = now - (row.lastToolAt ?? row.startedAt) > DOZE_MS
      const tool = row.lastTool === null ? '… Starting' : `${TOOL_GLYPH[row.lastTool] ?? '•'} ${row.lastTool}`
      figures.push({ key: row.id, at: chair, pose: isDozing ? 'doze' : 'work', hue, status: isDozing ? 'zᶻ Dozing' : tool, name, statusColor: isDozing ? MUTED : LABEL_INK })
      continue
    }

    // Done: celebrate at the desk, take a break, and leave once the run has closed.
    if (now - endedAt < CHEER_MS) {
      figures.push({ key: row.id, at: chair, pose: isFailed ? 'fizzle' : 'cheer', hue, status: isFailed ? '✗ Crashed' : '✓ Done!', name, statusColor: isFailed ? BAD : GOOD })
      continue
    }

    const slot = breakSlot(seat)
    const toBreak = walk(chair, slot, endedAt + CHEER_MS, now)
    const arrivedAt = endedAt + CHEER_MS + travelMs(chair, slot)
    const leavesAt = actor.leftAt === null ? null : Math.max(actor.leftAt, arrivedAt + LINGER_MS)

    if (leavesAt !== null && now >= leavesAt) {
      const exit = { x: cols, y: slot.y }
      const out = walk(slot, exit, leavesAt, now)

      if (out.arrived) {
        cast.delete(row.id)
        continue
      }
      figures.push({ key: row.id, at: out.at, pose: 'walk', hue, status: '← Heading out', name, statusColor: MUTED })
      continue
    }

    figures.push({
      key: row.id,
      at: toBreak.at,
      pose: toBreak.arrived ? 'idle' : 'walk',
      hue,
      status: isFailed ? '✗ Crashed' : toBreak.arrived ? 'On break ✓' : '☕ Break time',
      name,
      statusColor: isFailed ? BAD : toBreak.arrived ? GOOD : LABEL_INK,
    })
  }

  return { figures, hidden }
}

// The main robot: at its desk while Claude works or leads agents, wandering at rest.
function mainRobot(now: number, isBusy: boolean, leading: number): Figure {
  const base = { key: 'main', hue: 330, name: 'Claude', statusColor: LABEL_INK }

  if (isBusy || leading > 0) {
    return { ...base, at: chairOf(0), pose: 'work', status: leading > 0 ? `☰ Leading ${leading}` : '✎ Working' }
  }

  const route = spots()
  const k = Math.floor(now / WANDER_MS)
  const here = route[k % route.length] ?? route[0]
  const before = route[(k + route.length - 1) % route.length] ?? route[0]

  if (here === undefined || before === undefined) return { ...base, at: chairOf(0), pose: 'idle', status: '☕ Resting' }

  const going = walk(before.at, here.at, k * WANDER_MS, now)

  return { ...base, at: going.at, pose: going.arrived ? 'idle' : 'walk', status: here.says }
}

// ── drawing on a grid of cells ──

function floorOf(cols: number, rows: number): Cell[][] {
  return Array.from({ length: rows }, (_, y) =>
    Array.from({ length: cols }, (_, x) => ({ ch: x % 4 === 1 && y % 2 === 0 ? '·' : ' ', fg: FLOOR_DOT, bg: FLOOR, bold: false })),
  )
}

function paint(grid: Cell[][], at: Point, text: string, fg: string, bg?: string, bold = false) {
  ;[...text].forEach((ch, i) => {
    const cell = grid[at.y]?.[at.x + i]

    if (cell === undefined) return
    cell.ch = ch
    cell.fg = fg
    cell.bg = bg ?? cell.bg
    cell.bold = bold
  })
}

// Centred under a robot, a column narrower than a desk so neighbours' labels never touch.
function label(grid: Cell[][], at: Point, text: string, fg: string, bold = false) {
  const words = fit(text, DESK_COLS - 1)
  paint(grid, { x: at.x + 1 - Math.floor(words.length / 2), y: at.y }, words, fg, undefined, bold)
}

const faceOf = (pose: Pose, b: number): string => {
  if (pose === 'work') return '•ᴗ•'
  if (pose === 'doze') return '–ᴗ–'
  if (pose === 'cheer') return '◕▿◕'
  if (pose === 'fizzle') return '×_×'

  return b % 23 === 22 ? '–ᴗ–' : '◕ᴗ◕'
}

// A chubby robot seen from above: the crown of its head, then its face; it bobs as it walks.
function robot(grid: Cell[][], f: Figure, b: number) {
  const body = hsl(f.hue, 0.7, 0.72)
  paint(grid, f.at, f.pose === 'walk' && b % 2 === 1 ? '▗▄▖' : '▄▄▄', body)
  paint(grid, { x: f.at.x, y: f.at.y + 1 }, faceOf(f.pose, b), FACE_INK, body)
  label(grid, { x: f.at.x, y: f.at.y + 2 }, f.status, f.statusColor)
  label(grid, { x: f.at.x, y: f.at.y + 3 }, f.name, BRIGHT, true)
}

function furnish(grid: Cell[][], cols: number, b: number, lit: Map<number, number>) {
  for (let seat = 0; seat < DESKS_ACROSS * DESKS_DOWN; seat += 1) {
    const o = deskOrigin(seat)
    const hue = lit.get(seat)
    // A lit monitor flickers in its worker's colour.
    paint(grid, { x: o.x + 2, y: o.y }, hue === undefined ? '▄▄▄▄▄' : b % 3 === 0 ? '▄▄▀▄▄' : '▄▄▄▄▄', hue === undefined ? MONITOR_OFF : hsl(hue, 0.8, 0.7))
    paint(grid, { x: o.x + 1, y: o.y + 1 }, '▐█████▌', DESK_TOP)
    paint(grid, { x: o.x + 3, y: o.y + 2 }, '▗▄▖', CHAIR)
  }

  // Potted plants down the left wall.
  for (const y of [2, 9, 16]) {
    paint(grid, { x: 0, y }, '▟▙', hsl(135, 0.55, 0.5))
    paint(grid, { x: 0, y: y + 1 }, '▀▀', hsl(25, 0.6, 0.45))
  }

  // The break area: coffee machine, water cooler, snack tray.
  const x = breakLeft()
  if (x + 8 > cols) return
  paint(grid, { x: x + 2, y: 0 }, 'break', PLACARD)
  paint(grid, { x: x + 5, y: 2 }, '▄▄▄', '#71717a')
  paint(grid, { x: x + 5, y: 3 }, '█', '#71717a')
  paint(grid, { x: x + 6, y: 3 }, b % 8 < 4 ? '•' : '∘', '#f87171')
  paint(grid, { x: x + 7, y: 3 }, '█', '#71717a')
  paint(grid, { x: x + 5, y: 4 }, '▀▀▀', '#71717a')
  paint(grid, { x: x + 3, y: 5 }, 'coffee', PLACARD)
  paint(grid, { x: x + 6, y: 9 }, '▄', '#93c5fd')
  paint(grid, { x: x + 5, y: 10 }, '▐█▌', '#60a5fa')
  paint(grid, { x: x + 5, y: 11 }, '▐█▌', '#e5e7eb')
  paint(grid, { x: x + 4, y: 12 }, 'water', PLACARD)
  paint(grid, { x: x + 4, y: 16 }, '▄▄▄▄', '#fde68a')
  paint(grid, { x: x + 4, y: 17 }, '●◦●◦', '#92400e', '#fde68a')
  paint(grid, { x: x + 3, y: 18 }, 'snacks', PLACARD)
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
    if ((await $.store.get(SPEND_OPEN_KEY).catch(() => undefined)) === true) await update($, spendOpen, () => true)

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
    const isSpendOpen = await read($, spendOpen)
    const b = await read($, beat)
    const now = await $.clock.now()
    // Content width: the body less one column of left padding and one spare at the right edge.
    const W = Math.max(20, e.props.bodyColumns - 2)
    const { Box, Button, Text } = $.ui.resolve(e)

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
    // A heading with `toggle` ends in a ▸/▾ button that opens or folds its section.
    const heading = (
      title: string,
      hue: number,
      status: string,
      statusColor: string,
      key: string,
      glow = false,
      toggle?: { isOpen: boolean; hotkey: string; onPress: () => Promise<unknown> },
    ) => {
      const word = title.toUpperCase()
      const tail = status === '' ? '' : ` ${status}`
      const fill = Math.max(2, W - 2 - word.length - 1 - tail.length - (toggle === undefined ? 0 : 2))

      return (
        <Box key={key} flexDirection="column">
          {gap(`${key}-g`, 2)}
          <Box key={`${key}-row`} flexDirection="row">
            <Text wrap="truncate-end">
              <Text color={hsl(hue + drift, 0.85, 0.7)} bold>{'▍ '}</Text>
              {glow ? rainbow(word, hue, 90, true) : <Text color={HEAD} bold>{word}</Text>}
              <Text color={RULE}>{` ${'─'.repeat(fill)}`}</Text>
              <Text color={statusColor}>{tail}</Text>
            </Text>
            {toggle !== undefined && <Text> </Text>}
            {toggle !== undefined && <Button key={`${key}-toggle`} plain label={toggle.isOpen ? '▾' : '▸'} hotkey={toggle.hotkey} onPress={toggle.onPress} />}
          </Box>
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

    // ── office: the whiteboard, then the room drawn from above, then the roster ──
    const ROOM = W - 2
    const atWork = agentRows.filter(a => a.status === 'running').length
    const isStaffed = atWork > 0
    const sway = isStaffed || isWorking ? b * 9 : 0

    // A segmented bar; `pct` null draws a shimmer for work with no estimate yet.
    const gauge = (pct: number | null, cells: number, hue: (i: number) => number, key: string) =>
      Array.from({ length: cells }, (_, i) => {
        const isOn = pct === null ? Math.abs((b % (cells * 2)) - cells) === i : i < Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells)

        return <Text key={`${key}${i}`} color={isOn ? hsl(hue(i)) : TRACK}>{isOn ? '▰' : '▱'}</Text>
      })

    // The whiteboard: each run (and the loose agents) as a title line and a progress bar.
    const looseRows = agentRows.filter(a => a.runId === null)
    const groups = [
      ...flowRows.map(run => ({ key: run.runId, name: run.name, startedAt: run.startedAt, members: agentRows.filter(a => a.runId === run.runId) })),
      ...(looseRows.length > 0 ? [{ key: 'loose', name: 'agents', startedAt: Math.min(...looseRows.map(a => a.startedAt)), members: looseRows }] : []),
    ]
    const BOARD = W - 4
    const boardLines = groups.flatMap(g => {
      const done = g.members.filter(a => a.status === 'done').length
      const failed = g.members.filter(a => a.status === 'failed').length
      const running = g.members.length - done - failed
      const tail = `✓${done} ⟳${running} ✗${failed} ${clock(now - g.startedAt)}`

      return [
        <Box key={`bd-${g.key}`} flexDirection="row" justifyContent="space-between" width={BOARD}>
          <Text color={BRIGHT} bold wrap="truncate-end">{fit(g.name, Math.max(6, BOARD - tail.length - 1))}</Text>
          <Text>
            <Text color={GOOD}>✓{done}</Text>
            <Text color={hsl(215)}> ⟳{running}</Text>
            <Text color={failed > 0 ? BAD : MUTED}> ✗{failed}</Text>
            <Text color={MUTED}> {clock(now - g.startedAt)}</Text>
          </Text>
        </Box>,
        <Text key={`bb-${g.key}`}>{gauge(g.members.length === 0 ? 0 : ((done + failed) / g.members.length) * 100, BOARD, i => (i / BOARD) * 300 + sway, `bm-${g.key}`)}</Text>,
      ]
    })

    // The room: furniture first, then every robot (the main one last, on top), each with its labels.
    const { figures, hidden } = workers(now, ROOM)
    const boss = mainRobot(now, isWorking, atWork)
    const lit = new Map<number, number>()
    if (boss.pose === 'work') lit.set(0, boss.hue)
    for (const actor of cast.values()) {
      if (actor.row.endedAt === null && actor.goneAt === null && figures.some(f => f.key === actor.row.id && (f.pose === 'work' || f.pose === 'doze'))) {
        lit.set(actor.seat, actor.hue)
      }
    }
    const grid = floorOf(ROOM, ROOM_ROWS)
    furnish(grid, ROOM, b, lit)
    for (const fig of [...figures, boss]) robot(grid, fig, b)
    const roomRows = grid.map((cells, y) => {
      const runs: Cell[] = []
      for (const cell of cells) {
        const last = runs[runs.length - 1]
        if (last !== undefined && last.fg === cell.fg && last.bg === cell.bg && last.bold === cell.bold) last.ch += cell.ch
        else runs.push({ ...cell })
      }

      return (
        <Text key={`room${y}`}>
          {runs.map((run, i) => (
            <Text key={`room${y}-${i}`} color={run.fg} backgroundColor={run.bg} bold={run.bold}>
              {run.ch}
            </Text>
          ))}
        </Text>
      )
    })

    // The roster: every task in full, then an estimated bar (its time against finished peers'), model and tools.
    const meanOf = (members: readonly AgentRow[]): number | null => {
      const spans = members.filter(a => a.status === 'done' && a.endedAt !== null).map(a => (a.endedAt ?? 0) - a.startedAt)

      return spans.length === 0 ? null : spans.reduce((x, y) => x + y, 0) / spans.length
    }
    const ordered = [...agentRows].sort((x, y) => x.startedAt - y.startedAt)
    const roster = ordered.slice(0, ROSTER_AGENTS).map(a => {
      const hue = cast.get(a.id)?.hue ?? 250
      const isOver = a.status !== 'running'
      const elapsed = (a.endedAt ?? now) - a.startedAt
      const mean = meanOf(agentRows.filter(m => m.runId === a.runId))
      const pct = isOver ? 100 : mean === null ? null : Math.min(95, (elapsed / mean) * 100)
      const dot = a.status === 'done' ? '✓' : a.status === 'failed' ? '✗' : '●'
      const dotColor = a.status === 'done' ? GOOD : a.status === 'failed' ? BAD : hsl(hue, 0.7, 0.74)
      const stats = `${familyOf(a.model)} ${clock(elapsed)} · ${a.tools} tool${a.tools === 1 ? '' : 's'}${a.lastTool === null || isOver ? '' : ` · ${a.lastTool}`}`

      return (
        <Box key={`ro-${a.id}`} flexDirection="column" width={W} marginBottom={1}>
          <Text wrap="wrap">
            <Text color={dotColor}>{dot} </Text>
            <Text color={isOver ? MUTED : TEXT}>{a.label}</Text>
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {gauge(pct, 8, () => (a.status === 'failed' ? 0 : hue), `rb-${a.id}`)}
            <Text color={isOver ? MUTED : hsl(hue, 0.5, 0.8)}>{` ${stats}`}</Text>
          </Text>
        </Box>
      )
    })
    const office = (
      <Box key="office" flexDirection="column">
        {heading('office', 160, isStaffed ? `${atWork} at work` : 'quiet', isStaffed ? hsl(160 + sway) : MUTED, 'office-h')}
        <Box key="board" flexDirection="column" width={W} borderStyle="single" borderColor={TRACK} paddingX={1}>
          {boardLines.length > 0 ? boardLines : <Text color={MUTED}>☕ all quiet. nothing on the board</Text>}
        </Box>
        <Box key="room" flexDirection="column" width={W} borderStyle="round" borderColor={FLOOR_DOT} backgroundColor={FLOOR}>
          {roomRows}
        </Box>
        {hidden > 0 && <Text color={MUTED}>{` ▯ +${hidden} waiting in the hallway`}</Text>}
        {roster.length > 0 && gap('roster-g')}
        {roster}
        {ordered.length > ROSTER_AGENTS && <Text color={MUTED}>{`  +${ordered.length - ROSTER_AGENTS} more`}</Text>}
      </Box>
    )


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
              isSpendOpen
                ? new Date(`${spend.month}-01T12:00:00`).toLocaleString(undefined, { month: 'long' })
                : money(spend.usd + (m?.costUsd ?? 0)),
              isSpendOpen ? MUTED : BRIGHT,
              'spend-h',
              false,
              {
                isOpen: isSpendOpen,
                hotkey: 's',
                onPress: async () => {
                  await update($, spendOpen, open => !open)
                  await $.store.set(SPEND_OPEN_KEY, !isSpendOpen)
                },
              },
            )}
            {isSpendOpen && spendRows}
            {isSpendOpen && (m?.costUsd ?? 0) > 0 &&
              row(
                <Text color={MUTED}>this session</Text>,
                <Text color={MUTED}>{money(m?.costUsd ?? 0)}</Text>,
                'spend-live',
              )}
            {isSpendOpen && gap('spend-g')}
            {isSpendOpen &&
              row(
                <Text color={TEXT} bold>total</Text>,
                <Text color={BRIGHT} bold>{money(spend.usd + (m?.costUsd ?? 0))}</Text>,
                'spend-t',
              )}
            {isSpendOpen && <Text color={MUTED}>{spend.sessions + 1} sessions · API prices</Text>}
          </Box>
        )}

        {office}

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
