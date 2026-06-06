import { aircraftValidator } from "./aircraft.js";
import { componentValidator } from "./component.js";
import { flightTimeEntryValidator } from "./flight-time-entry.js";
import { maintenanceEntryValidator } from "./maintenance-entry.js";
import type { RowValidator, TargetEntity } from "./types.js";

export * from "./types.js";
export { aircraftValidator, FAA_REGISTRATION_REGEX } from "./aircraft.js";
export { componentValidator } from "./component.js";
export { maintenanceEntryValidator } from "./maintenance-entry.js";
export { flightTimeEntryValidator } from "./flight-time-entry.js";

/**
 * Central registry of the C4 per-entity validators. The orchestrator
 * (C5 commit pipeline / PMB-161 caller) selects the validator by the
 * import job's target entity and runs every row of the batch through
 * it, sharing a single {@link import("./types").BatchState} across the
 * batch.
 */
export const VALIDATORS: {
  readonly [K in TargetEntity]: RowValidator<K>;
} = {
  aircraft: aircraftValidator,
  maintenance_entry: maintenanceEntryValidator,
  component: componentValidator,
  flight_time_entry: flightTimeEntryValidator,
};

export function getValidator<T extends TargetEntity>(
  entity: T,
): RowValidator<T> {
  return VALIDATORS[entity];
}
