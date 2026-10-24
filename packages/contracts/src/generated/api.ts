/**
 * Types of the schemas of the REST API.
 *
 * Generated from components.schemas of contracts/openapi/api.yaml by src/generate-types.ts.
 * Do not edit: change the contract, then run `pnpm --filter @libredi/contracts generate`.
 * The tests fail when this file is out of date.
 */

export interface Components {
  schemas: {
    Health: Health;
    Problem: Problem;
  };
}
export interface Health {
  status: "ok";
  /**
   * Name of the service that answered.
   */
  service: string;
}
/**
 * Problem details for HTTP APIs (RFC 9457).
 */
export interface Problem {
  /**
   * URI reference that identifies the problem type.
   */
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [k: string]: unknown;
}
