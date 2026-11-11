/**
 * Errors with stable codes. The message's first line says what failed with the actual value;
 * `fix` is the exact next step and is printed as the last line. Codes are documented in docs/errors.md.
 */
export type ErrorCode =
  | "SIFT-E101" // intake: body is not valid OTLP
  | "SIFT-E102" // intake: body too large
  | "SIFT-E103" // intake: WAL behind (backpressure)
  | "SIFT-E104" // input file or dataset missing
  | "SIFT-E105" // intake: retry older than the dedup horizon
  | "SIFT-E201" // WAL frame corrupt beyond the tail
  | "SIFT-E202" // storage directory unusable
  | "SIFT-E203" // query failed
  | "SIFT-E401"; // usage error

export class SiftError extends Error {
  readonly code: ErrorCode;
  readonly fix: string;
  readonly retryable: boolean;
  readonly httpStatus: number;

  constructor(code: ErrorCode, what: string, fix: string, opts: { retryable?: boolean; httpStatus?: number } = {}) {
    super(`${code} ${what}`);
    this.code = code;
    this.fix = fix;
    this.retryable = opts.retryable ?? false;
    this.httpStatus = opts.httpStatus ?? 500;
  }

  /** RFC 9457 problem details body for HTTP surfaces. */
  problem(instance?: string): Record<string, unknown> {
    return {
      type: `https://github.com/VijayChamakuri/sift/blob/main/docs/errors.md#${this.code.toLowerCase()}`,
      title: this.code,
      status: this.httpStatus,
      detail: this.message,
      fix: this.fix,
      retryable: this.retryable,
      ...(instance ? { instance } : {}),
    };
  }

  /** Two lines for a terminal: what failed, then the fix. */
  render(): string {
    return `${this.message}\nfix: ${this.fix}`;
  }
}
