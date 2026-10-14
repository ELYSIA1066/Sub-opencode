export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      action()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)))
  })
}

export function trackOperation<T>(promise: Promise<T>, operations: Set<Promise<unknown>>): Promise<T> {
  let tracked!: Promise<T>
  tracked = promise.finally(() => operations.delete(tracked))
  operations.add(tracked)
  return tracked
}

export function awaitBefore<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    void promise.catch(() => undefined)
    return Promise.reject(new Error('Operation exceeded its deadline.'))
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Operation exceeded its deadline.')), remaining) }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

export async function cleanupCall<T>(operation: (signal: AbortSignal) => Promise<T>, deadline: number, controllers?: Set<AbortController>): Promise<T> {
  if (deadline <= Date.now()) throw new Error('Cleanup exceeded its deadline.')
  const controller = new AbortController()
  controllers?.add(controller)
  try {
    return await awaitBefore(raceAbort(operation(controller.signal), controller.signal), deadline)
  } catch (error) {
    controller.abort(error)
    throw error
  } finally {
    controllers?.delete(controller)
  }
}
