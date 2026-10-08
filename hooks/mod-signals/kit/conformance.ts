/**
 * The Mod Signals conformance test, for version 0.1 of the standard. A mod calls
 * it from a test file of its own, with its name as its `plugin.json` gives it:
 *
 *   import { conformance } from './mod-signals/kit/conformance'
 *
 *   conformance('my-mod')
 *
 * and runs `claude plugin test <mod folder>`.
 */
import { expect, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

/** Another mod: it writes, under its own `signal`, whatever its command is given as JSON. */
const caller: Plugin = {
  name: 'mod-signals-caller',
  register(on) {
    on('command.run', { command: 'mod-signals-caller' }, async ($, e) => {
      await $.state.set({ plugin: 'mod-signals-caller', key: 'signal' } as never, JSON.parse(e.args) as never)

      return { text: 'sent' }
    })
  },
}

type Heard = { from: string; value: unknown }

/** Every signal written, in order, as the hooks beneath the mods receive it. */
const listen = (on: On): Heard[] => {
  const heard: Heard[] = []
  on('state.set', { key: 'signal' }, (_, e, next) => {
    heard.push({ from: e.plugin, value: e.value })

    return next(e)
  })

  return heard
}

const say = ($: Engine, signal: unknown): Promise<unknown> =>
  $.command.run({ ...RUN, command: 'mod-signals-caller', args: JSON.stringify(signal) } as never)

const NAME = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/
const isNames = (value: unknown): boolean =>
  Array.isArray(value) && value.every(one => typeof one === 'string' && one.length <= 64 && NAME.test(one))

/** Declares the tests that say whether the mod named follows the standard. */
export const conformance = (MOD: string): void => {
  test('Mod Signals: a roll-call is answered with an announce', { plugins: [caller] }, async ($, on) => {
    const heard = listen(on)
    await say($, { v: 1, kind: 'event', name: 'roll-call', id: 'r1' })

    const answer = heard.find(one => one.from === MOD)?.value as Record<string, unknown> | undefined
    const data = answer?.data as Record<string, unknown> | undefined

    expect(answer?.v).toBe(1)
    expect(answer?.kind).toBe('announce')
    expect(answer?.name).toBe('announce')
    expect(typeof answer?.id === 'string' && answer.id.length > 0 && answer.id.length <= 64).toBe(true)
    expect(answer?.to).toBe(undefined)
    expect(typeof data?.title === 'string' && data.title.length > 0).toBe(true)
    expect(isNames(data?.accepts)).toBe(true)
    expect(isNames(data?.emits)).toBe(true)
  })

  test('Mod Signals: a signal goes on as it was written', { plugins: [caller] }, async ($, on) => {
    const heard = listen(on)
    const sent = { v: 1, kind: 'event', name: 'opened', id: 'e1', tags: ['info'], data: { n: 1 } }
    await say($, sent)

    expect(heard.find(one => one.from === 'mod-signals-caller')?.value).toEqual(sent)
  })

  test('Mod Signals: a command for another mod, and what is not a signal, do nothing', { plugins: [caller] }, async ($, on) => {
    const heard = listen(on)
    await say($, { v: 1, kind: 'command', name: 'open', to: 'some-other-mod', id: 'c1' })
    await say($, { v: 1, kind: 'command', name: 'toggle', to: 'some-other-mod', id: 'c2' })
    await say($, { v: 2, kind: 'command', name: 'open', to: MOD, id: 'c3' })
    await say($, { v: 1, kind: 'command', name: 'Not A Name', to: MOD, id: 'c4' })
    await say($, 'open')

    expect(heard.filter(one => one.from === MOD)).toEqual([])
  })

  test('Mod Signals: a command the mod never announced does nothing', { plugins: [caller] }, async ($, on) => {
    const heard = listen(on)
    await say($, { v: 1, kind: 'command', name: 'mod-signals.no-such-command', to: MOD, id: 'c1' })

    expect(heard.filter(one => one.from === MOD)).toEqual([])
  })
}
