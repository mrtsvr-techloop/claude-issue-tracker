# Mod Signals

Version 0.1, draft. A standard for Claude Code mods to talk to each other without knowing each
other.

## 1. Goals

- A mod says what happened without knowing who listens, or how many.
- A mod asks another to do something without that name written in its code.
- A mod that listens loads and works whether or not the emitter is installed, and the reverse.
- No mod is required. There is no bus: the engine carries the signals, and every mod hears them
  itself.

## 2. Terms

- **Signal**: one message a mod emits.
- **Sender**: the mod that emitted it. The engine stamps it; a mod cannot set or forge it.
- **Listener**: any mod that reads signals.

## 3. Transport

A mod emits a signal by writing it to a state value of its own, under the key `signal`:

```ts
// the emitter's contract
interface PluginState {
  'my-mod': {
    signal: Signal | null
  }
}
```

A mod listens by hooking the engine's `state.set` event on that key, whoever writes it:

```ts
on('state.set', { key: 'signal' }, async ($, e, next) => {
  const done = await next(e)

  if (done.value?.isSet === true) {
    // e.plugin is the sender; e.value is the signal
  }

  return done
}).catch((_, e, next) => next(e))
```

A listener MUST call `next(e)` and return its result, so the write lands and the other listeners
hear it. A listener MUST NOT change `e.value`, and MUST NOT refuse the write. It acts after
`next(e)` and only on a write that landed; the `.catch` keeps a listener that fails from standing
in the way of the signal.

## 4. The signal

```ts
type Signal = {
  /** The version of this standard: 1. */
  v: 1
  kind: 'event' | 'command' | 'announce'
  /** What happened or what is asked: lowercase words joined by `-`, `.` between namespaces. */
  name: string
  /** A command's receiver, by mod name. Absent on an event and on an announce. */
  to?: string
  /** What the name needs to be understood; JSON only. */
  data?: Record<string, unknown>
  /** What kind of signal this is, for whoever picks signals by kind (4.1). */
  tags?: string[]
  /** Unique among the sender's signals in the session. */
  id: string
}
```

The **fingerprint** of a signal is its sender and its `id`. A listener that may hear a signal twice
dedupes on it.

### 4.1 Tags

A signal may carry `tags`: what kind of signal it is, said by its sender for whoever picks signals
by kind. A sender never says how a signal is shown, or by whom: it does not know that a mod showing
toasts exists, or will.

- Tags add up. A signal carries as many as hold of it, at most 8: `['info', 'completion']`.
- A tag is written as a name is: lowercase words joined by `-`, `.` between namespaces, at most 64
  characters.
- A signal with no tag is the mods' own business: nothing asks for the person's attention.
- A listener picks the tags it cares for. A mod showing toasts shows `important`, `warning`,
  `error`; one playing sounds plays on `completion`; another does nothing but on `error`. None of
  them is known to the sender, and with none loaded nothing happens.

The tags every mod shares:

| Tag | The signal |
| --- | --- |
| `info`, `warning`, `error` | how grave it is |
| `success` | says something worked |
| `completion` | says something is finished |
| `important` | is one the person should be told of |
| `progress` | is a step of a longer piece of work |

Any other tag is its mod's own, written with a namespace: `citroen.low-fuel`.

A listener that shows a signal to the person takes its words from `data.text`, a string, when the
signal has one, and from the signal's name otherwise.

## 5. The three kinds

### 5.1 Event: something happened

- An event has no `to`. The sender knows no listener and no count of them.
- A listener picks events by `name`, or by `name` and sender when it wants one mod's.
- An event asks for nothing: a listener that ignores it breaks nothing.
- Past tense or a noun phrase: `status-changed`, `opened`, `closed`.

### 5.2 Command: do this

- A command has a `to`: exactly one mod is asked.
- The receiver's name is **data**, never code: it comes from the person's configuration or from the
  directory (5.3). A mod MUST NOT hardcode another mod's name to command it.
- A mod acts on a command only when `to` is its own name, and only on a name it announced.
- A command does what the person could do themselves in that mod, nothing more.
- A mod that changes state on a command says so with an event (`opened`, `closed`), so every
  listener, the sender included, learns the outcome. There is no reply.
- Imperative: `open`, `close`, `toggle`.

### 5.3 Announce: I am here

- A mod announces itself when it loads, and again whenever it hears the event `roll-call`.
- `name` is `announce`; `data` is:

```ts
type Announce = {
  /** What a person reads: "Issues". */
  title: string
  /** The commands the mod acts on. */
  accepts: string[]
  /** The events the mod emits. */
  emits: string[]
}
```

- The directory of a session is the last announce of each sender.
- A mod that needs the directory and loaded late emits the event `roll-call`.
- A mod answers roll-calls at most once a second, so one roll-call is never many.

## 6. Reserved names

| Name | Kind | Meaning | `data` |
| --- | --- | --- | --- |
| `announce` | announce | the sender is loaded | `Announce` |
| `roll-call` | event | every mod announces again | none |
| `open`, `close`, `toggle` | command | show, hide or flip the mod's main surface | none |
| `opened`, `closed` | event | the sender's main surface is now open or closed | none |
| `notify` | event | the sender wants the person told, and has no event of its own to say it with | `{ text: string }`, with tags for how grave |

Any other name is the sender's own. A name shared by several mods on purpose (a vocabulary, such
as `task.completed`) is written with a namespace and documented by whoever proposes it.

## 7. Delivery

- At most once, in the order the sender emitted, to the mods loaded at that moment.
- Nothing is stored for a mod that loads later: it asks for what it needs with `roll-call`.
- A signal the listener does not understand is ignored: unknown `v`, `kind` or `name`.
- `data` is input from another mod: a listener validates what it uses.

## 8. Mods that serve the person

A mod may be nothing but a listener that does something for the person with what the others say:
shows a toast, plays a sound, keeps a log. Such a mod is one more listener, as any other:

- it picks signals by their tags (4.1), or by the names the person chose, never by knowing the
  sender;
- no mod emits for it, asks for it or needs it loaded, and several may be loaded at once;
- it keeps what it holds or shows bounded: length, count, rate;
- whatever it shows is led by the sender's name as the engine gives it, as one line of plain text.

## 9. The kit

The standard is this document. Beside it, `kit/` holds two files a mod uses as they are:

- `kit/signals.ts`: what a signal is, how one is made and how one is read. The same in every mod.
- `kit/conformance.ts`: the test that says whether a mod follows the standard, called with the
  mod's name from a test file of the mod's own.

Both name the version of the standard they are for. They travel inside the mod (the README gives
the way), not as a dependency: a mod's hooks module imports files of its own plugin alone, and a
mod that needed another mod installed would not load without it (11). The few lines that speak to the engine (the write, the listener)
are the mod's own, as the engine has it, and the README gives them.

## 9.1 Conformance

- **Emitter**: declares `signal` in its contract, writes signals as in 4, announces as in 5.3.
- **Listener**: hooks as in 3, ignores what it does not understand, never acts on a command meant
  for another mod.
- **Panel**: an emitter and listener that accepts `open`, `close`, `toggle` and emits `opened`,
  `closed`.

## 10. Security

What a listener may trust, measured in section 11:

- **The sender is the engine's.** `e.plugin` is the mod whose state is written; only that mod
  writes it, and a hook that passes on another name is dropped by the engine. A listener takes the
  sender from `e.plugin` and from nowhere in the signal.
- **The value is not.** Listeners run in the order prepend, user, append; one that stands above
  may pass on a different `e.value`, or refuse the write, and those below never see the original.
  A signal is as trustworthy as the mods installed above the listener, no more. So `data` is
  validated by whoever uses it, and a command does only what the person could do themselves (5.2).
- **A signal carries no secret.** Every mod loaded hears every signal. Tokens, file contents and
  what the person typed stay out of `data`.
- **Bounds.** `name`, `id`, `to` and each tag are at most 64 characters, and a signal has at most 8
  tags. A listener that keeps or shows
  anything from a signal bounds it first: length, count, rate.
- **Text shown to the person** is stripped of control characters and of the marks that reorder
  text, and is led by the sender's name.

## 11. What is measured, and what is not

Measured on Claude Code 2.1.294 with the test kit: one mod under test and mods loaded inline beside
it, each in its own tier.

- A hook on `state.set` with `{ key: 'signal' }` hears the write and receives
  `{ plugin, key, value }`, `plugin` being the writer. `next(e)` resolves `{ value: { isSet,
  version } }`, or `{ deny }` when a mod beneath refused.
- Two mods hear each other, both ways; a mod hears its own signals too.
- A mod hooking `state.set` on a mod that is not loaded still loads.
- Order among listeners: prepend, then user, then append.
- A listener that throws, or answers the wrong shape, is skipped; the others hear the signal and
  the write lands.
- A hook that changes `plugin` in what it passes on is skipped by the engine ("changed
  reference"). One that changes `value` is obeyed: the listeners below and the stored value get the
  new one.
- A hook above that answers `{ deny }` stops the signal: nobody below hears it, and the sender's
  write throws.
- A signal written inside a listener (the `announce` answering a `roll-call`) is heard by every
  other mod, the one whose roll-call is still being delivered included. Its own writer's listener
  does not hear it.
- A write at `session.start` is heard by the mods loaded at that moment.
- A signal written by a mod's own code outside a hook (a Button's `onPress`, a timer) is heard by
  every other mod but not by its writer's listener, and neither are the answers to it. A mod that
  must hear the answer emits from a hook: for a press, a hook on `ui.press`.
- 500 signals from one sender to four listeners: 0.26 s, about half a millisecond a signal.

Measured in a real session (`claude -p` with five mods loaded by `--plugin-dir`: a dock, two panels,
a listener that logs and a probe):

- each mod announced at its start and again on a roll-call, and a listener that kept the announces
  held all of them;
- a command sent to a panel was obeyed and answered with `opened` or `closed`; a command to a mod
  that is not loaded, and one with a name the receiver never announced, did nothing;
- one signal through five listeners, each mod in its own worker, took about 7 ms.

Not yet measured, and to be before 1.0:

- the order among mods of one tier;
- a mod loaded by hot reload after the others: what its `session.start` reaches.
