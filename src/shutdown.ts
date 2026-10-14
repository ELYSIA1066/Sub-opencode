export type ShutdownResult = {
  status: 'closed' | 'failed' | 'timed_out'
  deadline: number
  failures: number
}

/** Start transport and application shutdown under one immutable deadline. */
export function shutdownTogether(input: {
  beginShutdown: (deadline: number) => void
  closeTransport: () => Promise<unknown> | unknown
  closeTasks: (deadline: number) => Promise<unknown> | unknown
  timeoutMs?: number
}): Promise<ShutdownResult> {
  const deadline = Date.now() + (input.timeoutMs ?? 10_000)
  try { input.beginShutdown(deadline) } catch {
    return Promise.resolve({ status: 'failed', deadline, failures: 1 })
  }
  // beginShutdown synchronously rejects new calls and aborts active tasks before either close starts.
  const transport = Promise.resolve().then(input.closeTransport)
  const tasks = Promise.resolve().then(() => input.closeTasks(deadline))
  const settled = Promise.allSettled([transport, tasks]).then((results) => ({
    status: results.every((result) => result.status === 'fulfilled') && Date.now() <= deadline ? 'closed' as const : 'failed' as const,
    deadline,
    failures: results.filter((result) => result.status === 'rejected').length,
  }))
  const remaining = Math.max(0, deadline - Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    settled,
    new Promise<ShutdownResult>((resolve) => { timer = setTimeout(() => resolve({ status: 'timed_out', deadline, failures: 1 }), remaining) }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}
