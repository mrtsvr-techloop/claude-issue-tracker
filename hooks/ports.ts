/**
 * What the GitHub and git adapters need of the machine. The hooks module
 * builds it over the engine; a test hands in its own.
 */
export type Ports = {
  run: (
    argv: readonly string[],
    init?: { stdin?: string; env?: Record<string, string>; timeoutMs?: number },
  ) => Promise<{ exitCode: number; stdout: string }>
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ text: string }>
  /** A GitHub token the environment already carries, when it does. */
  envToken: () => Promise<string | undefined>
  list: (dir: string) => Promise<{ name: string; kind: string }[]>
  exists: (path: string) => Promise<boolean>
}
