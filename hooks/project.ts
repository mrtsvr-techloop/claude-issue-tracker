import type { Ports } from './ports'

import type { Repo } from '../types'
import { parseRemote } from './model'

const TIMEOUT_MS = 10_000

const git = async (io: Ports, dir: string, ...args: string[]): Promise<string | undefined> => {
  try {
    const ran = await io.run(['git', '-C', dir, ...args], { timeoutMs: TIMEOUT_MS })

    return ran.exitCode === 0 ? ran.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** The directories already asked about, so a path is located once. */
const located = new Map<string, Repo | undefined>()

/** The repository whose working copy holds `dir`, by its `origin` or first remote. */
export const locate = async (io: Ports, dir: string): Promise<Repo | undefined> => {
  if (located.has(dir)) {
    return located.get(dir)
  }

  const root = await git(io, dir, 'rev-parse', '--show-toplevel')
  const remote = root === undefined ? undefined : await git(io, root, 'remote')
  const name = remote?.split('\n').find(one => one === 'origin') ?? remote?.split('\n')[0]
  const url = root && name ? await git(io, root, 'remote', 'get-url', name) : undefined
  const parsed = url ? parseRemote(url) : undefined
  const repo = root && parsed ? { ...parsed, root } : undefined
  located.set(dir, repo)

  return repo
}

/** The repositories whose working copies sit directly inside `dir`. */
export const locateChildren = async (io: Ports, dir: string): Promise<Repo[]> => {
  try {
    const entries = await io.list(dir)
    const found: Repo[] = []

    for (const entry of entries.filter(one => one.kind === 'dir' && !one.name.startsWith('.'))) {
      const child = `${dir.replace(/[\\/]$/, '')}/${entry.name}`

      if (await io.exists(`${child}/.git`)) {
        const repo = await locate(io, child)

        if (repo) {
          found.push(repo)
        }
      }
    }

    return found
  } catch {
    return []
  }
}

export const branchOf = async (io: Ports, repo: Repo): Promise<string> =>
  repo.root.length > 0 ? ((await git(io, repo.root, 'branch', '--show-current')) ?? '') : ''

/** The directory a tool call works in, when its input names one. */
export const dirOf = (input: Record<string, unknown>): string | undefined => {
  const file = [input.file_path, input.notebook_path, input.path].find(
    (value): value is string => typeof value === 'string' && /^([a-zA-Z]:)?[\\/]/.test(value),
  )

  if (file) {
    return file.replace(/[\\/][^\\/]*$/, '')
  }

  const command = typeof input.command === 'string' ? input.command : ''
  const [, quoted, bare] = /(?:\bgit\s+-C|\bcd)\s+(?:"([^"]+)"|'[^']*'|(\S+))/.exec(command) ?? []
  const dir = quoted ?? bare

  return dir && /^([a-zA-Z]:)?[\\/]/.test(dir) ? dir : undefined
}
