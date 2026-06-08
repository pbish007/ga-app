import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  OwnershipHistoryPanel,
  type OwnershipHistoryResponse,
} from "../components/faa/OwnershipHistoryPanel";

/**
 * Pure-render tests: pass `initial` so the panel skips its `useEffect`
 * fetch and renders directly from the snapshot. `renderToStaticMarkup`
 * does not run effects, which is exactly what we want here.
 */

const FRESHNESS = {
  snapshot_date: "2026-06-01",
  pg_loaded_at: "2026-06-01T03:00:00Z",
} as const;

function render(initial: OwnershipHistoryResponse): string {
  return renderToStaticMarkup(
    <OwnershipHistoryPanel
      tenantId="11111111-1111-1111-1111-111111111111"
      aircraftId="22222222-2222-2222-2222-222222222222"
      initial={initial}
    />,
  );
}

describe("OwnershipHistoryPanel", () => {
  it("renders the empty state when there are zero events", () => {
    const html = render({ events: [], freshness: FRESHNESS });
    expect(html).toContain("No FAA-recorded ownership or registration changes");
    expect(html).toContain("faa-ownership-history-empty");
    expect(html).toContain("Last synced from FAA");
  });

  it("renders a single event with field-level before/after", () => {
    const html = render({
      events: [
        {
          snapshot_date: "2026-06-01",
          change_kind: "ownership_transfer",
          previous_value: { owner_name: "ACME LLC" },
          new_value: { owner_name: "BETA INC" },
        },
      ],
      freshness: FRESHNESS,
    });
    expect(html).toContain("Ownership transfer");
    expect(html).toContain("Owner Name");
    expect(html).toContain("ACME LLC");
    expect(html).toContain("BETA INC");
    expect(html).toContain("2026-06-01");
    expect(html).not.toContain("No FAA-recorded ownership");
  });

  it("renders three events newest-first per the supplied order", () => {
    const html = render({
      events: [
        {
          snapshot_date: "2026-06-01",
          change_kind: "address_change",
          previous_value: { city: "Old City" },
          new_value: { city: "New City" },
        },
        {
          snapshot_date: "2026-04-15",
          change_kind: "expiration_change",
          previous_value: { expiration_date: "2026-05-01" },
          new_value: { expiration_date: "2029-05-01" },
        },
        {
          snapshot_date: "2026-03-01",
          change_kind: "new_registration",
          previous_value: null,
          new_value: {
            n_number: "12345",
            owner_name: "ACME LLC",
            status_code: "V",
          },
        },
      ],
      freshness: FRESHNESS,
    });
    expect(html).toContain("Address change");
    expect(html).toContain("Expiration date change");
    expect(html).toContain("New registration");
    // Order check: address_change (newest) must appear before
    // new_registration (oldest) in the rendered HTML.
    const addressIdx = html.indexOf("Address change");
    const expirationIdx = html.indexOf("Expiration date change");
    const newRegIdx = html.indexOf("New registration");
    expect(addressIdx).toBeGreaterThan(-1);
    expect(expirationIdx).toBeGreaterThan(addressIdx);
    expect(newRegIdx).toBeGreaterThan(expirationIdx);
    // n_number is intentionally suppressed in the field-level details.
    expect(html).not.toMatch(/N number/i);
  });
});
