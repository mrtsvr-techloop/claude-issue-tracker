import type { Board, Filter, Issue, Label, Progress, Repo, Status } from '../types'

type Bag = Record<string, unknown>

const isBag = (value: unknown): value is Bag =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

const asNodes = (value: unknown): Bag[] =>
  isBag(value) && Array.isArray(value.nodes) ? value.nodes.filter(isBag) : []

/** The colors a project gives its status options, as a dark or light terminal shows them. */
const PROJECT_COLORS: Record<string, string> = {
  GRAY: '#9198a1',
  BLUE: '#4493f8',
  GREEN: '#3fb950',
  YELLOW: '#d29922',
  ORANGE: '#db6d28',
  RED: '#f85149',
  PINK: '#db61a2',
  PURPLE: '#ab7df8',
}
const OPEN: Status = { name: 'Open', color: '#3fb950' }
const CLOSED: Status = { name: 'Closed', color: '#ab7df8' }
const NOT_PLANNED: Status = { name: 'Not planned', color: '#9198a1' }

/** `git@host:owner/name.git`, `ssh://git@host/owner/name` or `https://host/owner/name`. */
export const parseRemote = (url: string): Omit<Repo, 'root'> | undefined => {
  const match =
    /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](?:\d+\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim())
  const [, host, owner, name] = match ?? []

  return host && owner && name ? { host, owner, name } : undefined
}

/** `owner/name`, as the person types a repository they have no working copy of. */
export const parseSlug = (text: string): Omit<Repo, 'root'> | undefined => {
  const [, owner, name] = /^([\w.-]+)\/([\w.-]+)$/.exec(text.trim()) ?? []

  return owner && name ? { host: 'github.com', owner, name } : undefined
}

export const slugOf = (repo: Repo): string => `${repo.owner}/${repo.name}`

export const isSameRepo = (one: Repo | null, other: Repo | null): boolean =>
  one !== null &&
  other !== null &&
  one.host === other.host &&
  slugOf(one).toLowerCase() === slugOf(other).toLowerCase()

const CHECKBOX = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]/

/** The checked and total task-list items of a body: acceptance criteria, usually. */
export const checklistOf = (body: string): { done: number; total: number } => {
  const marks = body.split('\n').flatMap(line => CHECKBOX.exec(line)?.[1] ?? [])

  return { done: marks.filter(mark => mark !== ' ').length, total: marks.length }
}

/**
 * How far an issue is, by the first thing that defines it: its sub-issues, the
 * task list in its body, or its being closed. Null when nothing does.
 */
export const progressOf = (sub: unknown, body: string, isOpen: boolean): Progress | null => {
  const total = isBag(sub) && typeof sub.total === 'number' ? sub.total : 0
  const completed = isBag(sub) && typeof sub.completed === 'number' ? sub.completed : 0

  if (!isOpen) {
    return { done: 1, total: 1, source: 'closed' }
  }

  if (total > 0) {
    return { done: completed, total, source: 'sub-issues' }
  }

  const checklist = checklistOf(body)

  return checklist.total > 0 ? { ...checklist, source: 'checklist' } : null
}

export const percentOf = (progress: Progress): number =>
  progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)

/** The status its project gives the issue, else GitHub's open or closed. */
export const statusOf = (node: Bag): Status => {
  for (const item of asNodes(node.projectItems)) {
    const value = item.fieldValueByName
    const name = isBag(value) ? asText(value.name) : ''

    if (isBag(value) && name.length > 0) {
      return { name, color: colorOf(value.color) }
    }
  }

  if (node.state !== 'CLOSED') {
    return OPEN
  }

  return node.stateReason === 'NOT_PLANNED' ? NOT_PLANNED : CLOSED
}

const colorOf = (name: unknown): string => PROJECT_COLORS[asText(name)] ?? PROJECT_COLORS.GRAY ?? ''

/** The project item that carries the issue's status, with the statuses on offer. */
export const boardOf = (node: Bag): Board | null => {
  for (const item of asNodes(node.projectItems)) {
    const project = item.project
    const field = isBag(project) ? project.field : undefined
    const options = isBag(field) && Array.isArray(field.options) ? field.options.filter(isBag) : []

    if (isBag(project) && isBag(field) && options.length > 0) {
      return {
        projectId: asText(project.id),
        itemId: asText(item.id),
        fieldId: asText(field.id),
        options: options.map(one => ({ id: asText(one.id), name: asText(one.name), color: colorOf(one.color) })),
      }
    }
  }

  return null
}

/** A status the person can give an issue: a project's option, or GitHub's open and closed. */
export type Choice = Status & ({ optionId: string } | { state: 'OPEN' | 'COMPLETED' | 'NOT_PLANNED' })

export const choicesOf = (issue: Issue): Choice[] =>
  issue.board
    ? issue.board.options.map(({ id, name, color }) => ({ name, color, optionId: id }))
    : [
        { ...OPEN, state: 'OPEN' },
        { ...CLOSED, state: 'COMPLETED' },
        { ...NOT_PLANNED, state: 'NOT_PLANNED' },
      ]

/** The issue as it reads once the choice is made, before GitHub confirms it. */
export const chosen = (issue: Issue, choice: Choice): Issue => ({
  ...issue,
  status: { name: choice.name, color: choice.color },
  isOpen: 'state' in choice ? choice.state === 'OPEN' : issue.isOpen,
})

const HEX = /^[0-9a-f]{6}$/i

/** A label node with the color GitHub gives it, six hex digits and no hash. */
const labelOf = (node: Bag): Label => {
  const color = asText(node.color)

  return { name: asText(node.name), color: HEX.test(color) ? `#${color.toLowerCase()}` : colorOf('GRAY') }
}

/** Above this luma a background takes black text, under it white. */
const LIGHT_LUMA = 140

/** The text color that reads on a `#rrggbb` background. */
export const inkOn = (color: string): string => {
  const [red = 0, green = 0, blue = 0] = [1, 3, 5].map(at => Number.parseInt(color.slice(at, at + 2), 16))

  return 0.299 * red + 0.587 * green + 0.114 * blue > LIGHT_LUMA ? '#000000' : '#ffffff'
}

/** One issue node of a GraphQL answer, or undefined when it is no issue. */
export const issueOf = (node: unknown): Issue | undefined => {
  if (!isBag(node) || typeof node.number !== 'number') {
    return undefined
  }

  const body = asText(node.body)
  const isOpen = node.state !== 'CLOSED'

  return {
    id: asText(node.id),
    number: node.number,
    title: asText(node.title),
    url: asText(node.url),
    isOpen,
    status: statusOf(node),
    board: boardOf(node),
    body: body.replace(/<!--[\s\S]*?-->/g, '').trim(),
    labels: asNodes(node.labels).map(labelOf),
    progress: progressOf(node.subIssuesSummary, body, isOpen),
    assignees: asNodes(node.assignees).map(one => asText(one.login)),
    updatedAt: asText(node.updatedAt),
  }
}

/** The issue numbers a text names for this repository: `#12`, its URL, a `gh issue` call. */
export const refsIn = (text: string, repo: Repo): number[] => {
  const slug = slugOf(repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    /(?:^|[\s(,;:])#(\d{1,6})(?![\w#])/g,
    new RegExp(`${slug}/issues/(\\d{1,6})`, 'gi'),
    /\bgh\s+issue\s+\w+\s+(\d{1,6})\b/g,
  ]
  const found = patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => Number(match[1])))

  return [...new Set(found)].filter(number => number > 0)
}

/** The issue a branch is named for: `242-discount`, `feat/242_x`, `issue-242`. */
export const branchRef = (branch: string): number | undefined => {
  const [, lead, named] = /(?:^|\/)(\d{1,6})[-_]|issue[-_/]?(\d{1,6})/i.exec(branch) ?? []
  const number = Number(lead ?? named)

  return number > 0 ? number : undefined
}

/** Fresh issues laid over the ones held, newest change first. */
export const merged = (held: Issue[], fresh: Issue[]): Issue[] => {
  const byNumber = new Map([...held, ...fresh].map(issue => [issue.number, issue]))

  return [...byNumber.values()].sort((one, other) => other.updatedAt.localeCompare(one.updatedAt))
}

type Marks = { pinned: number[]; working: number[] }

/** Pinned first, then what the session works on, then the rest as held. */
export const ordered = (issues: Issue[], marks: Marks): Issue[] => {
  const rank = (issue: Issue): number =>
    marks.pinned.includes(issue.number) ? 0 : marks.working.includes(issue.number) ? 1 : 2

  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((one, other) => rank(one.issue) - rank(other.issue) || one.index - other.index)
    .map(({ issue }) => issue)
}

type View = Marks & { search: string; filter: Filter; viewer: string }

/** The issues the panel lists: a pinned one passes every filter but the search text. */
export const visible = (issues: Issue[], view: View): Issue[] => {
  const text = view.search.trim().toLowerCase().replace(/^#/, '')
  const { filter } = view

  return ordered(issues, view).filter(issue => {
    const isPinned = view.pinned.includes(issue.number)
    const isFound =
      text.length === 0 ||
      String(issue.number).includes(text) ||
      issue.title.toLowerCase().includes(text) ||
      issue.body.toLowerCase().includes(text)

    if (!isFound || (filter.isPinnedOnly && !isPinned)) {
      return false
    }

    return (
      isPinned ||
      ((filter.state === 'all' || (filter.state === 'open') === issue.isOpen) &&
        (filter.status.length === 0 || issue.status.name === filter.status) &&
        (!filter.isMine || issue.assignees.includes(view.viewer)))
    )
  })
}

export const statusesOf = (issues: Issue[]): string[] => [...new Set(issues.map(issue => issue.status.name))]

const cut = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

const STATUS_COLUMNS = 14

/** The last space a line `room` wide can break `text` at, else `room` itself. */
const breakAt = (text: string, room: number): number => {
  const space = text.lastIndexOf(' ', room)

  return space > room / 2 ? space : room
}

/**
 * A card's header `width` cells wide: the number in a block of its own, a
 * cell, the title and the `gap` that carries it to the status name at the
 * right, which the dot follows. A title too long for the line goes on, once,
 * on a second line under its start, with the gap that fills that line.
 */
export const headerOf = (
  issue: Issue,
  width: number,
): { number: string; title: string; gap: number; status: string; below: { title: string; gap: number } | null } => {
  const status = cut(issue.status.name, STATUS_COLUMNS)
  const number = ` #${issue.number} `
  // A cell before the title; a cell each side of the status, the dot and the closing cell.
  const room = Math.max(0, width - status.length - 4 - number.length - 1)

  if (issue.title.length <= room) {
    return { number, title: issue.title, gap: room - issue.title.length, status, below: null }
  }

  const at = breakAt(issue.title, room)
  const wide = Math.max(0, width - number.length - 2)
  const rest = cut(issue.title.slice(at).trim(), wide)

  // The second line keeps the first one's closing cell.
  return { number, title: issue.title.slice(0, at), gap: room - at, status, below: { title: rest, gap: wide - rest.length + 1 } }
}

const SOURCES: Record<Progress['source'], string> = {
  'sub-issues': 'sub-issue',
  checklist: 'criteria',
  closed: 'closed',
}

/** A card's footer: a bar, the percentage, and what it counts. */
export const footerOf = (progress: Progress, width: number): { filled: string; rest: string; label: string } => {
  const percent = percentOf(progress)
  const cells = Math.round((percent / 100) * width)
  const count = progress.source === 'closed' ? '' : ` · ${progress.done}/${progress.total}`

  return {
    filled: '█'.repeat(cells),
    rest: '░'.repeat(width - cells),
    label: ` ${percent}%${count} ${SOURCES[progress.source]}`,
  }
}
