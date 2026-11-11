/** Domain types shared across modules. Transport types (OTLP) never cross the `surfaces` boundary. */

/** One log record, as Sift stores it. `tsNs` keeps the sender's nanosecond timestamp exactly. */
export interface LogRecord {
  tsNs: string;
  service: string;
  body: string;
  severity?: string;
}

/** A batch as the write-ahead log sees it. `batchId` is optional; with it, retries are deduplicated. */
export interface Batch {
  batchId?: string;
  records: LogRecord[];
}

export interface AppendResult {
  /** WAL byte offset just past this batch's frame. */
  offset: number;
  records: number;
  duplicate: boolean;
}
