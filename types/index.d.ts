/** A GitHub repository the session can show the issues of. */
export type Repo = {
  host: string
  owner: string
  name: string
  /** The working copy's root on this machine; empty when attached by name alone. */
  root: string
}

/** An issue's state as its project names and colors it, else GitHub's own. */
export type Status = { name: string; color: string }

/** Where an issue's status lives in its project, and the statuses that project offers. */
export type Board = {
  projectId: string
  itemId: string
  fieldId: string
  options: (Status & { id: string })[]
}

/** A label as the repository names and colors it. */
export type Label = { name: string; color: string }

/** How far an issue is, and what says so. */
export type Progress = {
  done: number
  total: number
  source: 'sub-issues' | 'checklist' | 'closed'
}

export type Issue = {
  /** GitHub's node id, what a change of state names the issue by. */
  id: string
  number: number
  title: string
  url: string
  isOpen: boolean
  status: Status
  /** Null when no project gives the issue a status: it is open or closed then. */
  board: Board | null
  /** The issue's text as written, markdown, without its hidden comments. */
  body: string
  labels: Label[]
  /** Null when nothing in the issue defines a completion. */
  progress: Progress | null
  assignees: string[]
  updatedAt: string
}

export type Filter = {
  state: 'open' | 'closed' | 'all'
  /** A status name, or empty for every status. */
  status: string
  isMine: boolean
  isPinnedOnly: boolean
}

/** The issues loaded so far and where the next page starts. */
export type Feed = {
  issues: Issue[]
  cursor: string | null
  hasMore: boolean
  /** How many issues GitHub holds for the list asked, loaded or not. */
  total: number
  isLoading: boolean
  error: string | null
  /** The login the machine's GitHub access belongs to. */
  viewer: string
  /** The search text the server answered this list for. */
  query: string
}

export type Access = 'unknown' | 'granted' | 'none'

/** A signal of Mod Signals 0.1, as the mod writes it under `signal` for every other mod to hear. */
export type IssuesSignal = {
  v: 1
  kind: 'event' | 'command' | 'announce'
  name: string
  to?: string
  data?: Record<string, unknown>
  /** What kind of signal this is, for whoever picks signals by kind: `['info', 'completion']`. */
  tags?: string[]
  id: string
}

/**
 * What any other mod calls on `$.issues` to drive the pane with no command typed.
 * Each answers whether the pane is open once the call is done.
 */
export type Issues = {
  /** Opens the pane on the attached project; false when there is no project to show. */
  open: () => Promise<boolean>
  close: () => Promise<boolean>
  /** Closes the pane when it is open, opens it otherwise. */
  toggle: () => Promise<boolean>
  isOpen: () => Promise<boolean>
}

declare module 'claude-code' {
  interface EngineInterface {
    issues: Issues
  }

  interface PluginState {
    'issue-tracker': {
      repo: Repo | null
      /** Repositories found on this machine the person can switch to. */
      candidates: Repo[]
      access: Access
      feed: Feed
      search: string
      filter: Filter
      pinned: number[]
      /** Issues this session mentioned or works on the branch of. */
      working: number[]
      /** True while the panel shows the project selection in place of the issues. */
      isChoosing: boolean
      /** The issue whose status choices are open, if any. */
      editing: number | null
      /** The issue the panel shows in full in place of the list, if any. */
      viewing: number | null
      /** The mod's signals: `announce`, `opened`, `closed`, `notify`. */
      signal: IssuesSignal | null
    }
  }
}
