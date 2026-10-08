import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Feed, Filter, Issue, Repo } from '../types'
import { connect, fetchPage, setStatus } from './github'
import type { Choice } from './model'
import {
  branchRef,
  choicesOf,
  chosen,
  footerOf,
  headerOf,
  inkOn,
  isSameRepo,
  merged,
  parseSlug,
  refsIn,
  slugOf,
  statusesOf,
  visible,
} from './model'
import type { Ports } from './ports'
import { branchOf, dirOf, locate, locateChildren } from './project'
import { ROLL_CALL_MS, readSignal, signalOf } from './mod-signals/kit/signals'
import type { Announce, SignalKind } from './mod-signals/kit/signals'

const PANE = 'issues'
const COMMAND = 'issues'
/** Issues asked of GitHub at a time: the next page comes when the list's end is near. */
const PAGE = 20
/** The most a refresh asks again: the newest changes of the loaded list. */
const MAX_REFRESH = 50
const REFRESH_MS = 60_000
const PANE_COLUMNS = 46
/** Rows from the list's end at which a scroll loads the next page. */
const NEAR_END_ROWS = 6
/** The pin, one cell, set against the header it belongs to. */
const PIN_COLUMNS = 1
const PINNED = '●'
const LOOSE = '○'
/** Where a card's lines under the header start: under its number. */
const INDENT = 2
const HEADER = { backgroundColor: '#3a3a3a', color: '#e4e4e4' }
/** A pinned card's header: dark, as a Button draws its label light and takes no color. */
const PINNED_HEADER = { backgroundColor: '#0d2f6b', color: '#e4e4e4' }
/** The issue number's own block, white on every card. */
const NUMBER = { backgroundColor: '#ffffff', color: '#000000' }
const BAR_COLUMNS = 10
/** The block behind the search field. */
const SEARCH_FIELD = '#30363d'
/** The lower and the upper half of a cell: the field's edge, with half a row left empty beyond it. */
const HALF_BELOW = '▄'
const HALF_ABOVE = '▀'
/**
 * A filter's block: blue while it narrows the list, grey while it does not.
 * Both dark enough for the label, whose color a Button does not let a mod set.
 */
const FILTER_ON = '#1f6feb'
const FILTER_OFF = '#3a3a3a'
/** Cells the project button leaves on its row: its brackets and the Back beside it. */
const PROJECT_ROOM = 10

const EMPTY_FEED: Feed = {
  issues: [],
  cursor: null,
  hasMore: false,
  total: 0,
  isLoading: false,
  error: null,
  viewer: '',
  query: '',
}
const NO_FILTER: Filter = { state: 'open', status: '', isMine: false, isPinnedOnly: false }
const STATES: readonly { state: Filter['state']; label: string }[] = [
  { state: 'open', label: 'Open' },
  { state: 'closed', label: 'Closed' },
  { state: 'all', label: 'All' },
]

const repo = atom({ plugin: 'issue-tracker', key: 'repo' } as const, null)
const candidates = atom({ plugin: 'issue-tracker', key: 'candidates' } as const, [])
const access = atom({ plugin: 'issue-tracker', key: 'access' } as const, 'unknown')
const feed = atom({ plugin: 'issue-tracker', key: 'feed' } as const, EMPTY_FEED)
const search = atom({ plugin: 'issue-tracker', key: 'search' } as const, '')
const filter = atom({ plugin: 'issue-tracker', key: 'filter' } as const, NO_FILTER)
const pinned = atom({ plugin: 'issue-tracker', key: 'pinned' } as const, [])
const working = atom({ plugin: 'issue-tracker', key: 'working' } as const, [])
const isChoosing = atom({ plugin: 'issue-tracker', key: 'isChoosing' } as const, false)
const editing = atom({ plugin: 'issue-tracker', key: 'editing' } as const, null)
const viewing = atom({ plugin: 'issue-tracker', key: 'viewing' } as const, null)

/** The machine as the adapters reach it: processes, HTTP, environment, files. */
const portsOf = ($: EngineInterface): Ports => ({
  run: (argv, init) => $.process.run(argv, init),
  fetch: (url, init) => $.http.fetch(url, init),
  envToken: async () => (await $.env.get('GH_TOKEN')) ?? (await $.env.get('GITHUB_TOKEN')),
  list: dir => $.fs.list(dir),
  exists: path => $.fs.exists(path),
})

const pinsKey = (one: Repo): string => `pins:${one.host}/${slugOf(one)}`.toLowerCase()

const asNumbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((one): one is number => typeof one === 'number') : []

const isPaneOpen = async ($: EngineInterface): Promise<boolean> =>
  (await $.ui.panes()).some(pane => pane.id === PANE)

/** The mod's name as the engine gives it: the `to` of the commands it obeys. */
const MOD = 'issue-tracker'
const SELF: Announce = { title: 'Issues', accepts: ['open', 'close', 'toggle'], emits: ['opened', 'closed', 'notify'] }

const signal = atom({ plugin: 'issue-tracker', key: 'signal' } as const, null)
const sent = { count: 0, answeredAt: 0 }

/** One signal to whoever listens; a mod above that refuses the write stops nothing here. */
const emit = async (
  $: EngineInterface,
  kind: SignalKind,
  name: string,
  data?: Record<string, unknown>,
  tags?: string[],
): Promise<void> => {
  sent.count += 1

  try {
    await update($, signal, () => signalOf(kind, name, sent.count, Date.now(), { ...(data === undefined ? {} : { data }), ...(tags === undefined ? {} : { tags }) }))
  } catch {
    // The mod goes on without the signal.
  }
}

/** Opens the pane, and says so where it was closed. */
const openPane = async ($: EngineInterface): Promise<void> => {
  const wasOpen = await isPaneOpen($)
  await $.ui.open({ id: PANE, title: 'Issues', columns: PANE_COLUMNS })

  if (!wasOpen) {
    await emit($, 'event', 'opened')
  }
}

/** Closes the pane, and says so where it was open; answers whether it is open still. */
const closePane = async ($: EngineInterface): Promise<boolean> => {
  const wasOpen = await isPaneOpen($)
  await $.ui.close({ id: PANE })
  const isOpen = await isPaneOpen($)

  if (wasOpen && !isOpen) {
    await emit($, 'event', 'closed')
  }

  return isOpen
}

/** One load at a time: a second ask while one runs is dropped, the next tick asks again. */
let isBusy = false

/**
 * Loads issues for the attached repository: `reset` the first page anew,
 * `more` the page after the last, `refresh` the newest changes over the list.
 */
const load = async ($: EngineInterface, mode: 'reset' | 'more' | 'refresh'): Promise<void> => {
  const attached = await read($, repo)
  const held = await read($, feed)

  if (attached === null || isBusy || (await read($, access)) !== 'granted' || (mode === 'more' && !held.hasMore)) {
    return
  }

  isBusy = true

  try {
    const text = mode === 'reset' ? await read($, search) : held.query
    const marks = [...new Set([...(await read($, pinned)), ...(await read($, working))])]
    const known = new Set(mode === 'reset' ? [] : held.issues.map(issue => issue.number))
    await update($, feed, one => ({ ...one, isLoading: true }))
    const page = await fetchPage(portsOf($), attached, {
      first: mode === 'refresh' ? Math.min(MAX_REFRESH, Math.max(PAGE, held.issues.length)) : PAGE,
      after: mode === 'more' ? held.cursor : null,
      state: (await read($, filter)).state,
      search: text,
      numbers: marks.filter(number => !known.has(number)),
    })

    if (!isSameRepo(attached, await read($, repo))) {
      return
    }

    if ('error' in page) {
      await update($, feed, one => ({ ...one, isLoading: false, error: page.error }))

      return
    }

    const fresh = [...page.issues, ...page.named]
    await update($, feed, one => ({
      issues: mode === 'reset' ? merged([], fresh) : merged(one.issues, fresh),
      // A refresh re-reads the head of the list: where the next page starts stays.
      cursor: mode === 'refresh' && one.issues.length > 0 ? one.cursor : page.cursor,
      hasMore: mode === 'refresh' && one.issues.length > 0 ? one.hasMore : page.hasMore,
      total: page.total,
      isLoading: false,
      error: null,
      viewer: page.viewer,
      query: text,
    }))
    // A number the session named that is no issue of this repository is let go.
    const real = new Set((await read($, feed)).issues.map(issue => issue.number))
    await update($, working, list => list.filter(number => real.has(number)))
  } finally {
    isBusy = false
  }
}

const remember = async ($: EngineInterface, found: Repo): Promise<void> => {
  await update($, candidates, list => (list.some(one => isSameRepo(one, found)) ? list : [...list, found]))
}

/**
 * Makes `found` the repository shown, when this machine reaches its issues;
 * without that access nothing is fetched and no pane opens.
 */
const attach = async ($: EngineInterface, found: Repo, isAsked: boolean): Promise<boolean> => {
  await remember($, found)
  const isReached = (await connect(portsOf($), found)) !== undefined

  if (!isReached) {
    if ((await read($, repo)) === null) {
      await update($, access, () => 'none')
    }

    return false
  }

  const branch = branchRef(await branchOf(portsOf($), found))
  await update($, repo, () => found)
  await update($, access, () => 'granted')
  await update($, isChoosing, () => false)
  await update($, editing, () => null)
  await update($, viewing, () => null)
  await update($, feed, () => EMPTY_FEED)
  await update($, search, () => '')
  const stored = asNumbers(await $.store.get(pinsKey(found)))
  await update($, pinned, () => stored)
  await update($, working, () => (branch === undefined ? [] : [branch]))
  await load($, 'reset')

  // Unasked, the surface seats the pane only where it has the room for it.
  if (isAsked || !(await isPaneOpen($))) {
    await openPane($)
  }

  return true
}

/** Notes the issues a text names and the repository a path sits in. */
const notice = async ($: EngineInterface, text: string, dir: string | undefined): Promise<void> => {
  if (dir !== undefined) {
    const found = await locate(portsOf($), dir)

    if (found) {
      await ((await read($, repo)) === null ? attach($, found, false) : remember($, found))
    }
  }

  const attached = await read($, repo)

  if (attached === null) {
    return
  }

  const held = await read($, working)
  const named = refsIn(text, attached).filter(number => !held.includes(number))

  if (named.length > 0) {
    await update($, working, list => [...new Set([...list, ...named])])
    await load($, 'refresh')
  }
}

const togglePin = async ($: EngineInterface, number: number): Promise<void> => {
  const attached = await read($, repo)
  await update($, pinned, list =>
    list.includes(number) ? list.filter(one => one !== number) : [...list, number],
  )

  if (attached !== null) {
    await $.store.set(pinsKey(attached), await read($, pinned))
  }
}

/** Shows one issue in full in place of the list. */
const openIssue = async ($: EngineInterface, number: number): Promise<void> => {
  await update($, editing, () => null)
  await update($, viewing, () => number)
}

const setFilter = async ($: EngineInterface, change: Partial<Filter>): Promise<void> => {
  const before = await read($, filter)
  await update($, filter, one => ({ ...one, ...change }))

  // The state is asked of the server: the list starts over. The rest filters what is loaded.
  if (change.state !== undefined && change.state !== before.state) {
    await load($, 'reset')
  }
}

/** The person's pick of a status: shown at once, written to GitHub, then read back. */
const changeStatus = async ($: EngineInterface, issue: Issue, choice: Choice): Promise<void> => {
  const attached = await read($, repo)
  await update($, editing, () => null)

  if (attached === null) {
    return
  }

  await update($, feed, one => ({
    ...one,
    issues: one.issues.map(held => (held.number === issue.number ? chosen(held, choice) : held)),
  }))
  const failure = await setStatus(portsOf($), attached, issue, choice)
  await load($, 'refresh')

  if (failure !== null) {
    await update($, feed, one => ({ ...one, error: failure }))
  }
}

const hasProject = async ($: EngineInterface): Promise<boolean> =>
  (await read($, repo)) !== null || (await read($, candidates)).length > 0

/** Opens the pane on fresh issues; false, and nothing opened, with no project to show. */
const show = async ($: EngineInterface): Promise<boolean> => {
  if (!(await hasProject($))) {
    return false
  }

  await load($, 'refresh')
  await openPane($)

  return true
}

/** A command another mod sent: what the person could do with `/issues`, and no more. */
const obey = async ($: EngineInterface, name: string): Promise<void> => {
  if (name === 'close') {
    await $.issues.close()

    return
  }

  if (name !== 'open' && name !== 'toggle') {
    return
  }

  const wasOpen = await $.issues.isOpen()
  const isOpen = name === 'open' ? await $.issues.open() : await $.issues.toggle()

  if (!wasOpen && !isOpen) {
    await emit($, 'event', 'notify', { text: 'No project yet. Use /issues attach <path or owner/name>.' }, ['warning'])
  }
}

export const register: Register = on => {
  // Mod Signals: every signal, whoever writes it. The write goes on first and
  // untouched; the mod answers a roll-call and obeys the commands sent to it.
  on('state.set', { key: 'signal' }, async ($, e, next) => {
    const done = await next(e)
    const heard = done.value?.isSet === true ? readSignal(e.value) : null

    if (heard?.kind === 'event' && heard.name === 'roll-call' && Date.now() - sent.answeredAt >= ROLL_CALL_MS) {
      sent.answeredAt = Date.now()
      await emit($, 'announce', 'announce', SELF)
    }

    if (heard?.kind === 'command' && heard.to === MOD) {
      await obey($, heard.name)
    }

    return done
  }).catch((_, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the project issues pane; "attach <path or owner/name>", "toggle" or "close"',
      argumentHint: '[attach <path|owner/name> | toggle | close]',
    })
    await emit($, 'announce', 'announce', SELF)

    try {
      const cwd = await $.session.cwd()
      const here = await locate(portsOf($), cwd)

      if (here) {
        await attach($, here, false)
      } else {
        // Launched outside a project: the working copies beside it are offered,
        // and the first one the session touches is attached.
        for (const child of await locateChildren(portsOf($), cwd)) {
          await remember($, child)
        }
      }
    } catch {
      // No project yet: the tool calls of the session may name one.
    }

    $.clock.every(REFRESH_MS, () => {
      void isPaneOpen($).then(isOpen => (isOpen ? load($, 'refresh') : undefined))
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const target = rest.join(' ')

    // The command is one caller of the mod's API among others.
    if (verb === 'close') {
      await $.issues.close()

      return { text: 'Issue pane closed.' }
    }

    if (verb === 'toggle') {
      return { text: (await $.issues.toggle()) ? 'Issue pane opened.' : 'Issue pane closed.' }
    }

    if (verb === 'attach' && target.length > 0) {
      const named = parseSlug(target)
      const found = named ? { ...named, root: '' } : await locate(portsOf($), target)

      if (!found) {
        return { text: `No GitHub repository found at ${target}.` }
      }

      return (await attach($, found, true))
        ? { text: `Issues of ${slugOf(found)} attached.` }
        : { text: `This machine has no GitHub access to the issues of ${slugOf(found)}.` }
    }

    return { text: (await $.issues.open()) ? 'Issue pane opened.' : 'No project yet. Use "/issues attach <path or owner/name>".' }
  })

  // The mod's API: `$.issues` for any other mod, the pane driven with no command typed.
  on('engine.create', async ($, e, next) => ({
    ...(await next(e)),
    // Each is answered by its hook below; alone, a method says the pane is closed.
    issues: { open: async () => false, close: async () => false, toggle: async () => false, isOpen: async () => false },
  }))

  on('issues.isOpen', async $ => ({ value: await isPaneOpen($) }))

  on('issues.open', async $ => ({ value: await show($) }))

  on('issues.close', async $ => ({ value: await closePane($) }))

  on('issues.toggle', async $ => {
    return { value: (await isPaneOpen($)) ? await closePane($) : await show($) }
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      await notice($, e.text, undefined)
    } catch {
      // The prompt goes on whatever the pane could not learn from it.
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    try {
      const input: Record<string, unknown> = { ...e }
      await notice($, typeof input.command === 'string' ? input.command : '', dirOf(input))
    } catch {
      // The call's answer stands whatever the pane could not learn from it.
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    try {
      if (await isPaneOpen($)) {
        await load($, 'refresh')
      }
    } catch {
      // The turn ends whatever the refresh met.
    }

    return next(e)
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)

    // An issue read in full is no list: its end asks for nothing.
    if ((await read($, viewing)) === null && e.offset + e.bodyRows >= e.contentRows - NEAR_END_ROWS) {
      await load($, 'more')
    }

    return moved
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Link, Markdown, Text } = elements
    // A surface with no text field lists and filters without the search.
    const Input = 'Input' in elements ? elements.Input : undefined
    const attached = await read($, repo)
    const width = e.props.bodyColumns

    if (attached === null || (await read($, isChoosing))) {
      const found = await read($, candidates)

      return (
        <Box flexDirection="column">
          <Text bold>Select a project</Text>
          {(await read($, access)) === 'none' && (
            <Text dimColor>No GitHub access on this machine for its issues.</Text>
          )}
          {found.length === 0 && <Text dimColor>{'No git project found. /issues attach <path or owner/name>'}</Text>}
          {found.map(one => (
            <Button
              key={`repo-${slugOf(one)}`}
              plain
              label={`${isSameRepo(one, attached) ? '● ' : '  '}${slugOf(one)}`}
              onPress={() => (isSameRepo(one, attached) ? update($, isChoosing, () => false) : attach($, one, true))}
            />
          ))}
          {attached !== null && (
            <Box marginTop={1}>
              <Button key="cancel" plain dimColor label="Cancel" onPress={() => update($, isChoosing, () => false)} />
            </Box>
          )}
        </Box>
      )
    }

    const held = await read($, feed)
    const marks = { pinned: await read($, pinned), working: await read($, working) }

    const view = { ...marks, search: await read($, search), filter: await read($, filter), viewer: held.viewer }
    const shown = visible(held.issues, view)
    const statuses = statusesOf(held.issues)
    const nextStatus = statuses[statuses.indexOf(view.filter.status) + 1] ?? ''
    const open = await read($, editing)
    const cardColumns = Math.max(16, width - PIN_COLUMNS)
    const slug = slugOf(attached)
    const isNarrowed =
      view.search.trim() !== held.query.trim() ||
      view.filter.status.length > 0 ||
      view.filter.isMine ||
      view.filter.isPinnedOnly

    const viewed = await read($, viewing)
    const detail = viewed === null ? undefined : held.issues.find(issue => issue.number === viewed)
    // Leads both views, so the selection is one press away from either.
    const project = (
      <Button
        key="project"
        variant="primary"
        label={slug.length > width - PROJECT_ROOM ? `…${slug.slice(PROJECT_ROOM - width + 1)}` : slug}
        onPress={() => update($, isChoosing, () => true)}
      />
    )

    if (detail) {
      const footer = detail.progress === null ? null : footerOf(detail.progress, BAR_COLUMNS)

      return (
        <Box flexDirection="column">
          <Box columnGap={1}>
            {project}
            <Button key="back" variant="secondary" label="‹ Back" onPress={() => update($, viewing, () => null)} />
          </Box>
          <Box marginTop={1}>
            <Text {...NUMBER} bold>{` #${detail.number} `}</Text>
            <Text color={detail.status.color}>{' ●'}</Text>
            <Text>{` ${detail.status.name}`}</Text>
          </Box>
          <Text bold>{detail.title}</Text>
          <Box marginTop={1} flexWrap="wrap" columnGap={1}>
            <Text dimColor>Assignees</Text>
            {detail.assignees.length === 0 && <Text dimColor>none</Text>}
            {detail.assignees.map(login => (
              <Text>{`@${login}`}</Text>
            ))}
          </Box>
          <Box flexWrap="wrap" columnGap={1}>
            <Text dimColor>Labels</Text>
            {detail.labels.length === 0 && <Text dimColor>none</Text>}
            {detail.labels.map(label => (
              <Text backgroundColor={label.color} color={inkOn(label.color)}>{` ${label.name} `}</Text>
            ))}
          </Box>
          {footer !== null && (
            <Box>
              <Text color="success">{footer.filled}</Text>
              <Text dimColor>
                {footer.rest}
                {footer.label}
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Link href={detail.url} label="[ GitHub ↗ ]" />
          </Box>
          <Box marginTop={1}>
            {detail.body.length > 0 ? <Markdown text={detail.body} /> : <Text dimColor>No description</Text>}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {/* The body's first row, at its left: the frame's own row clips what a mod draws on it. */}
        <Box>{project}</Box>
        {/* Half a row each side of the field: a whole empty row is the least a margin gives, and reads as too much. */}
        {Input && <Text color={SEARCH_FIELD}>{HALF_BELOW.repeat(width)}</Text>}
        {Input && (
          <Box backgroundColor={SEARCH_FIELD} paddingX={1}>
          <Input
            key="search"
            placeholder="Search issues…"
            value={view.search}
            onInput={async (value: string) => {
              await update($, search, () => value)

              if (value.trim().length === 0 && (await read($, feed)).query.length > 0) {
                await load($, 'reset')
              }
            }}
            onSubmit={async (value: string) => {
              await update($, search, () => value)
              await load($, 'reset')
            }}
          />
          </Box>
        )}
        {Input && <Text color={SEARCH_FIELD}>{HALF_ABOVE.repeat(width)}</Text>}
        <Box flexWrap="wrap" columnGap={1}>
          {[
            ...STATES.map(one => ({
              key: `state-${one.state}`,
              label: one.label,
              isOn: view.filter.state === one.state,
              press: () => setFilter($, { state: one.state }),
            })),
            { key: 'mine', label: 'Assigned', isOn: view.filter.isMine, press: () => setFilter($, { isMine: !view.filter.isMine }) },
            {
              key: 'pinned-only',
              label: 'Pinned',
              isOn: view.filter.isPinnedOnly,
              press: () => setFilter($, { isPinnedOnly: !view.filter.isPinnedOnly }),
            },
            {
              key: 'status',
              label: `Status: ${view.filter.status.length > 0 ? view.filter.status : 'any'}`,
              isOn: view.filter.status.length > 0,
              press: () => setFilter($, { status: nextStatus }),
            },
          ].map(chip => (
            // The block says whether the filter is on; a Button takes no color of its own.
            <Box backgroundColor={chip.isOn ? FILTER_ON : FILTER_OFF}>
              <Button key={chip.key} plain label={chip.label} onPress={chip.press} />
            </Box>
          ))}
        </Box>
        {held.error !== null && <Text color="error">{held.error}</Text>}
        <Text dimColor>
          {isNarrowed ? `${shown.length} of ${held.total} issues` : `${held.total} issues`}
          {held.isLoading ? ' · loading…' : ''}
        </Text>
        {shown.map(issue => {
          const isPinned = marks.pinned.includes(issue.number)
          const style = isPinned ? PINNED_HEADER : HEADER
          const header = headerOf(issue, cardColumns)
          const footer = issue.progress === null ? null : footerOf(issue.progress, BAR_COLUMNS)
          // A title on two lines is one control: the pointer on either line lights both.
          const lit = { scope: `title-${issue.number}`, inverse: true }

          return (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Button
                  key={`pin-${issue.number}`}
                  plain
                  dimColor={!isPinned}
                  label={isPinned ? PINNED : LOOSE}
                  onPress={() => togglePin($, issue.number)}
                />
                <Text {...NUMBER} bold>
                  {header.number}
                </Text>
                <Text {...style}> </Text>
                {/* A Button takes no background: the Box around it carries the header's across it. */}
                <Box backgroundColor={style.backgroundColor}>
                  <Button key={`open-${issue.number}`} plain hover={lit} label={header.title} onPress={() => openIssue($, issue.number)} />
                </Box>
                <Text {...style}>{' '.repeat(header.gap + 1)}</Text>
                <Box backgroundColor={style.backgroundColor}>
                  <Button
                    key={`status-${issue.number}`}
                    plain
                    dimColor={open !== issue.number}
                    label={header.status}
                    onPress={() => update($, editing, held => (held === issue.number ? null : issue.number))}
                  />
                </Box>
                <Text {...style}> </Text>
                <Text backgroundColor={style.backgroundColor} color={issue.status.color}>
                  ●
                </Text>
                <Text {...style}> </Text>
              </Box>
              {header.below !== null && (
                <Box marginLeft={PIN_COLUMNS}>
                  <Text {...style}>{' '.repeat(header.number.length + 1)}</Text>
                  <Box backgroundColor={style.backgroundColor}>
                    <Button
                      key={`open-${issue.number}-more`}
                      plain
                      hover={lit}
                      label={header.below.title}
                      onPress={() => openIssue($, issue.number)}
                    />
                  </Box>
                  <Text {...style}>{' '.repeat(header.below.gap)}</Text>
                </Box>
              )}
              {open === issue.number && (
                <Box marginLeft={INDENT} flexWrap="wrap" columnGap={2}>
                  {choicesOf(issue).map((choice, index) => (
                    <Box>
                      <Text color={choice.color}>● </Text>
                      <Button
                        key={`set-${issue.number}-${index}`}
                        plain
                        dimColor={choice.name === issue.status.name}
                        label={choice.name}
                        onPress={() => changeStatus($, issue, choice)}
                      />
                    </Box>
                  ))}
                </Box>
              )}
              {footer !== null && (
                <Box marginLeft={INDENT}>
                  <Text color="success">{footer.filled}</Text>
                  <Text dimColor>
                    {footer.rest}
                    {footer.label}
                    {marks.working.includes(issue.number) ? ' · working' : ''}
                  </Text>
                </Box>
              )}
              {footer === null && marks.working.includes(issue.number) && (
                <Box marginLeft={INDENT}>
                  <Text dimColor>working</Text>
                </Box>
              )}
            </Box>
          )
        })}
        {held.hasMore && (
          <Box marginTop={1}>
            <Button key="more" plain label="Load more…" onPress={() => load($, 'more')} />
          </Box>
        )}
      </Box>
    )
  })
}
