export class CliError extends Error {
  override readonly name = "CliError";

  constructor(
    message: string,
    readonly exitCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}
