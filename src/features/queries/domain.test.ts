import { describe, expect, it } from "vitest";
import {
  SQL_STREAM_MAX_ROWS_PER_BATCH,
  acceptSqlStreamBatch,
  appendSqlStreamRows,
  emptySqlStreamView,
  finishSqlStream,
  sqlStreamRowAt,
} from "./domain";

describe("SQL stream screen reducer", () => {
  it("accepts only the next bounded batch for its typed run identity", () => {
    const start = { ...emptySqlStreamView(7), phase: "connecting" as const };
    const accepted = acceptSqlStreamBatch(start, 7, {
      operationId: "operation-a",
      sequence: 0,
      columns: ["id"],
      rows: [[1]],
    });
    expect(accepted).toMatchObject({
      phase: "streaming",
      nextSequence: 1,
      rowSource: { rowCount: 1 },
    });
    expect(
      acceptSqlStreamBatch(accepted!, 8, {
        operationId: "operation-a",
        sequence: 1,
        columns: ["id"],
        rows: [[2]],
      }),
    ).toBeNull();
    expect(
      acceptSqlStreamBatch(accepted!, 7, {
        operationId: "operation-a",
        sequence: 2,
        columns: ["id"],
        rows: [[2]],
      }),
    ).toBeNull();
  });

  it("rejects schema changes, malformed rows, and an oversized page before ACK", () => {
    const start = { ...emptySqlStreamView(1), phase: "connecting" as const };
    expect(
      acceptSqlStreamBatch(start, 1, {
        operationId: "operation-a",
        sequence: 0,
        columns: ["id"],
        rows: Array.from({ length: SQL_STREAM_MAX_ROWS_PER_BATCH + 1 }, () => [
          1,
        ]),
      }),
    ).toBeNull();
    expect(
      acceptSqlStreamBatch(start, 1, {
        operationId: "operation-a",
        sequence: 0,
        columns: ["id"],
        rows: [[1, 2]],
      }),
    ).toBeNull();
    const accepted = acceptSqlStreamBatch(start, 1, {
      operationId: "operation-a",
      sequence: 0,
      columns: ["id"],
      rows: [[1]],
    });
    expect(
      acceptSqlStreamBatch(accepted!, 1, {
        operationId: "operation-a",
        sequence: 1,
        columns: ["name"],
        rows: [["a"]],
      }),
    ).toBeNull();
  });

  it("finishes only the current run without overwriting a newer view", () => {
    const state = {
      ...emptySqlStreamView(3),
      phase: "streaming" as const,
      operationId: "operation-a",
      rowCount: 1,
    };
    expect(
      finishSqlStream(state, 2, {
        operationId: "old",
        rowCount: 1,
        truncated: false,
        durationMs: 1,
      }),
    ).toBe(state);
    expect(
      finishSqlStream(state, 3, {
        operationId: "operation-a",
        rowCount: 1,
        truncated: true,
        durationMs: 4,
      }),
    ).toMatchObject({
      phase: "complete",
      operationId: "operation-a",
      truncated: true,
    });
  });

  it.each(["idle", "complete", "outcome_unknown", "cancelled", "error"] as const)(
    "does not reopen a %s stream from a late receipt",
    (phase) => {
      const state = {
        ...emptySqlStreamView(3),
        phase,
        operationId: "operation-a",
        rowCount: 1,
      };
      expect(
        finishSqlStream(state, 3, {
          operationId: "operation-a",
          rowCount: 1,
          truncated: false,
          durationMs: 1,
        }),
      ).toBe(state);
    },
  );

  it("completes a zero-row connecting stream when its receipt identifies the operation", () => {
    const state = { ...emptySqlStreamView(3), phase: "connecting" as const };
    expect(
      finishSqlStream(state, 3, {
        operationId: "operation-a",
        rowCount: 0,
        truncated: false,
        durationMs: 1,
      }),
    ).toMatchObject({ phase: "complete", operationId: "operation-a" });
  });

  it("appends 50k rows as immutable 256-row chunks without copying row references", () => {
    let source = emptySqlStreamView().rowSource;
    const first = Array.from({ length: 256 }, (_, index) => [index]);
    for (let index = 0; index < 50_000; index += 256) {
      const rows =
        index === 0
          ? first
          : Array.from(
              { length: Math.min(256, 50_000 - index) },
              (_, offset) => [index + offset],
            );
      source = appendSqlStreamRows(source, rows);
    }
    expect(source.rowCount).toBe(50_000);
    expect(source.chunkIndex.chunks).toHaveLength(Math.ceil(50_000 / 256));
    expect(source.chunkIndex.chunks[0].rows).toBe(first);
    expect(sqlStreamRowAt(source, 49_999)).toEqual([49_999]);
  });

  it("uses one owned append-only index for one-row pages", () => {
    let source = emptySqlStreamView().rowSource;
    const index = source.chunkIndex;
    for (let row = 0; row < 10_000; row += 1)
      source = appendSqlStreamRows(source, [[row]]);

    expect(source.chunkIndex).toBe(index);
    expect(source.chunkIndex.chunks).toHaveLength(10_000);
    expect(sqlStreamRowAt(source, 9_999)).toEqual([9_999]);
  });

  it.each(["idle", "complete", "outcome_unknown", "cancelled", "error"] as const)(
    "does not accept a batch after %s",
    (phase) => {
      const state = { ...emptySqlStreamView(1), phase };
      expect(
        acceptSqlStreamBatch(state, 1, {
          operationId: "operation-a",
          sequence: 0,
          columns: ["id"],
          rows: [[1]],
        }),
      ).toBeNull();
    },
  );

  it("marks a mismatched completion as outcome unknown", () => {
    const state = {
      ...emptySqlStreamView(3),
      phase: "streaming" as const,
      operationId: "operation-a",
    };
    expect(
      finishSqlStream(state, 3, {
        operationId: "operation-b",
        rowCount: 0,
        truncated: false,
        durationMs: 1,
      }),
    ).toMatchObject({ phase: "outcome_unknown" });
  });
});
