// The office as pixel art, for terminals that draw pictures (Ghostty, kitty, iTerm2, WezTerm).
//
// One frame is composed at "art" resolution (4 art pixels per terminal column), every
// sprite and fixture painted by hand from the little grids below, then scaled up 2× so the
// terminal shows crisp pixels. The scene: a night-time wall of windows over a city, a door,
// an aurora painting and a wall clock with the real time; a carpet of desks where robots sit
// behind laptops whose lids glow in their colour; and a lounge on warm planks with an
// espresso machine, a water cooler, a donut table and a sofa. Everything that moves is a pure
// function of the clock, so a frame can be drawn again at any moment and look the same.

export type Crew = {
  id: string
  seat: number
  hue: number
  name: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt: number | null
  goneAt: number | null
  leftAt: number | null
  lastTool: string | null
  lastToolAt: number | null
}

export type OfficeInput = {
  cols: number
  now: number
  isWorking: boolean
  leading: number
  crew: readonly Crew[]
  // The person's wall-clock time, for the clock on the wall.
  hours: number
  minutes: number
}

export type OfficeFrame = { rgba: string; width: number; height: number; rows: number; gone: string[]; hidden: number }

type RGB = readonly [number, number, number]
type Point = { x: number; y: number }

// ── sizes ─────────────────────────────────────────────────────────────────

const PX_PER_COL = 4
// A terminal cell is about this many times taller than wide (with a little extra line height).
const CELL_ASPECT = 2.1
const SCALE = 2
const ART_H = 184
const WALL_H = 34
const MARGIN_X = 14
const STATION_W = 48
const STATION_H = 46
const ROWS_OF_DESKS = 3
const FIRST_ROW_Y = 38
const LOUNGE_W = 54
const WALK_PX_PER_S = 30
const CHEER_MS = 1600
const LINGER_MS = 5000
const DOZE_MS = 30_000
const WANDER_MS = 9000

export const officeRows = (): number => Math.round(ART_H / (PX_PER_COL * CELL_ASPECT))

// ── colour ────────────────────────────────────────────────────────────────

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

const hslRgb = (hue: number, sat: number, light: number): RGB => {
  const h = ((hue % 360) + 360) % 360
  const a = sat * Math.min(light, 1 - light)
  const f = (n: number) => {
    const k = (n + h / 30) % 12

    return Math.round((light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255)
  }

  return [f(0), f(8), f(4)]
}

const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
]

const C = {
  ink: hex('#0b0e1c'),
  wall: hex('#262c52'),
  wallStripe: hex('#2b3259'),
  molding: hex('#3a4372'),
  baseboard: hex('#12152a'),
  carpet: hex('#19203f'),
  carpetAlt: hex('#1c2445'),
  carpetSpeck: hex('#222b52'),
  plank: hex('#5a3a28'),
  plankAlt: hex('#64412d'),
  plankSeam: hex('#3f281b'),
  shadow: hex('#05070f'),
  skyTop: hex('#070b1f'),
  skyLow: hex('#1a2a5c'),
  star: hex('#e8eeff'),
  moon: hex('#fff3c4'),
  city: hex('#0d1230'),
  cityLit: hex('#ffd36b'),
  frame: hex('#8b93b0'),
  frameDark: hex('#4b5273'),
  woodTop: hex('#d9b48a'),
  woodLight: hex('#c69a6c'),
  wood: hex('#9a6a43'),
  woodDark: hex('#6f4a2e'),
  woodGrain: hex('#875c39'),
  leg: hex('#3b2a1f'),
  chair: hex('#2b3049'),
  chairLight: hex('#3a4161'),
  lid: hex('#a9b1c6'),
  lidLight: hex('#cfd5e3'),
  lidDark: hex('#7c849b'),
  mug: hex('#f1f1f4'),
  coffee: hex('#6b3e22'),
  steam: hex('#c9d2e8'),
  leaf: hex('#3fa34d'),
  leafLight: hex('#69c36b'),
  leafDark: hex('#246b34'),
  pot: hex('#c2653a'),
  potDark: hex('#8f4426'),
  chrome: hex('#c7ccd8'),
  chromeDark: hex('#7d8396'),
  red: hex('#ff5a5a'),
  water: hex('#5fb2ff'),
  waterLight: hex('#a9d8ff'),
  white: hex('#f5f7ff'),
  sofa: hex('#2f8f8a'),
  sofaLight: hex('#45b0a9'),
  sofaDark: hex('#1f625e'),
  donut: hex('#f4a3c0'),
  donutDough: hex('#d8955a'),
  sprinkle: hex('#fff07a'),
  neon: hex('#ff6fb1'),
  text: hex('#eef1ff'),
  textDim: hex('#9aa3c7'),
  pillWork: hex('#2a4a8f'),
  pillGood: hex('#1f6b45'),
  pillBad: hex('#8f2a3a'),
  pillQuiet: hex('#3a3f5c'),
  visor: hex('#141832'),
  visorShine: hex('#2f3866'),
  claude: hex('#d97757'),
}

// ── the canvas ────────────────────────────────────────────────────────────

type Canvas = { w: number; h: number; px: Uint8Array }

const canvasOf = (w: number, h: number): Canvas => ({ w, h, px: new Uint8Array(w * h * 3) })

function set(c: Canvas, x: number, y: number, rgb: RGB) {
  const xi = Math.round(x)
  const yi = Math.round(y)

  if (xi < 0 || yi < 0 || xi >= c.w || yi >= c.h) return
  const i = (yi * c.w + xi) * 3
  c.px[i] = rgb[0]
  c.px[i + 1] = rgb[1]
  c.px[i + 2] = rgb[2]
}

function get(c: Canvas, x: number, y: number): RGB {
  const i = (Math.max(0, Math.min(c.h - 1, y)) * c.w + Math.max(0, Math.min(c.w - 1, x))) * 3

  return [c.px[i] ?? 0, c.px[i + 1] ?? 0, c.px[i + 2] ?? 0]
}

function blend(c: Canvas, x: number, y: number, rgb: RGB, alpha: number) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return
  set(c, x, y, mix(get(c, x, y), rgb, alpha))
}

function rect(c: Canvas, x: number, y: number, w: number, h: number, rgb: RGB) {
  for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) set(c, x + i, y + j, rgb)
}

function glow(c: Canvas, cx: number, cy: number, rx: number, ry: number, rgb: RGB, strength: number) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y += 1) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x += 1) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2

      if (d < 1) blend(c, x, y, rgb, strength * (1 - d))
    }
  }
}

// A soft oval shadow on the floor.
const shade = (c: Canvas, cx: number, cy: number, rx: number, ry: number) => glow(c, cx, cy, rx, ry, C.shadow, 0.55)

// Paints a sprite: each character of a row names a colour in `pal`; '.' is see-through.
function sprite(c: Canvas, x: number, y: number, rows: readonly string[], pal: Readonly<Record<string, RGB>>, flip = false) {
  rows.forEach((row, j) => {
    const w = row.length

    for (let i = 0; i < w; i += 1) {
      const ch = row[flip ? w - 1 - i : i] ?? '.'
      const rgb = pal[ch]

      if (ch !== '.' && rgb !== undefined) set(c, x + i, y + j, rgb)
    }
  })
}

// Deterministic noise in 0..1 for a cell, so textures hold still between frames.
const noise = (x: number, y: number, salt = 0): number => {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) >>> 0
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0

  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

// ── a 3×5 pixel font ──────────────────────────────────────────────────────

const GLYPHS: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111',
  '9': '111101111001110', '.': '000000000000010', ',': '000000000010100', ':': '000010000010000', '!': '010010010000010',
  '?': '110001010000010', "'": '010010000000000', '-': '000000111000000', '/': '001001010100100', '(': '010100100100010',
  ')': '010001001001010', '%': '101001010100101', '$': '011110010011110', '+': '000010111010000', '~': '000011110000000',
  '#': '101111101111101', '>': '100010001010100', '<': '001010100010001', '*': '000101010101000', '=': '000111000111000',
  '✓': '000001001101010', '✗': '000101010101000', '…': '000000000000101', ' ': '000000000000000',
}

const textWidth = (text: string): number => Math.max(0, [...text].length * 4 - 1)

function text(c: Canvas, x: number, y: number, words: string, rgb: RGB, outline?: RGB) {
  ;[...words.toUpperCase()].forEach((ch, k) => {
    const bits = GLYPHS[ch] ?? GLYPHS['?'] ?? ''

    for (let j = 0; j < 5; j += 1) {
      for (let i = 0; i < 3; i += 1) {
        if (bits[j * 3 + i] !== '1') continue
        if (outline !== undefined) set(c, x + k * 4 + i + 1, y + j + 1, outline)
        set(c, x + k * 4 + i, y + j, rgb)
      }
    }
  })
}

const clip = (words: string, max: number): string => {
  const chars = [...words]

  return chars.length <= max ? words : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

// A rounded pill with its words centred on `cx`.
// Labels stay whole inside the frame, sliding in from an edge if they must.
const within = (c: Canvas, cx: number, w: number): number => Math.max(1, Math.min(c.w - w - 1, Math.round(cx - w / 2)))

function pill(c: Canvas, cx: number, y: number, words: string, bg: RGB, fg: RGB, maxChars: number) {
  const shown = clip(words, maxChars)
  const w = textWidth(shown) + 4
  const x = within(c, cx, w)
  rect(c, x + 1, y, w - 2, 7, bg)
  rect(c, x, y + 1, w, 5, bg)
  text(c, x + 2, y + 1, shown, fg)
}

function label(c: Canvas, cx: number, y: number, words: string, rgb: RGB, maxChars: number) {
  const shown = clip(words, maxChars)
  text(c, within(c, cx, textWidth(shown)), y, shown, rgb, C.ink)
}

// ── robots ────────────────────────────────────────────────────────────────

// 14×15: a chubby head with a visor, a small body, two feet. o outline, h highlight, b body,
// s shade, v visor, w visor shine, e eyes, m mouth, a antenna tip, x accessory.
const ROBOT_HEAD = [
  '......aa......',
  '......oo......',
  '...oooooooo...',
  '..ohhbbbbbbo..',
  '.ohbbbbbbbbbso',
  '.obvvvvvvvvwso',
  '.obvveevveevso',
  '.obvveevveevso',
  '.obvvvmmmvvvso',
  '.obbbbbbbbbbso',
  '..osssssssso..',
]
const ROBOT_BODY = ['...obhbbbbbo..', '..obbbbbbbbbo.', '...osssssso...']
const FEET = { stand: '....oo..oo....', stepA: '...oo....oo...', stepB: '.....oooo.....' }

type Face = 'calm' | 'blink' | 'focus' | 'happy' | 'sleep' | 'dead'

// The eyes and mouth over the visor for each mood, as replacement rows 6..8.
function faceRows(face: Face): [string, string, string] {
  switch (face) {
    case 'blink':
      return ['.obvvvvvvvvvso', '.obveevvveevso', '.obvvvmmmvvvso']
    case 'focus':
      return ['.obvvvvvvvvvso', '.obvveevveevso', '.obvvvvmvvvvso']
    case 'happy':
      return ['.obvveevveevso', '.obvevvvvvevso', '.obvvmmmmmvvso']
    case 'sleep':
      return ['.obvvvvvvvvvso', '.obvmmvvvmmvso', '.obvvvvvvvvvso']
    case 'dead':
      return ['.obvevevevevso', '.obvvevvvevvso', '.obvvvmmmvvvso']
    default:
      return ['.obvveevveevso', '.obvveevveevso', '.obvvvmmmvvvso']
  }
}

type Look = { hue: number; isClaude: boolean; kit: number }

const robotPalette = (look: Look, face: Face, glowOn: boolean): Record<string, RGB> => {
  const base = look.isClaude ? C.claude : hslRgb(look.hue, 0.55, 0.62)
  const eye = face === 'dead' ? C.red : look.isClaude ? hex('#ffe7c7') : hslRgb(look.hue, 0.9, 0.86)

  return {
    o: mix(base, C.ink, 0.72),
    h: mix(base, C.white, 0.45),
    b: base,
    s: mix(base, C.ink, 0.32),
    v: C.visor,
    w: C.visorShine,
    e: face === 'sleep' ? mix(eye, C.visor, 0.5) : eye,
    m: mix(eye, C.visor, 0.35),
    a: glowOn ? (look.isClaude ? hex('#fff1a8') : hslRgb(look.hue + 40, 1, 0.75)) : mix(base, C.ink, 0.4),
    x: look.kit === 2 ? hex('#ff5577') : C.chairLight,
  }
}

// A worn extra by kit: headphones, a bow tie, a sprout, or nothing; Claude wears a little star.
function accessory(c: Canvas, x: number, y: number, look: Look, isSeated: boolean) {
  if (look.isClaude) {
    set(c, x + 6, y - 1, hex('#fff1a8'))
    set(c, x + 7, y - 1, hex('#fff1a8'))
    set(c, x + 5, y, hex('#ffd36b'))
    set(c, x + 8, y, hex('#ffd36b'))

    return
  }
  if (look.kit === 1) {
    const band = hex('#1d1f2e')
    for (let i = 3; i <= 10; i += 1) set(c, x + i, y + 2, band)
    rect(c, x, y + 5, 2, 4, band)
    rect(c, x + 12, y + 5, 2, 4, band)
    set(c, x + 1, y + 6, hslRgb(look.hue + 180, 0.8, 0.6))
    set(c, x + 12, y + 6, hslRgb(look.hue + 180, 0.8, 0.6))
  } else if (look.kit === 2 && !isSeated) {
    set(c, x + 5, y + 11, hex('#ff5577'))
    set(c, x + 6, y + 12, hex('#ff5577'))
    set(c, x + 8, y + 11, hex('#ff5577'))
    set(c, x + 7, y + 12, hex('#ff5577'))
  } else if (look.kit === 3) {
    set(c, x + 6, y - 1, C.leafLight)
    set(c, x + 8, y - 2, C.leaf)
    set(c, x + 7, y - 1, C.leafDark)
  }
}

function robot(c: Canvas, x: number, y: number, look: Look, face: Face, feet: keyof typeof FEET | null, antenna: boolean, bob = 0) {
  const pal = robotPalette(look, face, antenna)
  const [r6, r7, r8] = faceRows(face)
  const head = [...ROBOT_HEAD.slice(0, 6), r6, r7, r8, ...ROBOT_HEAD.slice(9)]

  if (feet !== null) shade(c, x + 7, y + 15, 7, 2)
  sprite(c, x, y + bob, head, pal)
  if (feet !== null) {
    sprite(c, x, y + 11 + bob, ROBOT_BODY, pal)
    sprite(c, x, y + 14, [FEET[feet]], pal)
  }
  accessory(c, x, y + bob, look, feet === null)
}

// ── the room ──────────────────────────────────────────────────────────────

type Plan = { w: number; across: number; deskX: number; loungeX: number }

const planFor = (cols: number): Plan => {
  const w = cols * PX_PER_COL
  const across = Math.max(1, Math.min(4, Math.floor((w - MARGIN_X - LOUNGE_W) / STATION_W)))

  return { w, across, deskX: MARGIN_X, loungeX: MARGIN_X + across * STATION_W + 4 }
}

const stationOf = (seat: number, plan: Plan): Point => ({
  x: plan.deskX + (seat % plan.across) * STATION_W,
  y: FIRST_ROW_Y + Math.floor(seat / plan.across) * STATION_H,
})

// Where a robot stands or sits at its desk (its sprite's top left): right behind the laptop.
const seatOf = (seat: number, plan: Plan): Point => {
  const o = stationOf(seat, plan)

  return { x: o.x + 17, y: o.y + 4 }
}

const DOOR: Point = { x: 1, y: WALL_H - 15 }

// The lounge's places, as sprite top-lefts.
const lounge = (plan: Plan) => {
  const x = plan.loungeX

  return {
    coffee: { x: x + 5, y: WALL_H - 9 },
    water: { x: x + 25, y: WALL_H - 7 },
    snacks: { x: x + 4, y: 98 },
    sofa: { x: x + 16, y: SOFA_Y - 5 },
    seats: [
      { x: x + 30, y: 98 },
      { x: x + 6, y: 136 },
      { x: x + 34, y: 136 },
      { x: x + 18, y: 116 },
      { x: x + 4, y: 120 },
      { x: x + 34, y: 120 },
    ],
  }
}

// Along a walkway, down a lane, along the next walkway: lanes are the left margin, the gaps
// between desks and the open lounge; walkways run behind each row of desks.
function route(from: Point, to: Point, plan: Plan): Point[] {
  if (from.y === to.y) return [from, to]
  const inLounge = (p: Point) => p.x >= plan.loungeX - 4
  let lane: number

  if (inLounge(from) || inLounge(to)) lane = plan.loungeX
  else {
    const k = Math.max(0, Math.min(plan.across - 1, Math.round((from.x - plan.deskX - 17) / STATION_W)))
    lane = k === 0 && from.x < plan.deskX + 24 ? 0 : plan.deskX + k * STATION_W + 41
  }

  return [from, { x: lane, y: from.y }, { x: lane, y: to.y }, to]
}

const pathMs = (path: readonly Point[]): number => {
  let d = 0
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]
    const b = path[i]
    if (a !== undefined && b !== undefined) d += Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
  }

  return (d / WALK_PX_PER_S) * 1000
}

function walk(path: readonly Point[], startedAt: number, now: number): { at: Point; arrived: boolean; facingLeft: boolean } {
  let steps = (Math.max(0, now - startedAt) / 1000) * WALK_PX_PER_S

  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]
    const b = path[i]

    if (a === undefined || b === undefined) break
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)

    if (steps < length) {
      const t = length === 0 ? 1 : steps / length

      return { at: { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) }, arrived: false, facingLeft: b.x < a.x }
    }
    steps -= length
  }

  return { at: path[path.length - 1] ?? { x: 0, y: 0 }, arrived: true, facingLeft: false }
}

// ── where everyone is ─────────────────────────────────────────────────────

type Tone = 'work' | 'good' | 'bad' | 'quiet'
type Actor = {
  key: string
  look: Look
  at: Point
  seat: number | null
  mode: 'seated' | 'standing' | 'walking'
  face: Face
  status: string
  tone: Tone
  name: string
  typing: boolean
  cheer: boolean
}

const TOOL_WORD: Record<string, string> = {
  Bash: '$ BASH', Read: 'READ', Grep: 'GREP', Glob: 'GLOB', Edit: 'EDIT', Write: 'WRITE', WebFetch: 'FETCH', WebSearch: 'SEARCH',
  Agent: 'AGENT', Skill: 'SKILL', ToolSearch: 'TOOLS', NotebookEdit: 'EDIT',
}

const shortName = (name: string): string => name.split(/\s+/).slice(0, 2).join(' ')

function cast(input: OfficeInput, plan: Plan): { actors: Actor[]; gone: string[]; hidden: number } {
  const { now } = input
  const desks = plan.across * ROWS_OF_DESKS
  const actors: Actor[] = []
  const gone: string[] = []
  let hidden = 0
  const blink = (k: number): Face => (Math.floor(now / 180 + k * 7) % 23 === 0 ? 'blink' : 'calm')

  for (const m of input.crew) {
    const look: Look = { hue: m.hue, isClaude: false, kit: (m.seat * 7 + m.hue) % 4 }
    const seat = seatOf(m.seat, plan)
    const endedAt = m.endedAt ?? m.goneAt
    const isFailed = m.status === 'failed'
    const base = { key: m.id, look, name: shortName(m.name), typing: false, cheer: false }

    if (m.seat >= desks) {
      if (endedAt === null) hidden += 1
      else if (m.leftAt !== null) gone.push(m.id)
      continue
    }

    if (endedAt === null) {
      // In through the door, down the left lane, along the walkway behind the desks.
      const going = walk([DOOR, { x: DOOR.x, y: seat.y }, seat], m.startedAt, now)

      if (!going.arrived) {
        actors.push({ ...base, at: going.at, seat: null, mode: 'walking', face: 'calm', status: '', tone: 'work' })
        continue
      }
      const isDozing = now - (m.lastToolAt ?? m.startedAt) > DOZE_MS
      const word = m.lastTool === null ? 'STARTING' : (TOOL_WORD[m.lastTool] ?? m.lastTool.toUpperCase())
      actors.push({
        ...base,
        at: seat,
        seat: m.seat,
        mode: 'seated',
        face: isDozing ? 'sleep' : 'focus',
        status: isDozing ? 'ZZZ' : word,
        tone: isDozing ? 'quiet' : 'work',
        typing: !isDozing,
      })
      continue
    }

    if (now - endedAt < CHEER_MS) {
      actors.push({ ...base, at: seat, seat: m.seat, mode: 'seated', face: isFailed ? 'dead' : 'happy', status: isFailed ? 'CRASHED' : 'DONE!', tone: isFailed ? 'bad' : 'good', cheer: !isFailed })
      continue
    }

    const spot = lounge(plan).seats[m.seat % 6] ?? lounge(plan).sofa
    const toBreak = route(seat, spot, plan)
    const going = walk(toBreak, endedAt + CHEER_MS, now)
    const leavesAt = m.leftAt === null ? null : Math.max(m.leftAt, endedAt + CHEER_MS + pathMs(toBreak) + LINGER_MS)

    if (leavesAt !== null && now >= leavesAt) {
      const out = walk(route(spot, DOOR, plan), leavesAt, now)

      if (out.arrived) gone.push(m.id)
      else actors.push({ ...base, at: out.at, seat: null, mode: 'walking', face: 'calm', status: '', tone: 'quiet' })
      continue
    }

    actors.push({
      ...base,
      at: going.at,
      seat: null,
      mode: going.arrived ? 'standing' : 'walking',
      face: going.arrived ? (isFailed ? 'dead' : blink(m.seat) === 'blink' ? 'blink' : 'happy') : 'calm',
      status: going.arrived ? (isFailed ? 'CRASHED' : 'ON BREAK') : '',
      tone: isFailed ? 'bad' : 'good',
    })
  }

  // Claude: at its desk while it works or leads, else wandering the office.
  const look: Look = { hue: 18, isClaude: true, kit: 0 }
  const claude = { key: 'claude', look, name: 'CLAUDE', typing: false, cheer: false }

  if (input.isWorking || input.leading > 0) {
    actors.push({ ...claude, at: seatOf(0, plan), seat: 0, mode: 'seated', face: 'focus', status: input.leading > 0 ? `LEADING ${input.leading}` : 'WORKING', tone: 'work', typing: true })
  } else {
    const places = lounge(plan)
    const window = { x: windowsOf(plan)[0]?.x ?? 40, y: WALL_H - 15 }
    const stops: { at: Point; says: string }[] = [
      { at: { x: places.coffee.x, y: places.coffee.y }, says: 'COFFEE' },
      { at: window, says: 'STARGAZING' },
      { at: places.water, says: 'WATER' },
      { at: seatOf(0, plan), says: 'READING' },
      { at: places.snacks, says: 'DONUT TIME' },
      { at: { x: places.sofa.x, y: places.sofa.y }, says: 'RESTING' },
    ]
    const k = Math.floor(now / WANDER_MS)
    const here = stops[k % stops.length]
    const before = stops[(k + stops.length - 1) % stops.length]

    if (here !== undefined && before !== undefined) {
      const going = walk(route(before.at, here.at, plan), k * WANDER_MS, now)
      const atDesk = going.arrived && here.says === 'READING'
      actors.push({
        ...claude,
        at: going.at,
        seat: atDesk ? 0 : null,
        mode: going.arrived ? (atDesk ? 'seated' : 'standing') : 'walking',
        face: going.arrived ? blink(0) : 'calm',
        status: going.arrived ? here.says : '',
        tone: 'quiet',
      })
    }
  }

  return { actors, gone, hidden }
}

// ── painting the scene ────────────────────────────────────────────────────

const windowsOf = (plan: Plan): Point[] => {
  const xs: Point[] = []
  for (let x = 26; x + 38 < plan.loungeX - 34; x += 70) xs.push({ x, y: 5 })

  return xs
}

function paintWall(c: Canvas, plan: Plan, now: number, input: OfficeInput) {
  rect(c, 0, 0, c.w, WALL_H, C.wall)
  for (let x = 0; x < c.w; x += 6) rect(c, x, 2, 1, WALL_H - 4, C.wallStripe)
  rect(c, 0, 0, c.w, 2, C.molding)
  rect(c, 0, WALL_H - 3, c.w, 3, C.baseboard)

  // The door robots come and go by, under its exit sign.
  rect(c, 2, 6, 16, WALL_H - 9, C.woodDark)
  rect(c, 3, 7, 14, WALL_H - 10, C.wood)
  rect(c, 5, 9, 10, 6, C.woodLight)
  set(c, 14, 20, C.woodTop)
  rect(c, 3, 2, 14, 3, hex('#1f7a4d'))
  text(c, 4, 2, 'EXIT', hex('#b9ffd8'))

  // Windows over the city at night: stars twinkle, a moon, lit windows come and go.
  windowsOf(plan).forEach((w, n) => {
    const ww = 34
    const wh = 22
    rect(c, w.x - 2, w.y - 2, ww + 4, wh + 4, C.frameDark)
    rect(c, w.x - 1, w.y - 1, ww + 2, wh + 2, C.frame)
    for (let y = 0; y < wh; y += 1) rect(c, w.x, w.y + y, ww, 1, mix(C.skyTop, C.skyLow, y / wh))
    for (let s = 0; s < 9; s += 1) {
      const sx = Math.floor(noise(s, n, 3) * ww)
      const sy = Math.floor(noise(s, n, 5) * (wh - 9))
      const lit = Math.sin(now / 700 + s * 1.7 + n) > -0.2
      if (lit) set(c, w.x + sx, w.y + sy, mix(C.skyLow, C.star, 0.6 + 0.4 * Math.sin(now / 400 + s)))
    }
    if (n === 0) {
      rect(c, w.x + 24, w.y + 3, 4, 4, C.moon)
      rect(c, w.x + 26, w.y + 3, 2, 2, mix(C.skyTop, C.skyLow, 0.2))
    }
    // The skyline: blocks of buildings with windows that flicker on and off.
    let bx = 0
    let b = 0
    while (bx < ww) {
      const bw = 4 + Math.floor(noise(b, n, 11) * 5)
      const bh = 6 + Math.floor(noise(b, n, 13) * 8)
      rect(c, w.x + bx, w.y + wh - bh, Math.min(bw, ww - bx), bh, C.city)
      for (let yy = wh - bh + 2; yy < wh - 1; yy += 2) {
        for (let xx = bx + 1; xx < Math.min(bx + bw - 1, ww); xx += 2) {
          if (noise(xx, yy, n * 31 + Math.floor(now / 3000 + noise(xx, yy, 7) * 5)) > 0.62) set(c, w.x + xx, w.y + yy, C.cityLit)
        }
      }
      bx += bw + 1
      b += 1
    }
    rect(c, w.x + ww / 2, w.y, 1, wh, C.frame)
  })

  // The team whiteboard between the windows and the painting: today's progress, live.
  const bx = (windowsOf(plan).at(-1)?.x ?? -40) + 46
  const bw = Math.max(0, plan.loungeX - 36 - bx)
  if (bw >= 30) {
    rect(c, bx - 1, 5, bw + 2, 22, C.frameDark)
    rect(c, bx, 6, bw, 19, C.white)
    rect(c, bx + 2, 26, bw - 4, 1, C.chromeDark)
    set(c, bx + 4, 25, C.red)
    set(c, bx + 6, 25, hex('#3b82f6'))
    const total = input.crew.length
    const done = input.crew.filter(m => m.status !== 'running').length
    if (total === 0) {
      text(c, bx + 3, 8, clip('ALL CLEAR', Math.floor((bw - 4) / 4)), hex('#3b4677'))
      sprite(c, bx + bw - 12, 15, ['.yy.yy.', 'y..y..y', '.......', 'y.....y', '.yyyyy.'], { y: hex('#3b82f6') })
    } else {
      text(c, bx + 3, 8, clip('SPRINT', Math.floor((bw - 4) / 4)), hex('#3b4677'))
      const bar = bw - 6
      rect(c, bx + 3, 16, bar, 3, hex('#d7dbea'))
      rect(c, bx + 3, 16, Math.round((bar * done) / total), 3, hex('#22c55e'))
      for (let k = 0; k < Math.min(done, Math.floor(bar / 3)); k += 1) rect(c, bx + 3 + k * 3, 21, 1, 3, hex('#3b4677'))
    }
    // Sticky notes in the corner.
    rect(c, bx + bw - 8, 7, 5, 5, hex('#fde047'))
    rect(c, bx + bw - 14, 8, 5, 5, hex('#f9a8d4'))
  }

  // An aurora painting between the windows and the lounge, its curtains drifting.
  const px = Math.max(26, plan.loungeX - 32)
  rect(c, px - 2, 6, 26, 18, hex('#c9a24a'))
  rect(c, px - 1, 7, 24, 16, hex('#0a1030'))
  for (let x = 0; x < 24; x += 1) {
    for (let band = 0; band < 3; band += 1) {
      const y = 11 + band * 3 + Math.sin(x / 3.5 + now / 900 + band * 1.3) * 2
      const hue = 140 + band * 60 + Math.sin(now / 1500 + x / 6) * 20
      glow(c, px - 1 + x, y, 0.8, 2.2, hslRgb(hue, 0.9, 0.6), 0.55)
    }
  }

  // The wall clock tells the real time.
  const cx = plan.loungeX + 46
  const cy = 9
  for (let a = 0; a < 360; a += 12) set(c, cx + Math.round(Math.cos((a * Math.PI) / 180) * 5), cy + Math.round(Math.sin((a * Math.PI) / 180) * 5), C.frame)
  glow(c, cx, cy, 4.5, 4.5, C.white, 0.85)
  const hand = (angle: number, length: number, rgb: RGB) => {
    for (let r = 0; r <= length; r += 0.5) set(c, cx + Math.round(Math.sin(angle) * r), cy - Math.round(Math.cos(angle) * r), rgb)
  }
  hand(((input.hours % 12) + input.minutes / 60) * (Math.PI / 6), 2.5, C.ink)
  hand(input.minutes * (Math.PI / 30), 4, hex('#3a3f5c'))
  set(c, cx, cy, C.red)

  // A neon sign over the lounge, flickering now and then.
  const flicker = Math.sin(now / 130) > 0.96 ? 0.35 : 1
  const neon = mix(C.wall, C.neon, flicker)
  text(c, plan.loungeX + 8, 3, 'BREAK', neon)
  glow(c, plan.loungeX + 17, 5, 14, 5, C.neon, 0.12 * flicker)
}

function paintFloor(c: Canvas, plan: Plan) {
  for (let y = WALL_H; y < c.h; y += 1) {
    for (let x = 0; x < c.w; x += 1) {
      if (x >= plan.loungeX) {
        // Long planks in staggered courses, each its own shade, with a faint grain.
        const course = Math.floor((y - WALL_H) / 5)
        const offset = Math.floor(noise(course, 0, 9) * 40)
        const board = Math.floor((x - plan.loungeX + offset) / 40)
        const isSeam = (y - WALL_H) % 5 === 4 || (x - plan.loungeX + offset) % 40 === 0
        const tone = mix(C.plank, C.plankAlt, noise(board, course, 2))
        set(c, x, y, isSeam ? C.plankSeam : noise(x, y, 4) > 0.93 ? mix(tone, C.plankSeam, 0.35) : tone)
        continue
      }
      const tile = ((x >> 3) + (y >> 3)) % 2 === 0
      const speck = noise(x, y, 1) > 0.94
      set(c, x, y, speck ? C.carpetSpeck : tile ? C.carpet : C.carpetAlt)
    }
  }
  // Warm pools of light from the ceiling lamps.
  for (let k = 0; k < plan.across; k += 1) {
    for (let r = 0; r < ROWS_OF_DESKS; r += 1) glow(c, plan.deskX + k * STATION_W + 24, FIRST_ROW_Y + r * STATION_H + 32, 26, 12, hex('#3a4a8a'), 0.18)
  }
  glow(c, plan.loungeX + 27, 110, 30, 22, hex('#ffb36b'), 0.1)

  // The lounge's edge and a soft shadow under the wall.
  for (let y = WALL_H; y < c.h; y += 1) set(c, plan.loungeX - 1, y, C.plankSeam)
  for (let x = 0; x < c.w; x += 1) for (let k = 0; k < 4; k += 1) blend(c, x, WALL_H + k, C.shadow, 0.35 - k * 0.08)
}

// A potted plant: big leaves over a terracotta pot, swaying a pixel now and then.
function plant(c: Canvas, x: number, y: number, now: number, salt: number) {
  shade(c, x + 6, y + 18, 6, 2)
  const sway = Math.sin(now / 1100 + salt) > 0.6 ? 1 : 0
  const leaves = [
    '...ll.....',
    '..lLll.l..',
    '.lLlldlLl.',
    'lLl.dllLll',
    '.ll.dlLl..',
    'llLldld.ll',
    '.lldlLlll.',
    '..llddll..',
  ]
  sprite(c, x + 1 + sway, y, leaves, { l: C.leaf, L: C.leafLight, d: C.leafDark })
  sprite(c, x + 2, y + 8, ['.dd.d...', '..dd....'], { d: C.leafDark })
  sprite(c, x + 1, y + 10, ['pppppppp', 'qPPPPPPq', '.PPPPPP.', '.qPPPPq.', '..qqqq..'], { p: hex('#e07a4a'), P: C.pot, q: C.potDark })
}

function paintDesk(c: Canvas, seat: number, plan: Plan, lit: RGB | null, typing: boolean, now: number) {
  const o = stationOf(seat, plan)
  const top = o.y + 20
  const x = o.x + 6
  shade(c, o.x + 24, top + 15, 20, 3)

  // The desk: a lit top edge, a front panel with grain, two legs.
  rect(c, x, top, 36, 1, C.woodTop)
  rect(c, x, top + 1, 36, 2, C.woodLight)
  rect(c, x + 1, top + 3, 34, 8, C.wood)
  for (let g = 0; g < 3; g += 1) {
    const gy = top + 5 + g * 2
    for (let i = 3; i < 33; i += 1) if (noise(i, g, seat) > 0.55) set(c, x + i, gy, C.woodGrain)
  }
  rect(c, x + 1, top + 10, 34, 1, C.woodDark)
  rect(c, x + 2, top + 11, 3, 3, C.leg)
  rect(c, x + 31, top + 11, 3, 3, C.leg)

  // The laptop, its lid towards us, the logo glowing in its worker's colour.
  const lx = o.x + 17
  if (lit === null) {
    rect(c, lx, top - 2, 14, 2, C.lidDark)
    rect(c, lx, top - 2, 14, 1, C.lid)
  } else {
    rect(c, lx, top - 8, 14, 8, C.lid)
    rect(c, lx, top - 8, 14, 1, C.lidLight)
    rect(c, lx, top - 1, 14, 1, C.lidDark)
    rect(c, lx + 13, top - 7, 1, 6, C.lidDark)
    const pulse = 0.6 + 0.4 * Math.sin(now / 300 + seat)
    rect(c, lx + 6, top - 5, 2, 2, mix(C.lidLight, lit, pulse))
    glow(c, lx + 7, top - 12, 9, 6, lit, 0.18)
    if (typing) {
      // Hands tapping either side of the lid.
      const tap = Math.floor(now / 140 + seat) % 2
      set(c, lx - 1, top - 1 - tap, mix(lit, C.white, 0.2))
      set(c, lx + 14, top - 2 + tap, mix(lit, C.white, 0.2))
    }
  }

  // Something on every desk, different by seat: a mug with steam, a succulent, papers, a lamp.
  const kind = seat % 4
  if (kind === 0) {
    sprite(c, x + 29, top - 4, ['mmm.', 'mcmm', 'mmm.', '.m..'], { m: C.mug, c: C.coffee })
    if (lit !== null) {
      const s = Math.floor(now / 250) % 3
      set(c, x + 30, top - 6 - s, C.steam)
      set(c, x + 31, top - 7 - ((s + 1) % 3), mix(C.steam, C.carpet, 0.4))
    }
  } else if (kind === 1) {
    sprite(c, x + 3, top - 4, ['.l.l', 'lLl.', '.pp.', '.pp.'], { l: C.leaf, L: C.leafLight, p: C.pot })
  } else if (kind === 2) {
    sprite(c, x + 3, top - 2, ['wwwww', 'wdwww'], { w: C.white, d: C.textDim })
  } else {
    sprite(c, x + 30, top - 7, ['.yyy', 'yyyy', '..k.', '..k.', '..k.', '.kkk', '....'], { y: hex('#ffd36b'), k: C.chromeDark })
    if (lit !== null) glow(c, x + 31, top - 4, 6, 4, hex('#ffd36b'), 0.15)
  }
}

// An office chair seen from behind the desk: a rounded mesh back on a stem.
function paintChair(c: Canvas, seat: number, plan: Plan) {
  const o = stationOf(seat, plan)
  sprite(c, o.x + 17, o.y + 6, [
    '...rrrrrrrr...',
    '..rLLccccccr..',
    '.rLcmcmcmcmcr.',
    '.rLmcmcmcmcmr.',
    '.rLcmcmcmcmcr.',
    '.rLmcmcmcmcmr.',
    '..rccccccccr..',
    '...rrrrrrrr...',
    '......kk......',
    '......kk......',
    '....kkkkkk....',
  ], { r: hex('#1b1f33'), L: C.chairLight, c: C.chair, m: hex('#323858'), k: hex('#14172a') })
}

function paintLounge(c: Canvas, plan: Plan, now: number) {
  const x = plan.loungeX
  // A counter along the wall with the espresso machine and its cup, steam curling up.
  rect(c, x + 1, WALL_H - 12, 22, 2, C.woodTop)
  rect(c, x + 1, WALL_H - 10, 22, 8, C.woodDark)
  rect(c, x + 4, WALL_H - 26, 12, 14, C.chromeDark)
  rect(c, x + 5, WALL_H - 25, 10, 12, C.chrome)
  rect(c, x + 6, WALL_H - 24, 8, 3, C.chromeDark)
  set(c, x + 13, WALL_H - 19, Math.floor(now / 500) % 2 === 0 ? C.red : mix(C.red, C.chromeDark, 0.6))
  rect(c, x + 8, WALL_H - 20, 4, 2, C.ink)
  sprite(c, x + 8, WALL_H - 16, ['mmmm', 'mccm', '.mm.'], { m: C.mug, c: C.coffee })
  for (let k = 0; k < 3; k += 1) {
    const t = (now / 600 + k / 3) % 1
    blend(c, x + 9 + Math.round(Math.sin(t * 6 + k) * 1.5), WALL_H - 17 - Math.round(t * 9), C.steam, 0.8 * (1 - t))
  }

  // The water cooler: a blue bottle with bubbles rising, on a white stand.
  const wx = x + 30
  const wy = WALL_H - 22
  shade(c, wx + 5, wy + 33, 6, 2)
  rect(c, wx + 2, wy, 7, 2, C.waterLight)
  rect(c, wx + 1, wy + 2, 9, 9, C.water)
  rect(c, wx + 2, wy + 3, 2, 7, C.waterLight)
  const bubble = Math.floor(now / 220) % 9
  set(c, wx + 6, wy + 10 - bubble, C.white)
  set(c, wx + 5, wy + 10 - ((bubble + 4) % 9), C.waterLight)
  rect(c, wx, wy + 11, 11, 20, C.white)
  rect(c, wx + 9, wy + 11, 2, 20, hex('#c8ccdb'))
  rect(c, wx + 3, wy + 15, 5, 2, hex('#3b82f6'))
  rect(c, wx + 2, wy + 22, 7, 1, hex('#c8ccdb'))

  // A round table with donuts, and two stools.
  const tx = x + 14
  const ty = 106
  shade(c, tx + 10, ty + 14, 12, 3)
  rect(c, tx, ty, 20, 2, C.woodTop)
  rect(c, tx - 1, ty + 2, 22, 2, C.woodLight)
  rect(c, tx + 1, ty + 4, 18, 1, C.woodDark)
  rect(c, tx + 9, ty + 5, 2, 7, C.leg)
  rect(c, tx + 5, ty + 12, 10, 1, C.leg)
  for (const [dx, dy] of [[3, -3], [9, -4], [14, -3]] as const) {
    sprite(c, tx + dx, ty + dy, ['.ddd.', 'dp.pd', '.ddd.'], { d: C.donutDough, p: C.donut })
    set(c, tx + dx + 1, ty + dy, C.donut)
    set(c, tx + dx + 3, ty + dy, C.donut)
    set(c, tx + dx + 2, ty + dy, C.sprinkle)
  }

  // A sofa at the bottom of the lounge: its back here, its seat drawn over whoever sits on it.
  const sx = x + 4
  shade(c, sx + 23, SOFA_Y + 16, 24, 3)
  rect(c, sx + 2, SOFA_Y, 42, 7, C.sofaDark)
  rect(c, sx + 3, SOFA_Y + 1, 40, 5, C.sofa)
  rect(c, sx + 3, SOFA_Y + 1, 40, 1, C.sofaLight)
  rect(c, sx + 8, SOFA_Y + 2, 6, 4, hex('#ffcf6b'))
  rect(c, sx + 32, SOFA_Y + 2, 6, 4, hex('#c4a3ff'))

  plant(c, x + 38, 128, now, 4)
}

const SOFA_Y = 156

function sofaSeat(c: Canvas, plan: Plan) {
  const sx = plan.loungeX + 4
  rect(c, sx, SOFA_Y + 6, 46, 7, C.sofa)
  rect(c, sx, SOFA_Y + 6, 46, 1, C.sofaLight)
  rect(c, sx, SOFA_Y + 6, 4, 9, C.sofaDark)
  rect(c, sx + 42, SOFA_Y + 6, 4, 9, C.sofaDark)
  rect(c, sx + 22, SOFA_Y + 7, 1, 6, C.sofaDark)
  rect(c, sx + 4, SOFA_Y + 13, 38, 1, C.sofaDark)
}

// ── a frame ───────────────────────────────────────────────────────────────

const toneOf: Record<Tone, RGB> = { work: C.pillWork, good: C.pillGood, bad: C.pillBad, quiet: C.pillQuiet }

export function drawOffice(input: OfficeInput): OfficeFrame {
  const plan = planFor(input.cols)
  const c = canvasOf(plan.w, ART_H)
  const { now } = input
  const { actors, gone, hidden } = cast(input, plan)

  paintFloor(c, plan)
  paintWall(c, plan, now, input)
  paintLounge(c, plan, now)

  // Seated robots go with their desks; the rest are sorted by their feet so nearer ones overlap.
  const seated = new Map<number, Actor>()
  for (const a of actors) if (a.mode === 'seated' && a.seat !== null) seated.set(a.seat, a)

  type Drawable = { y: number; paint: () => void }
  const drawables: Drawable[] = []
  for (let seat = 0; seat < plan.across * ROWS_OF_DESKS; seat += 1) {
    const o = stationOf(seat, plan)
    const who = seated.get(seat)
    drawables.push({
      y: o.y + 20,
      paint: () => {
        paintChair(c, seat, plan)
        if (who !== undefined) {
          const bob = who.cheer && Math.floor(now / 200) % 2 === 0 ? -2 : 0
          robot(c, who.at.x, who.at.y, who.look, who.face === 'focus' && Math.floor(now / 180 + seat * 5) % 31 === 0 ? 'blink' : who.face, null, who.typing, bob)
          if (who.cheer) {
            for (let k = 0; k < 6; k += 1) {
              const t = ((now / 900 + k / 6) % 1)
              set(c, who.at.x + 7 + Math.round(Math.cos(k * 1.05) * (4 + t * 8)), who.at.y + 2 - Math.round(Math.sin(k * 1.05) * (3 + t * 6)), hslRgb(k * 60 + now / 10, 1, 0.7))
            }
          }
        }
        const typing = who?.typing === true
        paintDesk(c, seat, plan, who === undefined || who.face === 'sleep' ? null : who.look.isClaude ? C.claude : hslRgb(who.look.hue, 0.8, 0.62), typing, now)
        if (who?.face === 'sleep') {
          const t = (now / 1200) % 1
          text(c, who.at.x + 13 + Math.round(t * 4), who.at.y - 1 - Math.round(t * 6), 'Z', mix(C.textDim, C.carpet, t))
        }
      },
    })
  }
  for (const [k, y] of [[0, 46], [1, 92], [2, 138]] as const) drawables.push({ y: y + 18, paint: () => plant(c, -1, y, now, k) })
  drawables.push({ y: SOFA_Y + 14, paint: () => sofaSeat(c, plan) })
  for (const a of actors) {
    if (a.mode === 'seated') continue
    const step = a.mode === 'walking' ? (Math.floor(now / 160) % 2 === 0 ? 'stepA' : 'stepB') : 'stand'
    drawables.push({ y: a.at.y + 15, paint: () => robot(c, a.at.x, a.at.y, a.look, a.face, step, a.mode !== 'walking', a.mode === 'walking' && step === 'stepB' ? -1 : 0) })
  }
  drawables.sort((p, q) => p.y - q.y)
  for (const d of drawables) d.paint()

  // Labels last, over everything: under a desk for the seated, around a standing robot.
  for (const a of actors) {
    if (a.mode === 'walking' || a.status === '') continue
    const cx = a.at.x + 7

    if (a.mode === 'seated' && a.seat !== null) {
      const o = stationOf(a.seat, plan)
      pill(c, o.x + 24, o.y + 35, a.status, toneOf[a.tone], C.text, 11)
      label(c, o.x + 24, o.y + 43 - 0, a.name, a.look.isClaude ? hex('#ffb59a') : C.text, 11)
    } else {
      label(c, cx, a.at.y - 16, a.name, a.look.isClaude ? hex('#ffb59a') : C.text, 12)
      pill(c, cx, a.at.y - 9, a.status, toneOf[a.tone], C.text, 12)
    }
  }

  // A soft vignette, darker toward the edges, for depth.
  for (let y = 0; y < c.h; y += 1) {
    for (let x = 0; x < c.w; x += 1) {
      const dx = (x / c.w - 0.5) * 2
      const dy = (y / c.h - 0.5) * 2
      const v = Math.max(0, dx * dx + dy * dy - 0.55) * 0.22
      if (v > 0) blend(c, x, y, C.shadow, Math.min(0.35, v))
    }
  }

  return { ...scaled(c), rows: officeRows(), gone, hidden }
}

// Scaled up SCALE× into RGBA, then base64, the form an Image source takes.
function scaled(c: Canvas): { rgba: string; width: number; height: number } {
  const w = c.w * SCALE
  const h = c.h * SCALE
  const out = new Uint8Array(w * h * 4)

  for (let y = 0; y < h; y += 1) {
    const sy = Math.floor(y / SCALE)
    for (let x = 0; x < w; x += 1) {
      const si = (sy * c.w + Math.floor(x / SCALE)) * 3
      const di = (y * w + x) * 4
      out[di] = c.px[si] ?? 0
      out[di + 1] = c.px[si + 1] ?? 0
      out[di + 2] = c.px[si + 2] ?? 0
      out[di + 3] = 255
    }
  }

  return { rgba: base64(out), width: w, height: h }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  const parts: string[] = []
  let chunk = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const d = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | d
    chunk += (B64[(n >> 18) & 63] ?? '') + (B64[(n >> 12) & 63] ?? '')
    chunk += i + 1 < bytes.length ? (B64[(n >> 6) & 63] ?? '') : '='
    chunk += i + 2 < bytes.length ? (B64[n & 63] ?? '') : '='

    if (chunk.length >= 16384) {
      parts.push(chunk)
      chunk = ''
    }
  }
  parts.push(chunk)

  return parts.join('')
}
