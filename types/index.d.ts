export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Meter = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
  costUsd?: number
}

export type Git = {
  project: string
  branch: string
  worktree: string | null
  dirty: number
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRow = {
  id: string
  label: string
  type: string
  model: string
  runId: string | null
  startedAt: number
  endedAt: number | null
  status: AgentStatus
  tools: number
  lastTool: string | null
}

export type FlowRow = { runId: string; name: string; startedAt: number; lastSpawnAt: number }

export type FlowSummary = { name: string; done: number; total: number; failed: number; ms: number }

export type MonthSpend = { month: string; usd: number; sessions: number; models: Record<string, number> }

export type Turn = { startedAt: number; endedAt: number | null; tools: number }

declare module 'claude-code' {
  interface PluginState {
    aurora: {
      meter: Meter | null
      git: Git | null
      frame: number
      beat: number
      model: string
      effort: string | null
      agents: AgentRow[]
      flows: FlowRow[]
      lastFlow: FlowSummary | null
      turn: Turn | null
      sessionStart: number
      monthSpend: MonthSpend | null
      session: { id: string; title: string | null } | null
    }
  }
}
