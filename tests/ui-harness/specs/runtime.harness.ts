// strict router의 fail-closed, payload/response mutation isolation과 call count를
// browser 실행과 독립된 focused contract로 보호한다.
import { expect, test } from "@playwright/test";
import {
  createCommandRouter,
  type HarnessCommandContext,
} from "../runtime/commandRouter";

test("strict router는 unknown command를 기록하고 거부한다", async () => {
  const router = createCommandRouter("fixture-scene", {
    allowed: { ok: true },
  });
  await expect(router.handle("unknown", { value: 1 })).rejects.toThrow(
    'unhandled Tauri command "unknown"',
  );
  expect(router.unhandled()).toEqual(["unknown"]);
  expect(router.names()).toEqual(["unknown"]);
});

test("fixture와 payload는 call 사이에서 deep clone으로 격리된다", async () => {
  const fixture = { nested: { values: ["original"] } };
  const router = createCommandRouter("fixture-scene", {
    read: fixture,
    echo: ({ payload }: HarnessCommandContext) => payload,
  });
  const first = (await router.handle("read", null)) as typeof fixture;
  first.nested.values.push("mutated");
  const second = (await router.handle("read", null)) as typeof fixture;
  expect(second).toEqual({ nested: { values: ["original"] } });

  const payload = { nested: { value: "before" } };
  await router.handle("echo", payload);
  payload.nested.value = "after";
  expect(router.calls[router.calls.length - 1]?.payload).toEqual({
    nested: { value: "before" },
  });
  expect(router.counts()).toEqual({ read: 2, echo: 1 });
});
