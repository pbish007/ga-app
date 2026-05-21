import { withRequest } from "../../../../../lib/auth";
import {
  handleAircraftCreate,
  handleAircraftList,
} from "../../../../../lib/aircraft-handler";
import { buildRequestDeps } from "../../../../../lib/request-deps";
import type { AircraftDb } from "@ga/aircraft";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "aircraft.read" }, (req, ctx) =>
    handleAircraftList(req, {
      tenantId: ctx.tenantId,
      db: ctx.tx as unknown as AircraftDb,
    }),
  )(request);
}

export async function POST(request: Request): Promise<Response> {
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "aircraft.write" }, (req, ctx) =>
    handleAircraftCreate(req, {
      tenantId: ctx.tenantId,
      db: ctx.tx as unknown as AircraftDb,
    }),
  )(request);
}
