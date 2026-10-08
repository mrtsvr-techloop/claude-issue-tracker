# Mod Signals

A small standard for Claude Code mods to talk to each other without knowing each other.

A mod says what happened (`opened`, `status-changed`), asks another to do something (`open`), or
says it is loaded (`announce`). Any mod can listen. There is no bus and nothing to install: the
engine carries the signals, and a mod that follows the standard works beside any other that does.

| Here | What it is |
| --- | --- |
| [SPEC.md](./SPEC.md) | the standard: the signal, the rules, what is measured |
| [kit/signals.ts](./kit/signals.ts) | the file a mod imports: what a signal is, how one is made and read |
| [kit/conformance.ts](./kit/conformance.ts) | the test a mod calls: says whether it follows the standard |

A signal is one small value:

```ts
{ v: 1, kind: 'event', name: 'status-changed', id: 'k3f-7', tags: ['info', 'completion'],
  data: { text: 'Build is done' } }
```

`tags` say what kind of signal it is, and add up. A mod that shows toasts picks `important`,
`warning`, `error`; one that plays sounds picks `completion`. The sender knows none of them, and
with none loaded nothing happens.

## Making a mod compatible

Bring this repository into the mod's `hooks` folder, then take three steps, each useful without
the next. The whole of it is in [SPEC.md](./SPEC.md).

A mod imports files of its own plugin alone, so the kit travels inside the mod. `git subtree`
commits the files into the mod's repository, so that a clone or an install gets them with
nothing else to fetch, and a later pull brings a newer version of the standard:

```
git subtree add --prefix hooks/mod-signals <this repository> main --squash
git subtree pull --prefix hooks/mod-signals <this repository> main --squash
```

The files under `hooks/mod-signals` are not edited in the mod: a change is made here and pulled.

### 1. Emit

Declare `signal` in the mod's state contract (`types/index.d.ts`, named in `plugin.json` as
`"types"`):

```ts
export type Signal = {
  v: 1
  kind: 'event' | 'command' | 'announce'
  name: string
  to?: string
  data?: Record<string, unknown>
  id: string
}

declare module 'claude-code' {
  interface PluginState {
    notes: {
      signal: Signal | null
    }
  }
}
```

A signal is one write of that value. In the hooks module, at the top of the file:

```ts
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { ROLL_CALL_MS, readSignal, signalOf } from './mod-signals/kit/signals'
import type { SignalKind } from './mod-signals/kit/signals'

const signal = atom({ plugin: 'notes', key: 'signal' } as const, null)
const sent = { count: 0, answeredAt: 0 }

const emit = async (
  $: EngineInterface,
  kind: SignalKind,
  name: string,
  rest: { to?: string; data?: Record<string, unknown>; tags?: string[] } = {},
): Promise<void> => {
  sent.count += 1

  try {
    await update($, signal, () => signalOf(kind, name, sent.count, Date.now(), rest))
  } catch {
    // A mod above refused the write: go on without it.
  }
}
```

Then say what happens, where it happens:

```ts
await emit($, 'event', 'opened')
await emit($, 'event', 'note.saved', { data: { count: 3, text: 'Saved 3 notes' }, tags: ['info', 'success'] })
```

A name is lowercase words joined by `-`, with `.` between namespaces, at most 64 characters. An
event has no receiver: the mod does not know who listens, or how many.

`tags` say what kind of signal it is, and add up: `info`, `warning`, `error`, `success`,
`completion`, `important`, `progress`, or the mod's own with a namespace. Whoever shows, plays or
logs signals picks them by tag; a signal with none is the mods' own business.

### 2. Announce

Say the mod is loaded when it loads, and again whenever anyone calls the roll:

```ts
const SELF = { title: 'Notes', accepts: ['open', 'close', 'toggle'], emits: ['opened', 'closed', 'note.saved'] }

on('session.start', async ($, e, next) => {
  await emit($, 'announce', 'announce', { data: SELF })

  return next(e)
})
```

`accepts` lists the commands the mod acts on, `emits` the events it sends. The roll-call is
answered in the listener of step 3.

### 3. Listen

One hook hears every signal, whoever writes it:

```ts
on('state.set', { key: 'signal' }, async ($, e, next) => {
  const done = await next(e)
  const heard = done.value?.isSet === true ? readSignal(e.value) : null

  if (heard === null) {
    return done
  }

  if (heard.kind === 'event' && heard.name === 'roll-call' && Date.now() - sent.answeredAt >= ROLL_CALL_MS) {
    sent.answeredAt = Date.now()
    await emit($, 'announce', 'announce', { data: SELF })
  }

  if (heard.kind === 'command' && heard.to === 'notes') {
    if (heard.name === 'open') {
      await open($)
      await emit($, 'event', 'opened')
    }
  }

  if (heard.kind === 'event' && heard.name === 'status-changed' && e.plugin === 'task-bars') {
    // another mod's event: e.plugin is who sent it
  }

  return done
}).catch((_, e, next) => next(e))
```

The rules that keep every mod's signals working:

- Call `next(e)` first, return what it gave, and never change `e.value`: the other listeners hear
  the signal through it.
- Take the sender from `e.plugin`, never from the signal. The engine sets it and no mod can forge
  it.
- Act on a command only when `to` is the mod's own name, and only on a name it announced.
- A mod that changes on a command says so with an event (`opened`), so whoever asked learns the
  outcome. There is no reply.
- Ignore what is not understood. Check whatever is used from `data`: it is another mod's input.
- Answer a roll-call at most once a second.
- Put no secret in a signal: every mod loaded hears it.
- Emit from a hook. A signal written inside a Button's `onPress`, or a timer, reaches every other
  mod but not the listener of the mod that wrote it, and neither does the answer to it. For a
  press, emit from a hook on `ui.press`.

A mod whose main surface opens and closes is a **Panel** when it accepts `open`, `close` and
`toggle` and emits `opened` and `closed`. A launcher or a dock can then drive it knowing only its
name, which it reads from the directory.

### Sending a command

The receiver's name is data: from the person's configuration or from the directory, never written
in the code.

```ts
await emit($, 'command', 'toggle', { to: entry.name })
```

### Names every mod shares

| Name | Kind | Meaning | `data` |
| --- | --- | --- | --- |
| `announce` | announce | the sender is loaded | `{ title, accepts, emits }` |
| `roll-call` | event | every mod announces again | none |
| `open`, `close`, `toggle` | command | show, hide or flip the mod's main surface | none |
| `opened`, `closed` | event | the sender's main surface is now open or closed | none |
| `notify` | event | the sender wants the person told | `{ text }`, with tags for how grave |

Any other name is the mod's own.

### Checking it

Add a test file to the mod's `hooks` folder, `signals.conformance.test.ts`, that calls the kit's
test with the mod's name as its `plugin.json` gives it:

```ts
import { conformance } from './mod-signals/kit/conformance'

conformance('notes')
```

and run `claude plugin test <mod folder>`. It checks that the mod answers a roll-call with an announce,
lets a signal go on as written, and does nothing on a command for another mod, on one it never
announced, or on what is not a signal.

### Testing it

The test kit loads a second mod inline beside the one under test, so a test shows two mods hearing
each other:

```ts
import { expect, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'

const caller: Plugin = {
  name: 'caller',
  register(on) {
    on('command.run', { command: 'caller' }, async $ => {
      await $.state.set({ plugin: 'caller', key: 'signal' } as never, { v: 1, kind: 'command', name: 'open', to: 'notes', id: 'c1' } as never)

      return { text: 'sent' }
    })
  },
}

test('opens on a command and says so', { plugins: [caller] }, async ($, on) => {
  const heard: string[] = []
  on('state.set', { key: 'signal' }, (_, e, next) => {
    heard.push(`${e.plugin} ${(e.value as { name: string }).name}`)

    return next(e)
  })

  await $.command.run({ origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 }, command: 'caller', args: '' })

  expect(heard).toEqual(['caller open', 'notes opened'])
})
```

## Mods that follow it

| Mod | Name | Accepts | Emits |
| --- | --- | --- | --- |
| Issue tracker | `issue-tracker` | `open` `close` `toggle` | `opened` `closed` `notify` |
| Task bars | `task-bars` | `open` `close` `toggle` | `opened` `closed` `status-changed` |
| Dock | `dock` | | `roll-call`, and `toggle` to the mod behind a button |
| Toasts | `toasts` | | |

`status-changed` carries `{ id, name, from, to }`: `from` is null when the task appears, `to` when
it leaves the list.

## Writing a mod that serves the person

A mod that shows, plays or logs what the others say is one more listener: step 3 above and nothing
else of the others. It picks signals by tag, or by the names the person chose, and never by knowing
who sends them. `toasts` is one: it shows a toast for a `notify` and for the signals tagged
`important`, `warning`, `error`, `completion` or `success`.

What such a mod owes the others and the person:

- its hook runs after the write has gone on, and never changes or refuses it;
- it bounds what it keeps or shows: length, count, rate per sender;
- what it shows is led by the sender's name as the engine gives it (`e.plugin`), as one line of
  plain text with control characters and the marks that reorder text taken out.
