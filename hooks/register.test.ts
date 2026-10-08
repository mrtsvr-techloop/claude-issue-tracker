import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { Filter, Issue } from '../types'
import { connect, fetchPage } from './github'
import type { PageRequest } from './github'
import {
  branchRef,
  checklistOf,
  footerOf,
  headerOf,
  inkOn,
  issueOf,
  parseRemote,
  refsIn,
  visible,
} from './model'
import type { Ports } from './ports'
import { dirOf } from './project'

type Node = Record<string, unknown>

const node = (number: number, over: Node = {}): Node => ({
  id: `I${number}`,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/app/issues/${number}`,
  state: 'OPEN',
  stateReason: null,
  body: '',
  updatedAt: `2026-10-08T00:00:${String(number % 60).padStart(2, '0')}Z`,
  assignees: { nodes: [] },
  labels: { nodes: [] },
  subIssuesSummary: { total: 0, completed: 0 },
  projectItems: { nodes: [] },
  ...over,
})

const OPTIONS = [
  { id: 'o1', name: 'Todo', color: 'GRAY' },
  { id: 'o2', name: 'In Progress', color: 'YELLOW' },
  { id: 'o3', name: 'Done', color: 'GREEN' },
]
const LOGIN = node(7, {
  title: 'Login page',
  body: '## Goal\nBuild the login.\n\n- [x] form\n- [ ] errors',
  updatedAt: '2026-10-08T10:00:00Z',
  assignees: { nodes: [{ login: 'me' }] },
  labels: { nodes: [{ name: 'bug', color: 'd73a4a' }, { name: 'enhancement', color: 'A2EEEF' }] },
  projectItems: {
    nodes: [
      {
        id: 'item7',
        project: { id: 'project1', field: { id: 'field1', options: OPTIONS } },
        fieldValueByName: { name: 'In Progress', color: 'YELLOW' },
      },
    ],
  },
})
const CRASH = node(5, {
  title: 'Fix crash',
  body: 'Crash on start.',
  updatedAt: '2026-10-08T09:00:00Z',
  subIssuesSummary: { total: 4, completed: 1 },
})
const OLD = node(3, { title: 'Old thing nobody closed with a proper explanation', state: 'CLOSED', stateReason: 'COMPLETED', updatedAt: '2026-10-08T08:00:00Z' })
const FILLERS = Array.from({ length: 20 }, (_, index) => node(100 + index))
const ALL = [LOGIN, CRASH, ...FILLERS, OLD]

/** GitHub's answer to one GraphQL body, over the fixture's issues. */
const github = (body: string, nodes: Node[] = ALL): string => {
  const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> }

  if (query.startsWith('mutation')) {
    const target = nodes.find(one => one.id === variables.id)
    const option = OPTIONS.find(one => one.id === variables.option)

    if (option) {
      const moved = nodes.find(one => JSON.stringify(one.projectItems).includes(`"${String(variables.item)}"`))
      const [item] = (moved?.projectItems as { nodes: Node[] }).nodes
      Object.assign(item ?? {}, { fieldValueByName: { name: option.name, color: option.color } })
    } else if (target) {
      Object.assign(target, query.includes('reopenIssue') ? { state: 'OPEN' } : { state: 'CLOSED', stateReason: variables.reason })
    }

    return JSON.stringify(option || target ? { data: { done: {} } } : { data: null, errors: [{ message: 'Could not resolve to a node.' }] })
  }

  const named = Object.fromEntries(
    [...query.matchAll(/n(\d+):issue/g)].map(([, number]) => [
      `n${number}`,
      nodes.find(one => one.number === Number(number)) ?? null,
    ]),
  )

  if (!query.includes('viewer{login}')) {
    return JSON.stringify({ data: { repository: { hasIssuesEnabled: true } } })
  }

  const states = variables.states as string[] | null | undefined
  const text = typeof variables.q === 'string' ? (variables.q.split(' ').pop() ?? '') : ''
  const matching = nodes.filter(
    one =>
      (!states || states.includes(String(one.state))) &&
      (variables.q === undefined || String(one.title).toLowerCase().includes(text.toLowerCase())),
  )
  const start = typeof variables.after === 'string' ? Number(variables.after) : 0
  const end = start + Number(variables.first)
  const page = {
    totalCount: matching.length,
    issueCount: matching.length,
    pageInfo: { hasNextPage: end < matching.length, endCursor: String(end) },
    nodes: matching.slice(start, end),
  }

  return JSON.stringify({
    data: {
      viewer: { login: 'me' },
      repository: { hasIssuesEnabled: true, ...(variables.q === undefined ? { issues: page } : {}), ...named },
      ...(variables.q === undefined ? {} : { search: page }),
    },
  })
}

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type Machine = { bodies: string[]; opened: unknown[]; stored: unknown[] }

/** A machine with one working copy of acme/app on branch feat/7-login, reached through gh or not at all. */
const machine = (on: On, hasAccess = true): Machine => {
  const seen: Machine = { bodies: [], opened: [], stored: [] }
  const nodes = structuredClone(ALL)

  on('process.run', (_, e) => {
    const line = e.argv.join(' ')

    if (line.startsWith('gh api graphql')) {
      const body = e.init?.stdin ?? ''
      seen.bodies.push(body)

      return hasAccess ? ran(github(body, nodes)) : ran('', 1)
    }

    if (line.includes('rev-parse')) return ran('/work/app\n')
    if (line.endsWith('remote get-url origin')) return ran('git@github.com:acme/app.git\n')
    if (line.endsWith(' remote')) return ran('origin\n')
    if (line.endsWith('--show-current')) return ran('feat/7-login\n')

    return ran('', 1)
  })
  on('env.get', () => ({ value: undefined }))
  on('store.get', () => ({ value: null }))
  on('store.set', (_, e) => {
    seen.stored.push(e)

    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    seen.opened.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [{ id: 'issues', title: 'Issue', isShown: true, isFocused: false, isPlaced: true }] }))

  return seen
}

const attach = ($: Engine) =>
  $.command.run({
    command: 'issues',
    args: 'attach /work/app',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

const PANE = {
  plugin: 'issue-tracker',
  component: 'Pane',
  requestId: 'issues',
  props: {
    title: 'Issue',
    isFocused: false,
    bodyColumns: 46,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Drawn = { type?: string; props?: Record<string, unknown>; hover?: unknown; children?: unknown[] }

/** Every keyed element the tree lights on a hover, with what lights it. */
const hoversOf = (tree: unknown): { key: string; hover: unknown }[] => {
  const one = tree as Drawn
  const own = one.hover === undefined ? [] : [{ key: String(one.props?.key ?? ''), hover: one.hover }]

  return typeof tree === 'string' ? [] : [...own, ...(one.children ?? []).flatMap(hoversOf)]
}

/** Every text the tree shows, in order: a Text's children, a Link's and a Button's label. */
const textsOf = (tree: unknown): string[] => {
  const one = tree as Drawn

  if (typeof tree === 'string') return [tree]
  if (one.type === 'Link' || one.type === 'Button') return [String(one.props?.label ?? '')]

  return (one.children ?? []).flatMap(textsOf)
}

type Mounted = { findAll(match: { type: 'Button' }): Promise<readonly { key?: string | undefined }[]> }

/** The issues listed, in order, by the title each card opens its issue with. */
const listed = async (ui: Mounted): Promise<string[]> =>
  (await ui.findAll({ type: 'Button' })).flatMap(one => /^open-(\d+)$/.exec(one.key ?? '')?.[1] ?? [])

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: an attached project's issues are cards with header, status dot and progress`, async ($, on) => {
    const seen = machine(on)
    expect((await attach($)).text).toBe('Issues of acme/app attached.')
    expect(seen.opened).toEqual([{ id: 'issues', title: 'Issues', columns: 46 }])

    const ui = await $.ui.mount({ ...PANE, surface })
    const text = textsOf(await ui.drawn()).join('|')

    // The branch names #7: it leads, though #5 and the fillers are newer or not.
    expect((await listed(ui)).slice(0, 2)).toEqual(['7', '5'])
    expect(text).toContain('| #7 | |Login page|')
    // A card carries no description and no link: the title opens the issue.
    expect(await ui.findAll({ type: 'Link' })).toEqual([])
    expect(text).not.toContain('Build the login')
    expect((await ui.find({ type: 'Text', text: ' #7 ' }))?.props).toMatchObject({ backgroundColor: '#ffffff', color: '#000000' })
    expect(text).toContain(' |In Progress| |●| |')
    expect(text).toContain(' 50% · 1/2 criteria| · working')
    expect(text).toContain(' 25% · 1/4 sub-issue')
    expect(text).toContain('|22 issues|')
    expect(text).not.toContain('→')

    const dots = (await ui.findAll({ type: 'Text', text: '●' })).map(one => one.props.color)
    expect(dots.slice(0, 2)).toEqual(['#d29922', '#3fb950'])
    await ui.unmount()
  })
}

test('the next page loads on demand, and a pinned issue leads and is stored', async ($, on) => {
  const seen = machine(on)
  await attach($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const pins = async () => (await ui.findAll({ type: 'Button' })).flatMap(one => (one.key?.startsWith('pin-') ? [one.key] : []))

  expect(await pins()).toHaveLength(20)
  await ui.press({ key: 'more' })
  expect(await pins()).toHaveLength(22)
  expect(await ui.find({ key: 'more' })).toBe(undefined)

  await ui.press({ key: 'pin-5' })
  expect((await pins()).slice(0, 2)).toEqual(['pin-5', 'pin-7'])
  expect(seen.stored).toEqual([{ key: 'pins:github.com/acme/app', value: [5] }])
  // The header runs unbroken under title and status: dark blue once pinned, grey otherwise.
  const under = async (key: string) => {
    const boxes = (await ui.findAll({ type: 'Box' })) as Drawn[]

    return boxes.find(box => (box.children as Drawn[] | undefined)?.[0]?.props?.key === key)?.props?.backgroundColor
  }
  expect([await under('open-5'), await under('status-5'), await under('open-7'), await under('status-7')]).toEqual([
    '#0d2f6b',
    '#0d2f6b',
    '#3a3a3a',
    '#3a3a3a',
  ])

  expect(await ui.find({ key: 'collapse' })).toBe(undefined)
  await ui.unmount()
})

test('the search narrows what is loaded as typed and asks GitHub on Enter; a state filter asks again', async ($, on) => {
  const seen = machine(on)
  await attach($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const hrefs = () => listed(ui)

  await ui.input({ key: 'search', text: 'crash', kind: 'change' })
  expect(await hrefs()).toEqual(['5'])

  const before = seen.bodies.length
  await ui.input({ key: 'search', text: 'login' })
  expect(seen.bodies.length).toBe(before + 1)
  expect(seen.bodies.at(-1)).toContain('repo:acme/app is:issue sort:updated-desc is:open login')
  expect(await hrefs()).toEqual(['7'])

  await ui.input({ key: 'search', text: '', kind: 'change' })
  await ui.press({ key: 'state-closed' })
  expect(JSON.parse(seen.bodies.at(-1) ?? '{}').variables.states).toEqual(['CLOSED'])
  expect(await hrefs()).toEqual(['3'])
  await ui.unmount()
})

test('the search sits on a block of its own, and a filter is a block blue while on and grey while off', async ($, on) => {
  machine(on)
  await attach($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  /** The background of the Box each keyed control sits in. */
  const blocks = async (): Promise<Record<string, unknown>> => {
    const found: Record<string, unknown> = {}
    const walk = (tree: unknown): void => {
      const one = tree as Drawn
      const [child] = (one.children ?? []) as Drawn[]

      // The cards' headers sit on blocks too: the controls above the list are the ones asked of.
      if (one.type === 'Box' && one.props?.backgroundColor !== undefined && child?.props?.key !== undefined && !/-\d+/.test(String(child.props.key))) {
        found[String(child.props.key)] = one.props.backgroundColor
      }

      for (const next of one.children ?? []) walk(next)
    }
    walk(await ui.drawn())

    return found
  }

  expect(await blocks()).toEqual({
    search: '#30363d',
    'state-open': '#1f6feb',
    'state-closed': '#3a3a3a',
    'state-all': '#3a3a3a',
    mine: '#3a3a3a',
    'pinned-only': '#3a3a3a',
    status: '#3a3a3a',
  })
  // Half a row of the field's color each side of it, then the filters by name alone.
  expect(textsOf(await ui.drawn()).slice(1, 9)).toEqual(['▄'.repeat(46), '▀'.repeat(46), 'Open', 'Closed', 'All', 'Assigned', 'Pinned', 'Status: any'])

  await ui.press({ key: 'mine' })
  await ui.press({ key: 'status' })
  expect(await blocks()).toMatchObject({ mine: '#1f6feb', status: '#1f6feb', 'pinned-only': '#3a3a3a' })
  await ui.unmount()
})

test('the project button leads to the selection, the only place a project is changed from', async ($, on) => {
  machine(on)
  await attach($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const keys = async () => (await ui.findAll({ type: 'Button' })).map(one => one.key)

  expect((await ui.find({ key: 'project' }))?.props).toMatchObject({ label: 'acme/app', variant: 'primary' })
  // The first thing the body draws, at its left.
  expect(textsOf(await ui.drawn())[0]).toBe('acme/app')
  expect((await keys()).filter(key => key?.startsWith('repo-'))).toEqual([])

  await ui.press({ key: 'project' })
  expect(await keys()).toEqual(['repo-acme/app', 'cancel'])
  expect(textsOf(await ui.drawn())).toEqual(['Select a project', '● acme/app', 'Cancel'])

  await ui.press({ key: 'cancel' })
  expect(await keys()).toContain('pin-7')
  await ui.unmount()
})

test('a click on a status opens its choices, and the pick is written to GitHub and read back', async ($, on) => {
  const seen = machine(on)
  await attach($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const sets = async () => (await ui.findAll({ type: 'Button' })).flatMap(one => (one.key?.startsWith('set-') ? [one.props.label] : []))
  const sent = () => JSON.parse(seen.bodies.findLast(body => body.includes('mutation')) ?? '{}')

  // An issue on a project board takes the board's statuses.
  await ui.press({ key: 'status-7' })
  expect(await sets()).toEqual(['Todo', 'In Progress', 'Done'])
  await ui.press({ key: 'set-7-2' })
  expect(sent().variables).toEqual({ project: 'project1', item: 'item7', field: 'field1', option: 'o3' })
  expect((await ui.find({ key: 'status-7' }))?.props.label).toBe('Done')
  expect(await sets()).toEqual([])

  // One on no board is opened or closed.
  await ui.press({ key: 'status-5' })
  expect(await sets()).toEqual(['Open', 'Closed', 'Not planned'])
  await ui.press({ key: 'set-5-2' })
  expect(sent().variables).toEqual({ id: 'I5', reason: 'NOT_PLANNED' })
  // Closed now, it left the open list.
  expect(await ui.find({ key: 'status-5' })).toBe(undefined)
  await ui.unmount()
})

test('a title opens its issue in the pane: project and Back above, people, colored labels, GitHub and the text', async ($, on) => {
  machine(on)
  await attach($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const chip = async (text: string) => (await ui.find({ type: 'Text', text }))?.props

  await ui.press({ key: 'open-7' })
  const texts = textsOf(await ui.drawn())
  expect(texts.slice(0, 2)).toEqual(['acme/app', '‹ Back'])
  expect(texts.join('|')).toContain('| #7 | ●| In Progress|Login page|Assignees|@me|Labels| bug | enhancement |')
  expect(texts.join('|')).toContain(' 50% · 1/2 criteria')
  expect(await chip(' bug ')).toMatchObject({ backgroundColor: '#d73a4a', color: '#ffffff' })
  expect(await chip(' enhancement ')).toMatchObject({ backgroundColor: '#a2eeef', color: '#000000' })
  expect((await ui.findAll({ type: 'Link' })).map(one => one.props)).toEqual([
    { href: 'https://github.com/acme/app/issues/7', label: '[ GitHub ↗ ]' },
  ])
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('## Goal\nBuild the login.\n\n- [x] form\n- [ ] errors')
  // The list, its search and its filters are away while an issue is read.
  expect([await ui.find({ key: 'search' }), await ui.find({ key: 'state-open' }), await ui.find({ key: 'pin-7' })]).toEqual([undefined, undefined, undefined])

  await ui.press({ key: 'back' })
  expect((await listed(ui)).slice(0, 2)).toEqual(['7', '5'])

  // An issue with nobody, no label and one line; the project button leaves it at once.
  await ui.press({ key: 'open-5' })
  expect(textsOf(await ui.drawn()).join('|')).toContain('Fix crash|Assignees|none|Labels|none|')
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Crash on start.')
  await ui.press({ key: 'project' })
  expect(textsOf(await ui.drawn())[0]).toBe('Select a project')
  await ui.unmount()
})

test('a long title opens its issue from its second line too', async ($, on) => {
  machine(on)
  await attach($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: 'open-7-more' })).toBe(undefined)
  await ui.press({ key: 'state-closed' })
  expect((await ui.find({ key: 'open-3-more' }))?.props.label).toBe('proper explanation')
  // One hover group for the two lines: the pointer on either lights both.
  expect(hoversOf(await ui.drawn()).filter(one => one.key.startsWith('open-3'))).toEqual([
    { key: 'open-3', hover: { scope: 'title-3', inverse: true } },
    { key: 'open-3-more', hover: { scope: 'title-3', inverse: true } },
  ])
  await ui.press({ key: 'open-3-more' })
  expect(textsOf(await ui.drawn()).slice(0, 2)).toEqual(['acme/app', '‹ Back'])
  await ui.unmount()
})

test('an issue the prompt names joins the ones worked on; a number that is no issue does not', async ($, on) => {
  on('prompt.submit', (_, e) => ({ text: e.text }))
  machine(on)
  await attach($)
  await $.prompt.submit({ text: 'look at #5 and #999', wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const hrefs = await listed(ui)

  // #7 by the branch, #5 by the prompt; #999 is no issue and marks nothing.
  expect(hrefs.slice(0, 2)).toEqual(['7', '5'])
  expect(textsOf(await ui.drawn()).filter(text => text.includes('working'))).toHaveLength(2)
  await ui.unmount()
})

test('with no GitHub access on the machine nothing is attached and no pane opens', async ($, on) => {
  const seen = machine(on, false)

  expect((await attach($)).text).toBe('This machine has no GitHub access to the issues of acme/app.')
  expect(seen.opened).toEqual([])
})

const ports = (over: Partial<Ports>): Ports => ({
  run: async () => ({ exitCode: 1, stdout: '' }),
  fetch: async () => ({ text: '' }),
  envToken: async () => undefined,
  list: async () => [],
  exists: async () => false,
  ...over,
})

const REQUEST: PageRequest = { first: 20, after: null, state: 'open', search: '', numbers: [] }

test('where gh is missing, the token git already stores reaches the API, and is never asked for', async () => {
  const sent: { url: string; authorization: string | undefined }[] = []
  const prompts: (Record<string, string> | undefined)[] = []
  const io = ports({
    run: async (argv, init) => {
      if (argv[0] === 'gh') throw new Error('gh: not found')
      prompts.push(init?.env)

      return { exitCode: 0, stdout: 'protocol=https\nhost=github.com\nusername=x\npassword=stored-token\n' }
    },
    fetch: async (url, init) => {
      sent.push({ url, authorization: init.headers.Authorization })

      return { text: github(init.body) }
    },
  })
  const page = await fetchPage(io, { host: 'github.com', owner: 'acme', name: 'via-token', root: '' }, REQUEST)

  expect('issues' in page && page.issues).toHaveLength(20)
  expect(sent[0]).toEqual({ url: 'https://api.github.com/graphql', authorization: 'Bearer stored-token' })
  expect(prompts[0]).toEqual({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '' })
})

test('a machine with neither gh nor a stored token has no access', async () => {
  const repo = { host: 'github.com', owner: 'acme', name: 'no-access', root: '' }

  expect(await connect(ports({}), repo)).toBe(undefined)
  expect(await fetchPage(ports({}), repo, REQUEST)).toEqual({ error: 'No GitHub access on this machine.' })
})

test('a server that refuses the project and sub-issue fields still answers the issues', async () => {
  const queries: string[] = []
  const io = ports({
    run: async (_, init) => {
      const body = init?.stdin ?? ''
      const { query } = JSON.parse(body) as { query: string }
      queries.push(query)
      const isRefused = query.includes('projectItems') || query.includes('subIssuesSummary')

      return { exitCode: isRefused ? 1 : 0, stdout: isRefused ? '{"errors":[{"message":"no such field"}]}' : github(body) }
    },
  })
  const page = await fetchPage(io, { host: 'ghe.example', owner: 'acme', name: 'old-server', root: '' }, REQUEST)

  expect('issues' in page && page.issues).toHaveLength(20)
  // The probe, then the full query, then one field set less each time.
  expect(queries).toHaveLength(4)
  expect(queries.map(query => [query.includes('projectItems'), query.includes('subIssuesSummary')])).toEqual([
    [false, false],
    [true, true],
    [false, true],
    [false, false],
  ])
})

test('a remote is read in every spelling git gives it', () => {
  const app = { host: 'github.com', owner: 'acme', name: 'app' }

  expect(parseRemote('git@github.com:acme/app.git')).toEqual(app)
  expect(parseRemote('https://github.com/acme/app')).toEqual(app)
  expect(parseRemote('ssh://git@github.com:22/acme/app.git')).toEqual(app)
  expect(parseRemote('https://token@ghe.example/acme/app.git/')).toEqual({ ...app, host: 'ghe.example' })
  expect(parseRemote('not a remote')).toBe(undefined)
})

test('completion comes from sub-issues, else the task list, else closing; else there is none', () => {
  const progress = (over: Node) => issueOf(node(1, over))?.progress

  expect(progress({ subIssuesSummary: { total: 4, completed: 1 }, body: '- [x] a' })).toEqual({ done: 1, total: 4, source: 'sub-issues' })
  expect(progress({ body: '- [x] a\n* [ ] b\n1. [X] c' })).toEqual({ done: 2, total: 3, source: 'checklist' })
  expect(progress({ state: 'CLOSED', body: '- [ ] a' })).toEqual({ done: 1, total: 1, source: 'closed' })
  expect(progress({ body: 'No criteria here.' })).toBe(null)
  expect(progress({ body: 'x', subIssuesSummary: undefined })).toBe(null)
  expect(checklistOf('text [x] not a task')).toEqual({ done: 0, total: 0 })
})

test('the status is the project one with its color, else open, closed or not planned', () => {
  const status = (over: Node) => issueOf(node(1, over))?.status

  expect(status({ projectItems: { nodes: [{ fieldValueByName: null }, { fieldValueByName: { name: 'Review', color: 'PINK' } }] } })).toEqual({ name: 'Review', color: '#db61a2' })
  expect(status({ projectItems: undefined })).toEqual({ name: 'Open', color: '#3fb950' })
  expect(status({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })).toEqual({ name: 'Not planned', color: '#9198a1' })
  expect(status({ state: 'CLOSED', stateReason: 'COMPLETED' })).toEqual({ name: 'Closed', color: '#ab7df8' })
})

test('an issue keeps its text without hidden comments, and its labels with a text color that reads on them', () => {
  const issue = issueOf(node(1, { body: '<!-- template -->\n## Summary\n\nCrash.', labels: { nodes: [{ name: 'odd', color: 'nope' }] } }))

  expect(issue?.body).toBe('## Summary\n\nCrash.')
  expect(issue?.labels).toEqual([{ name: 'odd', color: '#9198a1' }])
  expect([inkOn('#ffffff'), inkOn('#fbca04'), inkOn('#0e8a16'), inkOn('#000000')]).toEqual(['#000000', '#000000', '#ffffff', '#ffffff'])
})

test('a header keeps its width, and a footer draws the share done', () => {
  const issue = issueOf(node(12, { title: 'A very long title that will not fit the header' })) as Issue
  const header = headerOf(issue, 30)

  expect(header).toEqual({
    number: ' #12 ',
    title: 'A very long',
    gap: 5,
    status: 'Open',
    below: { title: 'title that will not fi…', gap: 1 },
  })
  // Both lines fill the header: a cell before the title, and the first leaves the status its four cells.
  expect([
    header.number.length + 1 + header.title.length + header.gap + header.status.length + 4,
    header.number.length + 1 + (header.below?.title.length ?? 0) + (header.below?.gap ?? 0),
  ]).toEqual([30, 30])
  expect(headerOf({ ...issue, title: 'Short' }, 30)).toEqual({ number: ' #12 ', title: 'Short', gap: 11, status: 'Open', below: null })
  expect(footerOf({ done: 1, total: 4, source: 'sub-issues' }, 8)).toEqual({ filled: '██', rest: '░░░░░░', label: ' 25% · 1/4 sub-issue' })
  expect(footerOf({ done: 1, total: 1, source: 'closed' }, 4).label).toBe(' 100% closed')
})

test('the session works on the issues its texts and its branch name', () => {
  const repo = { host: 'github.com', owner: 'acme', name: 'app', root: '' }

  expect(refsIn('fix #12, see (#7) and acme/app/issues/30; color #ff0000 and other/repo#4', repo)).toEqual([12, 7, 30])
  expect(refsIn('gh issue view 242 --comments', repo)).toEqual([242])
  expect([branchRef('feat/242-discount'), branchRef('issue-9'), branchRef('docs/privacy-2026-10'), branchRef('main')]).toEqual([242, 9, undefined, undefined])
  expect(dirOf({ file_path: 'C:\\work\\app\\src\\a.ts' })).toBe('C:\\work\\app\\src')
  expect(dirOf({ command: 'git -C "/work/my app" status' })).toBe('/work/my app')
  expect(dirOf({ command: 'ls' })).toBe(undefined)
})

test('pinned issues lead and pass the filters', () => {
  const issues = [LOGIN, CRASH, OLD].flatMap(one => issueOf(one) ?? [])
  const filter: Filter = { state: 'open', status: '', isMine: false, isPinnedOnly: false }
  const view = { pinned: [3], working: [5], search: '', viewer: 'me', filter }
  const numbers = (list: Issue[]) => list.map(issue => issue.number)

  expect(numbers(visible(issues, view))).toEqual([3, 5, 7])
  expect(numbers(visible(issues, { ...view, filter: { ...view.filter, isMine: true } }))).toEqual([3, 7])
  expect(numbers(visible(issues, { ...view, filter: { ...view.filter, status: 'In Progress' } }))).toEqual([3, 7])
  expect(numbers(visible(issues, { ...view, search: 'crash' }))).toEqual([5])
  expect(numbers(visible(issues, { ...view, filter: { ...view.filter, isPinnedOnly: true } }))).toEqual([3])
})
