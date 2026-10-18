import { CommandId, CorrelationId, EventId, ProjectId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../Layers/OrchestrationEventStore.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "051_ThreadSyncImportStaging upgrade",
  (it) => {
    it.effect("seeds the new projector at the upgrade head and only projects later events", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const oldEventCount = 32;
        const occurredAt = "2026-10-17T00:00:00.000Z";

        yield* runMigrations({ toMigrationInclusive: 50 });
        yield* Effect.forEach(
          Array.from({ length: oldEventCount }, (_, index) => index),
          (index) =>
            sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, causation_event_id, correlation_id,
              actor_kind, payload_json, metadata_json
            ) VALUES (
              ${`old-event-${index}`},
              'project',
              ${`old-project-${index}`},
              0,
              'project.created',
              ${occurredAt},
              ${`old-command-${index}`},
              NULL,
              ${`old-command-${index}`},
              'client',
              ${JSON.stringify({
                projectId: `old-project-${index}`,
                title: `Old project ${index}`,
                workspaceRoot: `/tmp/old-project-${index}`,
                defaultModelSelection: null,
                scripts: [],
                createdAt: occurredAt,
                updatedAt: occurredAt,
              })},
              '{}'
            )
          `,
          { discard: true },
        );

        yield* runMigrations({ toMigrationInclusive: 51 });

        const seeded = yield* sql<{
          readonly lastAppliedSequence: number;
        }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadSyncImports}
      `;
        assert.deepStrictEqual(seeded, [{ lastAppliedSequence: oldEventCount }]);

        yield* sql`CREATE TABLE thread_sync_projector_updates (count INTEGER NOT NULL)`;
        yield* sql`INSERT INTO thread_sync_projector_updates (count) VALUES (0)`;
        yield* sql`
        CREATE TRIGGER count_thread_sync_projector_updates
        AFTER UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-sync-imports'
        BEGIN
          UPDATE thread_sync_projector_updates SET count = count + 1;
        END
      `;

        const persistence = Layer.succeed(SqlClient.SqlClient, sql);
        const pipelineLayer = OrchestrationProjectionPipelineLive.pipe(
          Layer.provideMerge(OrchestrationEventStoreLive),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-migration-051-" }),
          ),
          Layer.provideMerge(persistence),
          Layer.provideMerge(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const eventStore = yield* OrchestrationEventStore;
          const projectionPipeline = yield* OrchestrationProjectionPipeline;
          const newProjectId = ProjectId.make("new-project-after-migration-051");
          const commandId = CommandId.make("new-command-after-migration-051");

          yield* eventStore.append({
            type: "project.created",
            eventId: EventId.make("new-event-after-migration-051"),
            aggregateKind: "project",
            aggregateId: newProjectId,
            occurredAt: "2026-10-17T00:00:01.000Z",
            commandId,
            causationEventId: null,
            correlationId: CorrelationId.make(commandId),
            metadata: {},
            payload: {
              projectId: newProjectId,
              title: "New project after migration 051",
              workspaceRoot: "/tmp/new-project-after-migration-051",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-10-17T00:00:01.000Z",
              updatedAt: "2026-10-17T00:00:01.000Z",
            },
          });
          yield* projectionPipeline.bootstrap;
        }).pipe(Effect.provide(pipelineLayer));

        const projectorUpdates = yield* sql<{ readonly count: number }>`
        SELECT count FROM thread_sync_projector_updates
      `;
        assert.deepStrictEqual(projectorUpdates, [{ count: 1 }]);

        const projectedNewEvent = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId"
        FROM projection_projects
        WHERE project_id = 'new-project-after-migration-051'
      `;
        assert.deepStrictEqual(projectedNewEvent, [
          { projectId: "new-project-after-migration-051" },
        ]);
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "051_ThreadSyncImportStaging fresh database",
  (it) => {
    it.effect("starts the new projector at zero", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 51 });

        const rows = yield* sql<{
          readonly lastAppliedSequence: number;
          readonly updatedAt: string;
        }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadSyncImports}
      `;
        assert.deepStrictEqual(rows, [
          { lastAppliedSequence: 0, updatedAt: "1970-01-01T00:00:00.000Z" },
        ]);
      }),
    );
  },
);
