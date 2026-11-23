// Errors with their exit code: what a script can rely on.
export const EXIT = {
  ok: 0,
  error: 1, // anything else: relay error, file error…
  usage: 2, // wrong command, option or argument
  noGroup: 3, // this device is in no group (or not the one asked for)
  unreachable: 4, // the relay cannot be reached
  notFound: 5, // no such item
  timeout: 124, // --timeout reached, invitation expired (like timeout(1))
  interrupted: 130, // Ctrl-C
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    public code: number = EXIT.error,
  ) {
    super(message);
  }
}

export const usageError = (message: string) => new CliError(message, EXIT.usage);
