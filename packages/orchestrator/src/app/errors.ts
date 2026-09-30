/** A refusal the operator should see. The console turns it into an HTTP answer; nothing here knows about HTTP. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400
  ) {
    super(message)
    this.name = 'AppError'
  }
}
