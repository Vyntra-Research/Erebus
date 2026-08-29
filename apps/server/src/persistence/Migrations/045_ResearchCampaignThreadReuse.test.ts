import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_ResearchCampaignThreadReuse", (it) => {
  it.effect("keeps terminal history while enforcing one live campaign per thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 44 });
      yield* sql`
        INSERT INTO research_campaign_projections (
          campaign_id,
          project_id,
          principal_thread_id,
          last_sequence,
          state_json,
          updated_at
        ) VALUES (
          'old-campaign',
          'project-1',
          'thread-1',
          2,
          '{"campaign":{"status":"aborted"}}',
          '2026-08-28T20:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* sql`
        INSERT INTO research_campaign_projections (
          campaign_id,
          project_id,
          principal_thread_id,
          last_sequence,
          state_json,
          updated_at
        ) VALUES (
          'replacement-campaign',
          'project-1',
          'thread-1',
          1,
          '{"campaign":{"status":"draft"}}',
          '2026-08-28T21:00:00.000Z'
        )
      `;

      const duplicateLive = yield* Effect.result(sql`
        INSERT INTO research_campaign_projections (
          campaign_id,
          project_id,
          principal_thread_id,
          last_sequence,
          state_json,
          updated_at
        ) VALUES (
          'second-live-campaign',
          'project-1',
          'thread-1',
          1,
          '{"campaign":{"status":"active"}}',
          '2026-08-28T22:00:00.000Z'
        )
      `);
      const rows = yield* sql<{ readonly campaignId: string }>`
        SELECT campaign_id AS "campaignId"
        FROM research_campaign_projections
        WHERE principal_thread_id = 'thread-1'
        ORDER BY campaign_id ASC
      `;

      assert.deepEqual(
        rows.map((row) => row.campaignId),
        ["old-campaign", "replacement-campaign"],
      );
      assert.equal(duplicateLive._tag, "Failure");
    }),
  );
});
