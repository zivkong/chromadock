import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, RenderChildren, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { AgentRow, FlowRow, FlowSummary, Git, Limit, Meter, MonthSpend } from '../types'
import { BREAK_SPOTS, drawOffice, heatOf, type Leg, type Place } from './pixel-office'

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
// Whether the usage section is open, kept the same way.
const usageOpen = atom({ plugin: 'aurora', key: 'usageOpen' } as const, false)
const USAGE_OPEN_KEY = 'usageOpen'
// Whether this terminal draws pictures, so the office is pixel art rather than text.
const officeArt = atom({ plugin: 'aurora', key: 'officeArt' } as const, false)

const PANE = 'aurora'
// The sidebar asks the dock for this many columns; a width the person drags wins.
const PANE_COLUMNS = 56

const TICK_MS = 110
// Idle: redraw roughly every 30 s so clocks and countdowns stay honest.
const IDLE_TICKS = Math.round(30_000 / TICK_MS)
// Agents are reconciled against $.agent.list() about every 2 s while any runs.
const POLL_TICKS = Math.round(2_000 / TICK_MS)
// A workflow with every agent settled and no spawn for this long is over.
const FLOW_SETTLE_MS = 20_000
// A workflow agent not heard from (no tool call or model step) for this long is taken as
// finished: its end was missed (a stopped run, a reload). Heard from again, it is back at work.
const STALE_MS = 30 * 60_000
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

// Token counts in a few characters: 940, 156k, 1.2M.
const tok = (n: number): string => (n < 1000 ? `${n}` : n < 999_500 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`)

// How hot a robot runs on tokens, by the size of its latest request: 0 cool, 1 from 100k, 2
// from 250k, 3 from 500k. The roster's count takes the tier's ink; the robot glows (see robot()).
const HEAT_INK = ['#8b8b94', '#fcd34d', '#fb923c', '#f472b6'] as const

const money = (usd: number): string =>
  `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ── agents & workflows in flight (module state, published to the session's state so a reload picks them up) ──

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

// A reload starts the module over but keeps the session's state: take back the agents and
// runs the last load published, so their tool calls and finishes are followed again. Their
// robots walk back in through the door, as any newcomer does.
async function restore($: EngineInterface) {
  let isTaken = false

  for (const row of await read($, agents)) {
    if (live.has(row.id)) continue
    live.set(row.id, { ...row })
    isTaken = true
  }
  for (const run of await read($, flows)) {
    if (runs.has(run.runId)) continue
    runs.set(run.runId, { ...run })
    isTaken = true
  }
  if (isTaken) await reconcile($)
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
      // Parked until a message or its task wakes it: a break, not the door. Waking is activity.
      if (row.status === 'running') {
        const isWaiting = info.status === 'idle' || info.status === 'waiting' || info.status === 'pending'
        if (row.isWaiting === true && !isWaiting) row.activeAt = now
        row.isWaiting = isWaiting
      }
    }

    // A loose subagent the engine no longer lists has finished, maybe while this module was
    // reloading; a workflow's agents are never listed, so only their own events settle them.
    const listedIds = new Set(listed.map(info => info.id))
    for (const row of [...live.values()]) if (row.runId === null && !listedIds.has(row.id)) settle(row, 'done', now)
  }

  for (const row of [...live.values()]) {
    const heardAt = row.activeAt ?? row.lastToolAt ?? row.startedAt
    if (row.runId !== null && row.status === 'running' && now - heardAt > STALE_MS) settle(row, 'done', heardAt)
  }

  for (const run of [...runs.values()]) {
    const members = [...live.values()].filter(a => a.runId === run.runId)
    const isIdle = members.length > 0 && members.every(a => a.status !== 'running') && now - run.lastSpawnAt > FLOW_SETTLE_MS

    if (isIdle) await closeRun($, run, now)
  }

  await publish($)
}

// A run is over: it goes to the "last workflow" line and its agents leave the board.
async function closeRun($: EngineInterface, run: FlowRow, now: number) {
  const members = [...live.values()].filter(a => a.runId === run.runId)
  const ended = members.length === 0 ? now : Math.max(...members.map(a => a.endedAt ?? now))
  const summary: FlowSummary = {
    name: run.name,
    done: members.filter(a => a.status === 'done').length,
    total: members.length,
    failed: members.filter(a => a.status === 'failed').length,
    ms: ended - run.startedAt,
    tokens: members.reduce((sum, a) => sum + (a.tokens ?? 0), 0),
  }
  await update($, lastFlow, () => summary)
  for (const a of members) live.delete(a.id)
  runs.delete(run.runId)
}

// What a background task's notification says: which task, which tool call started it, how it ended.
type TaskEnd = { taskId: string | null; toolUseId: string | null; status: string }

const tagOf = (body: string, tag: string): string | null => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body)?.[1]?.trim() ?? null

const taskEndsIn = (text: string): TaskEnd[] =>
  [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map(([, body = '']) => ({
    taskId: tagOf(body, 'task-id'),
    toolUseId: tagOf(body, 'tool-use-id'),
    status: tagOf(body, 'status') ?? 'completed',
  }))

// The engine's word that a background task ended. A workflow's run closes at once, its agents
// still marked running settled with it (a stopped run's never report back); a subagent settles.
async function endTasks($: EngineInterface, ends: readonly TaskEnd[]) {
  if (ends.length === 0) return
  const now = await $.clock.now()

  for (const end of ends) {
    const outcome = end.status === 'completed' ? 'done' : 'failed'
    const run = [...runs.values()].find(r => (end.taskId !== null && r.taskId === end.taskId) || (end.toolUseId !== null && r.toolUseId === end.toolUseId))

    if (run !== undefined) {
      for (const a of [...live.values()]) if (a.runId === run.runId) settle(a, outcome, now)
      await closeRun($, run, now)
    }
    const row = end.taskId === null ? undefined : live.get(end.taskId)
    if (row !== undefined) settle(row, outcome, now)
  }

  await publish($)
}

async function trackAgent($: EngineInterface, id: string, label: string, type: string, modelId: string, runId: string | null, toolUseId: string) {
  const now = await $.clock.now()
  live.set(id, { id, label, type, model: modelId, runId, startedAt: now, endedAt: null, status: 'running', tools: 0, lastTool: null, lastToolAt: null, activeAt: now })
  // A resumed agent comes back in as a new robot if its last one is done and on its way out;
  // one still in the office (on a break, say) just gets back to work.
  if (cast.get(id)?.legs.at(-1)?.to.kind === 'door') cast.delete(id)

  if (runId !== null && runId !== '') {
    const run = runs.get(runId) ?? { runId, name: runId.slice(0, 9), startedAt: now, lastSpawnAt: now }
    run.lastSpawnAt = now
    // Its agents share the Workflow call that started the run, which its notification names.
    if (toolUseId !== '') run.toolUseId = toolUseId
    runs.set(runId, run)
  }

  await publish($)
}

async function trackRun($: EngineInterface, runId: string, workflowName: unknown, taskId: unknown, toolUseId: string | undefined) {
  const name = typeof workflowName === 'string' ? workflowName : runId.slice(0, 9)
  const now = await $.clock.now()
  const run = runs.get(runId) ?? { runId, name, startedAt: now, lastSpawnAt: now }
  run.name = name
  if (typeof taskId === 'string') run.taskId = taskId
  if (toolUseId !== undefined && toolUseId !== '') run.toolUseId = toolUseId
  runs.set(runId, run)
  await publish($)
}

// A workflow agent taken for finished (see STALE_MS) that is heard from again was not: back to
// work, a new robot walking in if its last one has left or is leaving.
function revive(row: AgentRow) {
  if (row.status === 'running' || row.runId === null || !runs.has(row.runId)) return
  row.status = 'running'
  row.endedAt = null
  if (cast.get(row.id)?.legs.at(-1)?.to.kind === 'door') cast.delete(row.id)
}

// An agent's tokens as /workflows counts them: the size of its latest request (input, cache
// read and written, and output), so a workflow's are the sum of its agents'.
async function countTokens($: EngineInterface, agentId: string, usage: ModelUsage) {
  const row = live.get(agentId)

  if (row === undefined) return
  row.tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
  await publish($)
}

// Dismissed from the board (a run whose end never reached the mod): it closes as if it had ended.
async function dismissRun($: EngineInterface, runId: string) {
  const run = runs.get(runId)

  if (run === undefined) return
  const now = await $.clock.now()
  for (const a of [...live.values()]) if (a.runId === runId) settle(a, 'done', now)
  await closeRun($, run, now)
  await publish($)
}

// A model step counts as activity, so an agent thinking hard is not sent on a break.
async function touch($: EngineInterface, agentId: string) {
  const row = live.get(agentId)

  if (row === undefined) return
  row.activeAt = await $.clock.now()
  row.isWaiting = false
  revive(row)
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
  row.activeAt = row.lastToolAt
  revive(row)
  await publish($)
}

async function startTurn($: EngineInterface) {
  const now = await $.clock.now()
  await update($, turn, () => ({ startedAt: now, endedAt: null, tools: 0 }))
}

// ── robots ────────────────────────────────────────────────────────────────
// The sidebar's office, drawn from above: a wall of windows, a carpet of desks, plants
// down the left wall and a break area on its own carpet at the right. The main robot keeps
// the first desk: it works there while Claude does, and at rest wanders to the coffee, the
// water and the team. Each agent walks in along the aisles, takes a desk and lights its
// monitor, labelled with the tool it called last. Idle, it dozes, then gives up its desk for
// the break area; when its task goes on it walks back to a free desk. Done, it celebrates
// where it stands and walks out the door it came in by. Every glyph in the room is one cell
// wide, and every row is cut to the room's width, so nothing can wrap and shift the rows below.

type Pose = 'walk' | 'work' | 'doze' | 'idle' | 'cheer' | 'fizzle'
type Point = { x: number; y: number }
// A robot and its walks (see Leg). `enteredAt`: when it came through the door, which is its
// spawn, or the reload that brought it back. `seat` is the desk it holds, `spot` the break
// spot; `lastSeat` the desk it would like back after a break.
type Actor = {
  row: AgentRow
  n: number
  fromLeft: boolean
  hue: number
  enteredAt: number
  goneAt: number | null
  legs: Leg[]
  seat: number | null
  lastSeat: number | null
  spot: number | null
}
type Cell = { ch: string; fg: string; bg: string; bold: boolean }
type Figure = { key: string; at: Point; pose: Pose; hue: number; status: string; name: string; tone: 'work' | 'good' | 'bad' | 'quiet'; heat?: 0 | 1 | 2 | 3 }

const FACE_INK = '#18181b'
// The room: a wall, the office carpet with its faint grid, the break area's own carpet.
const WALL = '#0c1124'
const WINDOW = '#24324f'
const FLOOR = '#141a33'
const FLOOR_DOT = '#262f57'
const LOUNGE = '#191f3d'
const LOUNGE_EDGE = '#2c3666'
const DESK_TOP = '#b4b4bc'
const SCREEN_OFF = '#26262c'
const CHAIR = '#4b4b55'
const PLACARD = '#6b7280'
// Status pills: ink on a slightly raised ground, by tone.
const PILL = '#1f2a52'
const PILL_INK = { work: '#a5c8ff', good: '#86efac', bad: '#fca5a5', quiet: '#8b8b94' } as const

// A desk station: monitor, desktop, the robot's two rows (a chair when empty), its status
// and name, then an aisle. The 7-column desk sits centred in its station's width.
const DESK_COLS = 13
const DESK_ROWS = 6
const AISLE_ROWS = 2
const PITCH = DESK_ROWS + AISLE_ROWS
const INSET = Math.floor((DESK_COLS - 7) / 2)
const DESKS_DOWN = 3
const MAX_ACROSS = 4
// The wall row on top, the plants' strip at the left, the break area right of the desks.
const TOP = 1
const WALL_COLS = 4
const BREAK_COLS = 9
const ROOM_ROWS = TOP + DESKS_DOWN * PITCH
const WALK_COLS_PER_S = 8
// How long a finished robot celebrates at its desk before it walks out.
const CHEER_MS = 1400
// A robot with no tool call or model step for this long nods off at its desk, and for this
// long gives the desk up for a break (sooner when the engine says it waits).
const DOZE_MS = 30_000
const BREAK_MS = 60_000
// At rest the main robot moves on to its next spot this often.
const WANDER_MS = 9000
// Agents listed on the roster before the rest fold into "+n more".
const ROSTER_AGENTS = 12
// One glyph per tool for the status pills; anything else gets a dot.
const TOOL_GLYPH: Record<string, string> = {
  Bash: '$', Read: '▤', Grep: '⌕', Glob: '⌕', Edit: '✎', Write: '✎', NotebookEdit: '✎',
  WebFetch: '⇣', WebSearch: '⌕', Agent: '◆', Skill: '✧', ToolSearch: '⌕',
}

// Module state like `live`: a reload clears the office.
const cast = new Map<string, Actor>()

const hashOf = (id: string): number => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)

// Follows the published agents: a newcomer gets the lowest free number, for its colour, and
// one that leaves `live` without an outcome is marked gone (it counts as done).
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

    const taken = new Set([...cast.values()].map(a => a.n))
    let n = 1
    while (taken.has(n)) n += 1
    cast.set(row.id, { row, n, fromLeft: hashOf(row.id) % 2 === 0, hue: (n * 47 + 160) % 360, enteredAt: now, goneAt: null, legs: [], seat: null, lastSeat: null, spot: null })
  }

  for (const actor of cast.values()) {
    if (seen.has(actor.row.id)) continue
    if (actor.row.endedAt === null && actor.goneAt === null) actor.goneAt = now
  }
  direct(now)
}

// When a robot last did something: a tool call or a model step, or its arrival if later.
const activeAt = (actor: Actor): number => Math.max(actor.row.activeAt ?? actor.row.lastToolAt ?? actor.row.startedAt, actor.enteredAt)

const isIdle = (actor: Actor, now: number): boolean => actor.row.isWaiting === true || now - activeAt(actor) > BREAK_MS

// Sends each robot where its agent's state says: through the door to a desk, off to a free
// break spot when idle (dozing on at its desk when none is free), back to a free desk (its
// own if it still is) when its task goes on, and out the door once done.
function direct(now: number) {
  const actors = [...cast.values()]
  const lowestFree = (held: (a: Actor) => number | null, from: number): number => {
    const taken = new Set(actors.map(held))
    let k = from
    while (taken.has(k)) k += 1

    return k
  }

  for (const actor of actors) {
    const target = actor.legs[actor.legs.length - 1]?.to

    if (target?.kind === 'door') continue
    const ended = actor.row.endedAt ?? actor.goneAt

    if (ended !== null) {
      actor.legs.push({ to: { kind: 'door' }, at: ended })
      actor.seat = null
      actor.spot = null
      continue
    }

    const at = target === undefined ? actor.enteredAt : now
    const idle = isIdle(actor, now)

    if (idle && target?.kind !== 'spot') {
      const spot = lowestFree(a => a.spot, 0)

      if (spot < BREAK_SPOTS) {
        actor.legs.push({ to: { kind: 'spot', spot }, at })
        actor.seat = null
        actor.spot = spot
        continue
      }
    }
    if (target === undefined || (!idle && target.kind === 'spot')) {
      const own = actor.lastSeat
      const seat = own !== null && !actors.some(a => a.seat === own) ? own : lowestFree(a => a.seat, 1)
      actor.legs.push({ to: { kind: 'desk', seat }, at })
      actor.seat = seat
      actor.lastSeat = seat
      actor.spot = null
    }
  }
}

// ── the floor plan: as many desks across as the room's width holds beside the break area ──

type Plan = { across: number; breakX: number }

const planFor = (cols: number): Plan => {
  const across = Math.max(1, Math.min(MAX_ACROSS, Math.floor((cols - WALL_COLS - BREAK_COLS) / DESK_COLS)))

  return { across, breakX: WALL_COLS + across * DESK_COLS }
}

const deskOrigin = (seat: number, plan: Plan): Point => ({
  x: WALL_COLS + (seat % plan.across) * DESK_COLS,
  y: TOP + Math.floor(seat / plan.across) * PITCH,
})

// Where a robot sits: on the chair, below its desk.
const chairOf = (seat: number, plan: Plan): Point => {
  const o = deskOrigin(seat, plan)

  return { x: o.x + INSET + 2, y: o.y + 2 }
}

// Each break-area fixture stands in its own band, level with a row of desks.
const bandTop = (k: number): number => TOP + k * PITCH

// The aisle under a row of desks, where robots walk.
const aisleNear = (y: number): number => {
  const k = Math.max(0, Math.min(DESKS_DOWN - 1, Math.round((y - TOP - DESK_ROWS) / PITCH)))

  return TOP + k * PITCH + DESK_ROWS
}

const spots = (plan: Plan): { at: Point; says: string }[] => [
  { at: { x: deskOrigin(0, plan).x + DESK_COLS - 2, y: chairOf(0, plan).y }, says: '◌ Chatting' },
  { at: { x: plan.breakX + 1, y: bandTop(0) + 4 }, says: '◦ Coffee' },
  { at: { x: plan.breakX + 1, y: bandTop(1) + 4 }, says: '◍ Water' },
  { at: { x: plan.breakX + 1, y: bandTop(2) + 4 }, says: '● Snacks' },
  { at: chairOf(0, plan), says: '▤ Reading' },
]

// The break area's spots, BREAK_SPOTS of them: beside each fixture first, one to a band,
// then below each, clear of the main robot's own stops.
const breakSpot = (k: number, plan: Plan): Point =>
  k < DESKS_DOWN ? { x: plan.breakX + 1, y: bandTop(k) + 1 } : { x: plan.breakX + 5, y: bandTop(k % DESKS_DOWN) + 4 }

// The clear column right of a desk, where robots cross between aisles.
const laneNear = (x: number, plan: Plan): number => {
  const k = Math.max(0, Math.min(plan.across - 1, Math.floor((x - WALL_COLS) / DESK_COLS)))

  return WALL_COLS + k * DESK_COLS + INSET + 7
}

// Out to the nearest aisle, along it to a clear lane (the lounge is one), down or up the
// lane to the far aisle, along that, then in: robots never walk through a desk.
const route = (from: Point, to: Point, plan: Plan): Point[] => {
  if (from.y === to.y && Math.abs(from.x - to.x) <= 3) return [from, to]
  const near = aisleNear(from.y)
  const far = aisleNear(to.y)

  if (near === far) return [from, { x: from.x, y: near }, { x: to.x, y: near }, to]
  const lane = from.x >= plan.breakX || to.x >= plan.breakX ? plan.breakX + 1 : laneNear(from.x, plan)

  return [from, { x: from.x, y: near }, { x: lane, y: near }, { x: lane, y: far }, { x: to.x, y: far }, to]
}

const pathMs = (path: readonly Point[]): number =>
  (path.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - (path[i]?.x ?? p.x)) + Math.abs(p.y - (path[i]?.y ?? p.y)), 0) / WALK_COLS_PER_S) * 1000

// Where along `path` a robot that set off at `startedAt` stands now; `arrived` once at its end.
function walk(path: readonly Point[], startedAt: number, now: number): { at: Point; arrived: boolean } {
  let steps = (Math.max(0, now - startedAt) / 1000) * WALK_COLS_PER_S

  for (let i = 1; i < path.length; i += 1) {
    const from = path[i - 1]
    const to = path[i]

    if (from === undefined || to === undefined) break
    const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y)

    if (steps < length) {
      const dx = Math.sign(to.x - from.x)
      const dy = Math.sign(to.y - from.y)

      return { at: { x: Math.round(from.x + dx * steps), y: Math.round(from.y + dy * steps) }, arrived: false }
    }
    steps -= length
  }

  return { at: path[path.length - 1] ?? { x: 0, y: 0 }, arrived: true }
}

// Where a robot stands now, following its walks; null once it has walked out the door.
type Stand = { at: Point; walking: boolean; cheering: boolean; place: Place | null }

function standOf(actor: Actor, now: number, cols: number, plan: Plan): Stand | null {
  const desks = plan.across * DESKS_DOWN
  const door = (near: Point): Point => ({ x: actor.fromLeft ? -3 : cols, y: aisleNear(near.y) })
  // A desk past the room's last is behind the door, as far as anyone can see.
  const pointOf = (place: Place, from: Point | null): Point => {
    if (place.kind === 'desk' && place.seat < desks) return chairOf(place.seat, plan)
    if (place.kind === 'spot') return breakSpot(place.spot, plan)

    return door(from ?? { x: 0, y: TOP })
  }
  let at: Point | null = null
  let place: Place | null = null
  let free = -Infinity

  for (const leg of actor.legs) {
    const start = Math.max(leg.at, free)

    if (now < start) break
    const cheer = leg.to.kind === 'door' ? CHEER_MS : 0

    if (at !== null && now < start + cheer) return { at, walking: false, cheering: true, place }
    const to = pointOf(leg.to, at)
    const path = route(at ?? door(to), to, plan)
    const going = walk(path, start + cheer, now)

    if (!going.arrived) return { at: going.at, walking: true, cheering: false, place: null }
    at = to
    place = leg.to
    free = start + cheer + pathMs(path)
  }

  return at === null || place?.kind === 'door' ? null : { at, walking: false, cheering: false, place }
}

// Every agent's robot where it stands now; robots that have walked out are dropped.
function workers(now: number, cols: number): { figures: Figure[]; hidden: number } {
  const plan = planFor(cols)
  const desks = plan.across * DESKS_DOWN
  const figures: Figure[] = []
  let hidden = 0

  for (const actor of cast.values()) {
    const { row, hue } = actor
    const base = { key: row.id, hue, name: row.label, heat: heatOf(row.tokens ?? 0) }
    const isFailed = row.status === 'failed'
    const isLeaving = actor.legs[actor.legs.length - 1]?.to.kind === 'door'
    const stand = standOf(actor, now, cols, plan)

    if (stand === null) {
      if (isLeaving) cast.delete(row.id)
      continue
    }
    if (actor.seat !== null && actor.seat >= desks) {
      hidden += 1
      continue
    }

    if (stand.cheering) {
      figures.push({ ...base, at: stand.at, pose: isFailed ? 'fizzle' : 'cheer', status: isFailed ? '✗ Crashed' : '✓ Done!', tone: isFailed ? 'bad' : 'good' })
      continue
    }
    if (stand.walking) {
      figures.push({ ...base, at: stand.at, pose: 'walk', status: '', tone: isLeaving ? (isFailed ? 'bad' : 'good') : 'work' })
      continue
    }
    if (stand.place?.kind === 'desk') {
      const isDozing = now - activeAt(actor) > DOZE_MS
      const tool = row.lastTool === null ? '… Starting' : `${TOOL_GLYPH[row.lastTool] ?? '•'} ${row.lastTool}`
      figures.push({ ...base, at: stand.at, pose: isDozing ? 'doze' : 'work', status: isDozing ? 'z Dozing' : tool, tone: isDozing ? 'quiet' : 'work' })
      continue
    }
    // On a break, waiting for its task to call it back.
    figures.push({ ...base, at: stand.at, pose: 'idle', status: '◦ On break', tone: 'quiet' })
  }

  return { figures, hidden }
}

// The main robot: at its desk while Claude works or leads agents, wandering at rest.
function mainRobot(now: number, cols: number, isBusy: boolean, leading: number, tokens: number): Figure {
  const plan = planFor(cols)
  const base = { key: 'main', hue: 330, name: 'Claude', tone: 'work' as const, heat: heatOf(tokens) }

  if (isBusy || leading > 0) {
    return { ...base, at: chairOf(0, plan), pose: 'work', status: leading > 0 ? `☰ Leading ${leading}` : '✎ Working' }
  }

  const stops = spots(plan)
  const k = Math.floor(now / WANDER_MS)
  const here = stops[k % stops.length]
  const before = stops[(k + stops.length - 1) % stops.length]

  if (here === undefined || before === undefined) return { ...base, at: chairOf(0, plan), pose: 'idle', status: '◦ Resting' }

  const going = walk(route(before.at, here.at, plan), k * WANDER_MS, now)

  return { ...base, at: going.at, pose: going.arrived ? 'idle' : 'walk', status: going.arrived ? here.says : '', tone: 'quiet' }
}

// ── drawing on a grid of cells ──

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

// The wall with its windows, the office carpet with a faint grid, the lounge carpet.
function floorOf(cols: number, plan: Plan): Cell[][] {
  const grid = Array.from({ length: ROOM_ROWS }, (_, y) =>
    Array.from({ length: cols }, (_, x) => {
      if (y < TOP) return { ch: ' ', fg: WINDOW, bg: WALL, bold: false }
      const isLounge = x >= plan.breakX

      return { ch: !isLounge && x % 4 === 2 && y % 2 === 0 ? '·' : ' ', fg: FLOOR_DOT, bg: isLounge ? LOUNGE : FLOOR, bold: false }
    }),
  )

  for (let x = 2; x + 5 < plan.breakX; x += 9) paint(grid, { x, y: 0 }, '▁▁▁▁▁', WINDOW)
  for (let y = TOP; y < ROOM_ROWS; y += 1) paint(grid, { x: plan.breakX, y }, '┊', LOUNGE_EDGE)

  return grid
}

// A label centred under a robot, a column narrower than a desk so neighbours' never touch;
// in the lounge, where the room ends close by, it starts at the robot and runs to the wall.
// A pill is padded with a space each side when that still fits.
function caption(grid: Cell[][], at: Point, text: string, fg: string, bg?: string, bold = false, isPill = false) {
  const row = grid[at.y]
  const inLounge = row !== undefined && row[at.x]?.bg === LOUNGE
  const room = inLounge ? Math.max(1, (row?.length ?? 0) - at.x) : DESK_COLS - 1
  const words = fit(isPill && [...text].length + 2 <= room ? ` ${text} ` : text, room)
  paint(grid, { x: inLounge ? at.x : at.x + 1 - Math.floor([...words].length / 2), y: at.y }, words, fg, bg, bold)
}


const faceOf = (pose: Pose, b: number): string => {
  if (pose === 'work') return b % 9 === 0 ? '•‿•' : '•ᴗ•'
  if (pose === 'doze') return '–ᴗ–'
  if (pose === 'cheer') return '◕▿◕'
  if (pose === 'fizzle') return '×_×'

  return b % 23 === 22 ? '–ᴗ–' : '◕ᴗ◕'
}

// A chubby robot seen from above: the crown of its head, then its face; it bobs as it walks.
// Seated or standing it wears its status as a pill and its name beneath; walking it wears neither.
function robot(grid: Cell[][], f: Figure, b: number) {
  const body = hsl(f.hue, 0.7, 0.72)
  const heat = f.heat ?? 0

  // Running hot on tokens: the floor around it takes its colour, deeper by tier, pulsing at the
  // top tier with a twinkle over its head.
  if (heat > 0) {
    const light = heat === 1 ? 0.2 : heat === 2 ? 0.27 : b % 4 < 2 ? 0.3 : 0.38
    for (const y of [f.at.y, f.at.y + 1]) {
      for (let x = f.at.x - 1; x <= f.at.x + 3; x += 1) {
        const cell = grid[y]?.[x]
        if (cell !== undefined) cell.bg = hsl(f.hue, 0.6, light)
      }
    }
    if (heat === 3) paint(grid, { x: f.at.x + 1 + (b % 3) - 1, y: f.at.y - 1 }, b % 2 === 0 ? '✦' : '✧', hsl(f.hue + b * 40, 0.9, 0.8))
  }
  paint(grid, f.at, f.pose === 'walk' && b % 2 === 1 ? '▗▄▖' : '▄▄▄', body)
  paint(grid, { x: f.at.x, y: f.at.y + 1 }, faceOf(f.pose, b), FACE_INK, body)

  if (f.pose === 'doze') paint(grid, { x: f.at.x + 3, y: f.at.y - (b % 6 < 3 ? 0 : 1) }, b % 2 === 0 ? 'z' : 'ᶻ', PILL_INK.quiet)
  if (f.pose === 'cheer') paint(grid, { x: f.at.x - 1, y: f.at.y }, b % 2 === 0 ? '✦' : '✧', hsl(f.hue + b * 40, 0.9, 0.8))
  if (f.pose === 'walk' || f.status === '') return

  // A finished robot on its break wears just its mark, beside its head.
  if (f.pose === 'idle' && f.key !== 'main') {
    paint(grid, { x: f.at.x + 3, y: f.at.y + 1 }, f.status.slice(0, 1), PILL_INK[f.tone], undefined, true)

    return
  }
  caption(grid, { x: f.at.x, y: f.at.y + 2 }, f.status, PILL_INK[f.tone], PILL, false, true)
  caption(grid, { x: f.at.x, y: f.at.y + 3 }, f.name, f.key === 'main' ? hsl(330, 0.7, 0.8) : BRIGHT, undefined, true)
}

// A monitor scrolls code while its worker types, and sits dark otherwise.
const SCREEN_LINES = ['▁▃▂▅▁', '▃▁▅▂▃', '▂▅▁▃▂', '▅▂▃▁▅']

function furnish(grid: Cell[][], cols: number, b: number, lit: Map<number, number>) {
  const plan = planFor(cols)

  for (let seat = 0; seat < plan.across * DESKS_DOWN; seat += 1) {
    const o = deskOrigin(seat, plan)
    const hue = lit.get(seat)
    const screen = hue === undefined ? '     ' : (SCREEN_LINES[(b + seat) % SCREEN_LINES.length] ?? '     ')
    paint(grid, { x: o.x + INSET + 1, y: o.y }, screen, hue === undefined ? SCREEN_OFF : hsl(hue, 0.8, 0.78), hue === undefined ? SCREEN_OFF : hsl(hue, 0.45, 0.24))
    paint(grid, { x: o.x + INSET, y: o.y + 1 }, '▐█████▌', DESK_TOP)
    paint(grid, { x: o.x + INSET + 2, y: o.y + 2 }, '▗▄▖', CHAIR)
  }

  // Potted plants down the left wall, swaying a little.
  for (let k = 0; k < DESKS_DOWN; k += 1) {
    paint(grid, { x: 1, y: bandTop(k) + 1 }, (b + k * 5) % 16 < 8 ? '▟▙' : '▙▟', hsl(135, 0.55, 0.5))
    paint(grid, { x: 1, y: bandTop(k) + 2 }, '▀▀', hsl(25, 0.6, 0.45))
  }

  // The break area: coffee with its steam, the water cooler's rising bubble, the snack tray.
  const x = plan.breakX
  if (x + BREAK_COLS > cols) return
  const [coffee, water, snacks] = [bandTop(0), bandTop(1), bandTop(2)]
  paint(grid, { x: x + 3, y: 0 }, 'break', PLACARD, WALL)
  paint(grid, { x: x + 4 + (b % 4 < 2 ? 0 : 1), y: coffee }, b % 2 === 0 ? '∿' : '~', '#9ca3af')
  paint(grid, { x: x + 4, y: coffee + 1 }, '▄▄▄', '#71717a')
  paint(grid, { x: x + 4, y: coffee + 2 }, '█', '#71717a')
  paint(grid, { x: x + 5, y: coffee + 2 }, b % 8 < 4 ? '•' : '∘', '#f87171', '#3f3f46')
  paint(grid, { x: x + 6, y: coffee + 2 }, '█', '#71717a')
  paint(grid, { x: x + 4, y: coffee + 3 }, '▀▀▀', '#71717a')
  paint(grid, { x: x + 4, y: water + 1 }, ' ▄ ', '#93c5fd')
  paint(grid, { x: x + 4, y: water + 2 }, b % 6 < 3 ? '▐°▌' : '▐█▌', '#e0f2fe', '#3b82f6')
  paint(grid, { x: x + 4, y: water + 3 }, '▐█▌', '#e5e7eb')
  paint(grid, { x: x + 4, y: snacks + 1 }, '▄▄▄▄', '#fde68a')
  paint(grid, { x: x + 4, y: snacks + 2 }, '●◦●◦', '#92400e', '#fde68a')
}

// Ghostty, kitty, iTerm2 and WezTerm draw pictures in the terminal; tmux passes none through.
async function drawsPictures($: EngineInterface): Promise<boolean> {
  const tmux = (await $.env.get('TMUX').catch(() => undefined)) ?? ''
  const program = ((await $.env.get('TERM_PROGRAM').catch(() => undefined)) ?? '').toLowerCase()
  const term = ((await $.env.get('TERM').catch(() => undefined)) ?? '').toLowerCase()
  const kitty = (await $.env.get('KITTY_WINDOW_ID').catch(() => undefined)) ?? ''

  if (tmux !== '') return false

  return ['ghostty', 'iterm.app', 'wezterm'].includes(program) || term.includes('kitty') || term.includes('ghostty') || kitty !== ''
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
    if ((await $.store.get(USAGE_OPEN_KEY).catch(() => undefined)) === true) await update($, usageOpen, () => true)
    if (await drawsPictures($)) await update($, officeArt, () => true)
    await restore($).catch(() => undefined)

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
    if (e.origin.kind === 'task-notification' || e.text.includes('<task-notification>')) await endTasks($, taskEndsIn(e.text)).catch(() => undefined)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const level = e.effort === undefined ? null : String(e.effort)

      if ((await read($, effort)) !== level) await update($, effort, () => level)
      if ((await read($, model)) !== e.model) await update($, model, () => e.model)
    } else {
      await touch($, e.agentId).catch(() => undefined)
    }

    const done = yield* next(e)
    if (e.agentId !== undefined && done.usage !== null) await countTokens($, e.agentId, done.usage).catch(() => undefined)

    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)

    // Bookkeeping only: it never fails the spawn itself.
    if ('agentId' in started && typeof started.agentId === 'string') {
      const runId = e.workflow?.runId ?? null
      await trackAgent($, started.agentId, e.description, e.subagentType, started.model, runId, e.tool_use_id).catch(() => undefined)
    }

    return started
  })

  on('tool.call', async ($, e, next) => {
    await countTool($, e.agentId, e.tool).catch(() => undefined)
    const done = await next(e)

    if (e.tool === 'Workflow') {
      const result: unknown = done.result

      if (isRecord(result) && typeof result.runId === 'string') {
        await trackRun($, result.runId, result.workflowName, result.taskId, e.tool_use_id).catch(() => undefined)
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
    const isUsageOpen = await read($, usageOpen)
    const isArt = (await read($, officeArt)) && e.surface === 'terminal'
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
      // A plain toggle draws as `u: ▸`, after a space: the rule gives way so the status is never cut.
      const control = toggle === undefined ? 0 : toggle.hotkey.length + 4
      const fill = Math.max(2, W - 2 - word.length - 1 - tail.length - control)

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

    // Folded, the usage heading carries each window's share in one line, coloured by the fullest.
    const fiveHour = findLimit(limits, k => k === 'five_hour')
    const week = findLimit(limits, k => k === 'seven_day')
    const fable = findLimit(limits, k => k.includes('fable'))
    const share = (limit: Limit | undefined) => (m === null ? '…' : limit === undefined ? '∞' : `${Math.round(limit.percentUsed)}%`)
    const usageBrief = `5h ${share(fiveHour)} · wk ${share(week)} · f ${share(fable)}`
    const usagePeak = Math.max(0, ...[fiveHour, week, fable].map(l => l?.percentUsed ?? 0))

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
      const tokens = g.members.reduce((sum, a) => sum + (a.tokens ?? 0), 0)
      const isRun = g.key !== 'loose'
      // A run's line ends in a × that dismisses it, for one whose end never reached the mod.
      const tail = `✓${done} ⟳${running} ✗${failed} ${tok(tokens)} ${clock(now - g.startedAt)}${isRun ? ' ×' : ''}`

      return [
        <Box key={`bd-${g.key}`} flexDirection="row" justifyContent="space-between" width={BOARD}>
          <Text color={BRIGHT} bold wrap="truncate-end">{fit(g.name, Math.max(6, BOARD - tail.length - 1))}</Text>
          <Box flexDirection="row">
            <Text>
              <Text color={GOOD}>✓{done}</Text>
              <Text color={hsl(215)}> ⟳{running}</Text>
              <Text color={failed > 0 ? BAD : MUTED}> ✗{failed}</Text>
              <Text color={HEAT_INK[heatOf(tokens)]}> {tok(tokens)}</Text>
              <Text color={MUTED}> {clock(now - g.startedAt)}</Text>
            </Text>
            {isRun && <Text> </Text>}
            {isRun && <Button key={`bd-x-${g.key}`} plain label="×" onPress={() => dismissRun($, g.key)} />}
          </Box>
        </Box>,
        <Text key={`bb-${g.key}`}>{gauge(g.members.length === 0 ? 0 : ((done + failed) / g.members.length) * 100, BOARD, i => (i / BOARD) * 300 + sway, `bm-${g.key}`)}</Text>,
      ]
    })

    // The room: pixel art where the terminal draws pictures, else drawn in text cells. Idle
    // robots head for a break, and busy ones back to work, as the clock moves on.
    direct(now)
    const art = isArt
      ? drawOffice({
          cols: W,
          now,
          isWorking,
          leading: atWork,
          claudeTokens: m?.tokens ?? 0,
          crew: [...cast.values()].map(a => ({
            id: a.row.id,
            n: a.n,
            hue: a.hue,
            name: a.row.label,
            status: a.row.status,
            legs: a.legs,
            seat: a.seat,
            lastTool: a.row.lastTool,
            activeAt: activeAt(a),
            tokens: a.row.tokens ?? 0,
          })),
          hours: new Date(now).getHours(),
          minutes: new Date(now).getMinutes(),
        })
      : null
    for (const id of art?.gone ?? []) cast.delete(id)
    // Text-cell room: furniture first, then every robot (the main one last, on top), each with its labels.
    const { figures, hidden: textHidden } = art === null ? workers(now, ROOM) : { figures: [], hidden: 0 }
    const hidden = art?.hidden ?? textHidden
    const boss = mainRobot(now, ROOM, isWorking, atWork, m?.tokens ?? 0)
    const lit = new Map<number, number>()
    if (boss.pose === 'work') lit.set(0, boss.hue)
    for (const actor of cast.values()) {
      if (actor.seat !== null && figures.some(f => f.key === actor.row.id && (f.pose === 'work' || f.pose === 'doze'))) {
        lit.set(actor.seat, actor.hue)
      }
    }
    const grid = art === null ? floorOf(ROOM, planFor(ROOM)) : []
    if (art === null) {
      furnish(grid, ROOM, b, lit)
      for (const fig of [...figures, boss]) robot(grid, fig, b)
    }
    const roomRows = grid.map((cells, y) => {
      const runs: Cell[] = []
      for (const cell of cells) {
        const last = runs[runs.length - 1]
        if (last !== undefined && last.fg === cell.fg && last.bg === cell.bg && last.bold === cell.bold) last.ch += cell.ch
        else runs.push({ ...cell })
      }

      return (
        <Text key={`room${y}`} wrap="truncate-end">
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
    // Only those still at it: a finished agent leaves the roster at once (the board keeps its count).
    const ordered = agentRows.filter(a => a.status === 'running').sort((x, y) => x.startedAt - y.startedAt)
    const roster = ordered.slice(0, ROSTER_AGENTS).map(a => {
      const hue = cast.get(a.id)?.hue ?? 250
      const isOver = a.status !== 'running'
      const elapsed = (a.endedAt ?? now) - a.startedAt
      const mean = meanOf(agentRows.filter(m => m.runId === a.runId))
      const pct = isOver ? 100 : mean === null ? null : Math.min(95, (elapsed / mean) * 100)
      const dot = a.status === 'done' ? '✓' : a.status === 'failed' ? '✗' : '●'
      const dotColor = a.status === 'done' ? GOOD : a.status === 'failed' ? BAD : hsl(hue, 0.7, 0.74)
      // Model and time, tokens, tool count, then the last tool, cut to what is left of the line:
      // a long tool name (an MCP tool's) never pushes the rest off it, so nothing jumps.
      const heat = heatOf(a.tokens ?? 0)
      const lead = `${familyOf(a.model)} ${clock(elapsed)}`
      const tokens = (a.tokens ?? 0) > 0 ? ` · ${tok(a.tokens ?? 0)} tok` : ''
      const count = ` · ${a.tools} tool${a.tools === 1 ? '' : 's'}`
      const room = W - 2 - 8 - 1 - lead.length - tokens.length - count.length
      const last = a.lastTool === null || isOver || room < 5 ? '' : fit(` · ${a.lastTool}`, room)

      return (
        <Box key={`ro-${a.id}`} flexDirection="column" width={W} marginBottom={1}>
          <Text wrap="wrap">
            <Text color={dotColor}>{dot} </Text>
            <Text color={isOver ? MUTED : TEXT}>{a.label}</Text>
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {gauge(pct, 8, () => (a.status === 'failed' ? 0 : hue), `rb-${a.id}`)}
            <Text color={isOver ? MUTED : hsl(hue, 0.5, 0.8)}>{` ${lead}`}</Text>
            {tokens !== '' && <Text color={isOver ? MUTED : HEAT_INK[heat]} bold={heat === 3}>{tokens}</Text>}
            <Text color={isOver ? MUTED : hsl(hue, 0.5, 0.8)}>{`${count}${last}`}</Text>
          </Text>
        </Box>
      )
    })
    const office = (
      <Box key="office" flexDirection="column">
        {heading('office', 160, isStaffed ? `${atWork} at work` : 'quiet', isStaffed ? hsl(160 + sway) : MUTED, 'office-h')}
        <Box key="board" flexDirection="column" width={W} borderStyle="round" borderColor={"#9ca3af"} paddingX={1}>
          {boardLines.length > 0 ? boardLines : <Text color={MUTED}>all quiet · nothing on the board</Text>}
        </Box>
        {art !== null && e.surface === 'terminal' ? (
          <Box key="room-art" width={W}>
            {(() => {
              const { Image } = $.ui.resolve(e)

              return <Image key="office" source={{ rgba: art.rgba, width: art.width, height: art.height }} columns={W} rows={art.rows} alt="the office" />
            })()}
          </Box>
        ) : (
          <Box key="room" flexDirection="column" width={W} borderStyle="round" borderColor={FLOOR_DOT} backgroundColor={FLOOR}>
            {roomRows}
          </Box>
        )}
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

        {heading('usage', 40, isUsageOpen ? '' : usageBrief, isUsageOpen ? MUTED : hsl(heatHue(usagePeak)), 'usage', false, {
          isOpen: isUsageOpen,
          hotkey: 'u',
          onPress: async () => {
            await update($, usageOpen, open => !open)
            await $.store.set(USAGE_OPEN_KEY, !isUsageOpen)
          },
        })}
        {isUsageOpen && (
          <Box key="usage-body" flexDirection="column">
            {limitBlock('5h', 30, fiveHour, 'five')}
            {gap('u1')}
            {limitBlock('week', 140, week, 'week')}
            {gap('u2')}
            {limitBlock('fable', 300, fable, 'fable')}
          </Box>
        )}

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
