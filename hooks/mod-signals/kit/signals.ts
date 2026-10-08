/**
 * The Mod Signals kit, for version 0.1 of the standard. A mod imports this
 * file as it is: it is the same in every mod, and is not to be edited there.
 *
 * Mod Signals 0.1, the part every mod carries: what a signal is, how one is
 * made and how one is read. A mod emits by writing a signal under its own state
 * key `signal`, and listens by hooking `state.set` on that key, whoever writes.
 */
export type SignalKind = 'event' | 'command' | 'announce'

export type Signal = {
  v: 1
  kind: SignalKind
  name: string
  to?: string
  data?: Record<string, unknown>
  /** What kind of signal this is, for whoever picks signals by kind: `['info', 'completion']`. */
  tags?: string[]
  id: string
}

/** What a mod says of itself in an `announce`. */
export type Announce = {
  title: string
  accepts: string[]
  emits: string[]
}

/** The most characters of a `name`, an `id` or a `to`. */
const NAME_LENGTH = 64

/** The most tags of a signal. */
const TAGS_LENGTH = 8

/**
 * The tags every mod shares; any other is its mod's own, written with a
 * namespace: `citroen.low-fuel`.
 */
export const TAGS = ['info', 'warning', 'error', 'success', 'completion', 'important', 'progress'] as const

/** A mod answers the roll-calls of others no more often than this. */
export const ROLL_CALL_MS = 1000

const KINDS: readonly SignalKind[] = ['event', 'command', 'announce']

/** Lowercase words joined by `-`, `.` between namespaces. */
const NAME = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isShort = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= NAME_LENGTH

const isName = (value: unknown): value is string => isShort(value) && NAME.test(value)

/** A signal of this mod's, the `count`-th it emits: its id is unique in the session. */
export const signalOf = (
  kind: SignalKind,
  name: string,
  count: number,
  now: number,
  rest: { to?: string; data?: Record<string, unknown>; tags?: string[] } = {},
): Signal => ({
  v: 1,
  kind,
  name,
  id: `${now.toString(36)}-${count}`,
  ...(rest.to === undefined ? {} : { to: rest.to }),
  ...(rest.data === undefined ? {} : { data: rest.data }),
  ...(rest.tags === undefined || rest.tags.length === 0 ? {} : { tags: rest.tags }),
})

/**
 * The signal a written value holds, or null: an unknown version or kind, a name
 * off the grammar, a command with no receiver, a receiver on anything else.
 */
export const readSignal = (value: unknown): Signal | null => {
  if (!isRecord(value) || value.v !== 1 || !isName(value.name) || !isShort(value.id)) {
    return null
  }

  const kind = KINDS.find(one => one === value.kind)
  const isAddressed = value.to !== undefined

  if (kind === undefined || (isAddressed && !isShort(value.to)) || isAddressed !== (kind === 'command')) {
    return null
  }

  if ((kind === 'announce') !== (value.name === 'announce') || (value.data !== undefined && !isRecord(value.data))) {
    return null
  }

  if (value.tags !== undefined && !(Array.isArray(value.tags) && value.tags.length <= TAGS_LENGTH && value.tags.every(isName))) {
    return null
  }

  return value as Signal
}

/** Whether the signal carries the tag. */
export const hasTag = (signal: Signal, tag: string): boolean => (signal.tags ?? []).includes(tag)

/** What an `announce` says its sender accepts, or null when it does not hold. */
export const acceptsOf = (signal: Signal): string[] | null => {
  const accepts = signal.kind === 'announce' ? signal.data?.accepts : undefined

  return Array.isArray(accepts) && accepts.every(isShort) ? accepts : null
}
