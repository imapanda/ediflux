/**
 * Types of the job envelope.
 *
 * Generated from contracts/jobs/job-envelope.schema.json by src/generate-types.ts.
 * Do not edit: change the contract, then run `pnpm --filter @libredi/contracts generate`.
 * The tests fail when this file is out of date.
 */

/**
 * Common shape of every job sent through the PostgreSQL queue (pgmq). The payload is described by the JSON Schema of its job type, next to this file. Files never travel in the queue: the payload holds archive references (SHA-256), not bytes.
 */
export interface JobEnvelope {
  /**
   * Job type, lower case, dot separated: domain then action.
   */
  type: string;
  /**
   * Version of the job type, that is of its payload schema. Readers ignore unknown properties within a version.
   */
  version: number;
  /**
   * The Libredi message this job works on.
   */
  messageId: string;
  /**
   * Groups the jobs of one flow run, for tracing.
   */
  correlationId?: string;
  /**
   * Test and production never share a queue message.
   */
  environment: "test" | "production";
  enqueuedAt: string;
  /**
   * W3C Trace Context, to follow a message across services.
   */
  traceparent?: string;
  /**
   * Job-specific data, validated against the schema of the job type.
   */
  payload: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
