export type PermissionReply = 'once' | 'always' | 'reject'

type Waiter = (reply: PermissionReply) => void

type Entry = {
  settled: boolean
  reply?: PermissionReply
  enqueued: boolean
  started: boolean
  waiters: Waiter[]
}

type QueueItem = {
  id: string
  work: () => Promise<void>
}

/**
 * Per-session serial queue for permission replies. Callers enqueue the work to
 * run for a request; the server reply comes back through settle(). The queue
 * never calls the SDK, never decides permission and never widens access.
 */
export class PermissionReplyQueue {
  private readonly entries = new Map<string, Entry>()
  private readonly pending: QueueItem[] = []
  private readonly idleWaiters = new Set<() => void>()
  private processing = false
  private stopped = false
  private errorReported = false

  constructor(
    private readonly signal: AbortSignal,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Queue work once per id; a duplicate enqueue is a no-op. */
  enqueue(id: string, work: () => Promise<void>): void {
    const entry = this.entry(id)
    if (entry.enqueued) return
    entry.enqueued = true
    if (this.stopped || this.signal.aborted) return
    this.pending.push({ id, work })
    this.schedule()
  }

  /** Record the server reply; the first terminal record wins regardless of order. */
  settle(id: string, reply: PermissionReply): void {
    const entry = this.entry(id)
    if (entry.settled) return
    entry.settled = true
    entry.reply = reply
    for (const waiter of entry.waiters.splice(0)) waiter(reply)
  }

  isSettled(id: string): boolean {
    return this.entries.get(id)?.settled === true
  }

  replyFor(id: string): PermissionReply | undefined {
    return this.entries.get(id)?.reply
  }

  /** Resolve true only for a same-id explicit reject; aborts reject immediately. */
  waitForReject(id: string, timeoutMs: number): Promise<boolean> {
    const entry = this.entry(id)
    if (entry.settled) return Promise.resolve(entry.reply === 'reject')
    if (this.signal.aborted) return Promise.reject(this.signal.reason)
    return new Promise<boolean>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let done = false
      const finish = (callback: () => void) => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        this.signal.removeEventListener('abort', onAbort)
        const index = entry.waiters.indexOf(waiter)
        if (index >= 0) entry.waiters.splice(index, 1)
        callback()
      }
      const onAbort = () => finish(() => reject(this.signal.reason))
      const waiter: Waiter = (reply) => finish(() => resolve(reply === 'reject'))
      timer = setTimeout(() => finish(() => resolve(false)), Math.max(0, Math.min(timeoutMs, 1000)))
      this.signal.addEventListener('abort', onAbort, { once: true })
      entry.waiters.push(waiter)
    })
  }

  /** Drain promise for the queue as it exists now; resolves on abort or stop too. */
  idle(): Promise<void> {
    if (this.signal.aborted) return Promise.resolve()
    if (this.isDrained()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const waiter = () => {
        this.signal.removeEventListener('abort', waiter)
        this.idleWaiters.delete(waiter)
        resolve()
      }
      this.signal.addEventListener('abort', waiter, { once: true })
      this.idleWaiters.add(waiter)
    })
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { settled: false, enqueued: false, started: false, waiters: [] }
      this.entries.set(id, entry)
    }
    return entry
  }

  private schedule(): void {
    if (this.processing || this.stopped) return
    this.processing = true
    queueMicrotask(() => { void this.drain() })
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        if (this.signal.aborted) { this.pending.length = 0; break }
        const item = this.pending.shift()!
        const entry = this.entry(item.id)
        if (entry.settled || entry.started) continue
        entry.started = true
        await item.work()
        // Yield a macrotask so a continuous event reader can consume already
        // queued permission.replied events before the next work item starts.
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } catch (error) {
      this.stopped = true
      this.pending.length = 0
      if (!this.errorReported) {
        this.errorReported = true
        this.report(error)
      }
    } finally {
      this.processing = false
      if (this.isDrained()) this.resolveIdle()
      else this.schedule()
    }
  }

  private report(error: unknown): void {
    try { this.onError(error) } catch { /* keep the queue safe after the work error was delivered */ }
  }

  private isDrained(): boolean {
    return this.pending.length === 0 && !this.processing
  }

  private resolveIdle(): void {
    for (const waiter of [...this.idleWaiters]) waiter()
  }
}
