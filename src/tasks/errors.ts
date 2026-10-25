export type TaskErrorCode = 'not_found' | 'invalid' | 'conflict'

/** Expected, user-facing failures (bad input, unknown task). Safe to show to the LLM/user. */
export class TaskError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TaskError'
  }
}
