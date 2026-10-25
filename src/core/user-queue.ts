import PQueue from 'p-queue'

/**
 * Runs jobs one at a time per key (user), so two quick messages from the same person are
 * handled in order, while different users are processed in parallel.
 */
export class KeyedQueue {
  private readonly queues = new Map<string, PQueue>()

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(key)
    if (!queue) {
      queue = new PQueue({ concurrency: 1 })
      this.queues.set(key, queue)
      queue.addEventListener('idle', () => {
        if (queue!.size === 0 && queue!.pending === 0) this.queues.delete(key)
      })
    }
    return queue.add(job) as Promise<T>
  }

  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.onIdle()))
  }
}
