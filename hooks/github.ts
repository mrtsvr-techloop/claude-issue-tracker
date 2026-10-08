import type { Ports } from './ports'

import type { Filter, Issue, Repo } from '../types'
import type { Choice } from './model'
import { issueOf, slugOf } from './model'

type Bag = Record<string, unknown>
type Reply = { data?: Bag | null; errors?: unknown[] }
/** One way of reaching GitHub's GraphQL API with the access the machine holds. */
type Transport = (body: string) => Promise<Reply | undefined>

export type Page = {
  issues: Issue[]
  /** The issues asked for by number that exist. */
  named: Issue[]
  cursor: string | null
  hasMore: boolean
  total: number
  viewer: string
}

export type PageRequest = {
  first: number
  after: string | null
  state: Filter['state']
  search: string
  /** Issues to fetch by number beside the page: pinned ones, ones the session names. */
  numbers: number[]
}

const TIMEOUT_MS = 20_000
const NO_ACCESS = 'No GitHub access on this machine.'
const MAX_NAMED = 20

const isBag = (value: unknown): value is Bag =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parse = (text: string): Reply | undefined => {
  try {
    const reply: unknown = JSON.parse(text)

    return isBag(reply) ? reply : undefined
  } catch {
    return undefined
  }
}

/** The `gh` CLI with whatever login or token it holds; it keeps the credential to itself. */
const viaGh =
  (io: Ports, host: string): Transport =>
  async body => {
    const ran = await io.run(['gh', 'api', 'graphql', '--hostname', host, '--input', '-'], {
      stdin: body,
      timeoutMs: TIMEOUT_MS,
    })

    // gh exits non-zero on a partial answer too: the answer is what counts.
    return parse(ran.stdout)
  }

const endpointOf = (host: string): string =>
  host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`

const viaToken =
  (io: Ports, host: string, token: string): Transport =>
  async body => {
    const answer = await io.fetch(endpointOf(host), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'issue-tracker-mod',
      },
      body,
    })

    return parse(answer.text)
  }

/**
 * A token the machine already holds for the host: the environment's, else the
 * one git's credential helper stores. Never asks: a helper that would prompt
 * is told not to, and answers nothing.
 */
const tokenFor = async (io: Ports, host: string): Promise<string | undefined> => {
  const fromEnv = await io.envToken()

  if (host === 'github.com' && fromEnv) {
    return fromEnv
  }

  const ran = await io.run(['git', 'credential', 'fill'], {
    stdin: `protocol=https\nhost=${host}\n\n`,
    env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '' },
    timeoutMs: TIMEOUT_MS,
  })
  const [, password] = /^password=(.+)$/m.exec(ran.stdout) ?? []

  return ran.exitCode === 0 ? password?.trim() : undefined
}

const PROBE = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){hasIssuesEnabled}}'

const transports = new Map<string, Transport>()

/**
 * The first way this machine reaches the repository's issues, or undefined
 * when it has none. SSH keys alone reach the code, not the issues API.
 */
export const connect = async (io: Ports, repo: Repo): Promise<Transport | undefined> => {
  const key = `${repo.host}/${slugOf(repo)}`
  const held = transports.get(key)

  if (held) {
    return held
  }

  const probe = JSON.stringify({ query: PROBE, variables: { owner: repo.owner, name: repo.name } })
  const candidates: (() => Promise<Transport | undefined>)[] = [
    async () => viaGh(io, repo.host),
    async () => {
      const token = await tokenFor(io, repo.host)

      return token ? viaToken(io, repo.host, token) : undefined
    },
  ]

  for (const candidate of candidates) {
    try {
      const transport = await candidate()
      const repository = (await transport?.(probe))?.data?.repository

      if (transport && isBag(repository) && repository.hasIssuesEnabled === true) {
        transports.set(key, transport)

        return transport
      }
    } catch {
      // This way is not available on the machine: the next one is tried.
    }
  }

  return undefined
}

/** The fields asked of an issue, fewer at each level a server refuses. */
const fragmentAt = (level: number): string =>
  [
    'fragment I on Issue{id number title url state stateReason body updatedAt',
    'assignees(first:5){nodes{login}} labels(first:10){nodes{name color}}',
    level < 2 ? 'subIssuesSummary{total completed}' : '',
    level < 1
      ? 'projectItems(first:3){nodes{id project{id field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name color}}}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name color}}}}'
      : '',
    '}',
  ].join(' ')

const STATES: Record<Filter['state'], string[] | null> = { open: ['OPEN'], closed: ['CLOSED'], all: null }
const QUALIFIERS: Record<Filter['state'], string> = { open: ' is:open', closed: ' is:closed', all: '' }

const queryFor = (request: PageRequest, level: number): string => {
  const isSearch = request.search.trim().length > 0
  const named = request.numbers.map(number => `n${number}:issue(number:${number}){...I}`).join(' ')
  const page = 'totalCount pageInfo{hasNextPage endCursor} nodes{...I}'
  const list = isSearch
    ? `search(query:$q,type:ISSUE,first:$first,after:$after){issueCount pageInfo{hasNextPage endCursor} nodes{... on Issue{...I}}}`
    : ''
  const issues = isSearch
    ? ''
    : `issues(first:$first,after:$after,states:$states,orderBy:{field:UPDATED_AT,direction:DESC}){${page}}`
  const variables = isSearch ? '$q:String!' : '$states:[IssueState!]'

  return [
    `query($owner:String!,$name:String!,$first:Int!,$after:String,${variables}){`,
    'viewer{login}',
    `repository(owner:$owner,name:$name){hasIssuesEnabled ${issues} ${named}}`,
    list,
    '}',
    fragmentAt(level),
  ].join(' ')
}

/** The field level a host took last, so a refused field is asked once. */
const levels = new Map<string, number>()

/** One page of the repository's issues, or the reason there is none. */
export const fetchPage = async (
  io: Ports,
  repo: Repo,
  asked: PageRequest,
): Promise<Page | { error: string }> => {
  const transport = await connect(io, repo)

  if (!transport) {
    return { error: NO_ACCESS }
  }

  const request = { ...asked, numbers: asked.numbers.slice(0, MAX_NAMED) }
  const text = request.search.trim()
  const variables = {
    owner: repo.owner,
    name: repo.name,
    first: request.first,
    after: request.after,
    ...(text.length > 0
      ? { q: `repo:${slugOf(repo)} is:issue sort:updated-desc${QUALIFIERS[request.state]} ${text}` }
      : { states: STATES[request.state] }),
  }

  for (let level = levels.get(repo.host) ?? 0; level <= 2; level += 1) {
    let reply: Reply | undefined

    try {
      reply = await transport(JSON.stringify({ query: queryFor(request, level), variables }))
    } catch {
      return { error: 'GitHub does not answer.' }
    }

    const data = reply?.data
    const repository = isBag(data) ? data.repository : undefined

    if (!isBag(data) || !isBag(repository)) {
      // No data at all: the server refused a field of this level.
      continue
    }

    levels.set(repo.host, level)
    const list = text.length > 0 ? data.search : repository.issues
    const pageInfo = isBag(list) && isBag(list.pageInfo) ? list.pageInfo : {}
    const nodes = isBag(list) && Array.isArray(list.nodes) ? list.nodes : []

    return {
      issues: nodes.flatMap(node => issueOf(node) ?? []),
      named: request.numbers.flatMap(number => issueOf(repository[`n${number}`]) ?? []),
      cursor: typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null,
      hasMore: pageInfo.hasNextPage === true,
      total: isBag(list) ? Number(list.totalCount ?? list.issueCount ?? nodes.length) : nodes.length,
      viewer: isBag(data.viewer) && typeof data.viewer.login === 'string' ? data.viewer.login : '',
    }
  }

  return { error: 'GitHub refused the request.' }
}

const MOVE =
  'mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}'
const CLOSE = 'mutation($id:ID!,$reason:IssueClosedStateReason){closeIssue(input:{issueId:$id,stateReason:$reason}){issue{id}}}'
const REOPEN = 'mutation($id:ID!){reopenIssue(input:{issueId:$id}){issue{id}}}'

/** Gives the issue the status chosen, on GitHub. Resolves the reason when it did not take. */
export const setStatus = async (io: Ports, repo: Repo, issue: Issue, choice: Choice): Promise<string | null> => {
  const transport = await connect(io, repo)

  if (!transport) {
    return NO_ACCESS
  }

  const { board } = issue
  const body =
    'optionId' in choice
      ? board && {
          query: MOVE,
          variables: { project: board.projectId, item: board.itemId, field: board.fieldId, option: choice.optionId },
        }
      : choice.state === 'OPEN'
        ? { query: REOPEN, variables: { id: issue.id } }
        : { query: CLOSE, variables: { id: issue.id, reason: choice.state } }

  if (!body) {
    return 'This issue has no project status to change.'
  }

  try {
    const reply = await transport(JSON.stringify(body))
    const [failure] = reply?.errors ?? []

    if (failure === undefined && isBag(reply?.data)) {
      return null
    }

    return isBag(failure) && typeof failure.message === 'string' ? failure.message : 'GitHub refused the change.'
  } catch {
    return 'GitHub does not answer.'
  }
}
