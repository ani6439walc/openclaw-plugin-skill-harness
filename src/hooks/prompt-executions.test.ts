import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptExecutions } from "./prompt-executions.js";

describe("PromptExecutions request ownership", () => {
  const instances: PromptExecutions<string>[] = [];
  const releases: Array<() => void> = [];
  const association = { sessionId: "session-a", turnKey: "turn-a" };
  const scope = { agentId: "main", sessionId: "session-a" };

  function create(capacity?: number) {
    const executions = new PromptExecutions<string>(undefined, capacity);
    instances.push(executions);
    return executions;
  }

  function deferred<T>(fallback: T) {
    const work = Promise.withResolvers<T>();
    releases.push(() => work.resolve(fallback));
    return work;
  }

  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await Promise.all(
      instances.splice(0).map((instance) => instance.dispose()),
    );
  });

  it("preserves opaque admission IDs, including empty and whitespace IDs", () => {
    const executions = create();
    const ids = ["", " ", "admission", " admission "];
    const owners = ids.map((admissionId) =>
      executions.claimRequest({ ...scope, admissionId }),
    );
    expect(new Set(owners).size).toBe(ids.length);
    for (const [index, admissionId] of ids.entries()) {
      expect(executions.claimRequest({ ...scope, admissionId })).toBe(
        owners[index],
      );
      expect(owners[index]?.admissionId).toBe(admissionId);
    }
    expect(() => executions.assertRequestCurrent(owners.at(-1)!)).not.toThrow();
    expect(() => executions.assertRequestCurrent(owners[0]!)).toThrow();
  });

  it("keeps tuple scopes distinct when IDs contain delimiter characters", () => {
    const executions = create();
    const first = executions.claimRequest({
      agentId: "a",
      sessionId: "b:c",
      admissionId: "same",
    })!;
    const second = executions.claimRequest({
      agentId: "a:b",
      sessionId: "c",
      admissionId: "same",
    })!;
    expect(first).not.toBe(second);
    expect(() => executions.assertRequestCurrent(first)).not.toThrow();
    expect(() => executions.assertRequestCurrent(second)).not.toThrow();
  });

  it("joins one native request's pending lookup, preparation, and dynamic result", async () => {
    const executions = create();
    const request = executions.claimRequest({ ...scope, admissionId: "a" })!;
    expect(executions.claimRequest({ ...scope, admissionId: "a" })).toBe(
      request,
    );
    const pending = deferred<string | undefined>("session-key");
    const lookup = vi.fn(() => pending.promise);
    const firstLookup = executions.lookupRequest(request, lookup);
    expect(executions.lookupRequest(request, lookup)).toBe(firstLookup);
    pending.resolve("session-key");
    await expect(firstLookup).resolves.toBe("session-key");
    expect(lookup).toHaveBeenCalledTimes(1);

    const prepare = vi.fn(async () => association);
    const firstPreparation = executions.prepareRequest(request, prepare);
    expect(executions.prepareRequest(request, prepare)).toBe(firstPreparation);
    await firstPreparation;
    expect(prepare).toHaveBeenCalledTimes(1);
    const run = vi.fn(async () => "selected");
    const firstResult = executions.runRequest(request, association, run);
    expect(executions.runRequest(request, association, run)).toBe(firstResult);
    await expect(firstResult).resolves.toBe("selected");
    expect(executions.runRequest(request, association, run)).toBe(firstResult);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never revives superseded handles and drops their retained work references", async () => {
    const executions = create();
    const first = executions.claimRequest({ ...scope, admissionId: "a" })!;
    await executions.lookupRequest(first, async () => "session-key");
    await executions.prepareRequest(first, async () => association);
    await executions.runRequest(first, association, async () => "large result");
    const next = executions.claimRequest({ ...scope, admissionId: "b" })!;
    expect(executions.claimRequest({ ...scope, admissionId: "a" })).toBe(first);
    expect(first.controller.signal.aborted).toBe(true);
    expect(first.lookup).toBeUndefined();
    expect(first.preparation).toBeUndefined();
    expect(first.result).toBeUndefined();
    expect(() => executions.assertRequestCurrent(first, true)).toThrow();
    expect(() => executions.assertRequestCurrent(next)).not.toThrow();
  });

  it.each(["Error", "AbortError"])(
    "reuses terminal %s outcomes without rerunning selection",
    async (name) => {
      const executions = create();
      const request = executions.claimRequest({ ...scope, admissionId: "a" })!;
      const failure = new Error("selection unavailable");
      failure.name = name;
      const run = vi.fn(async () => {
        throw failure;
      });
      const result = executions.runRequest(request, association, run);
      await expect(result).rejects.toBe(failure);
      const rebuild = executions.claimRequest({ ...scope, admissionId: "a" })!;
      expect(executions.runRequest(rebuild, association, run)).toBe(result);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it("allows finalized native handles only for static rebuild ownership checks", async () => {
    const executions = create();
    const request = executions.claimRequest({ ...scope, admissionId: "a" })!;
    await executions.runRequest(request, association, async () => "selected");
    executions.finalizeAssociation(association);
    expect(executions.claimRequest({ ...scope, admissionId: "a" })).toBe(
      request,
    );
    expect(() => executions.assertRequestCurrent(request, true)).not.toThrow();
    expect(() => executions.assertRequestCurrent(request)).toThrow();
    const operation = vi.fn(async () => association);
    expect(() => executions.prepareRequest(request, operation)).toThrow();
    expect(() =>
      executions.runRequest(request, association, async () => "retry"),
    ).toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(request.result).toBeUndefined();
  });

  it("rejects new native admissions at capacity without forgetting or reviving old IDs", () => {
    const executions = create(1);
    const first = executions.claimRequest({ ...scope, admissionId: "a" })!;
    expect(
      executions.claimRequest({ ...scope, admissionId: "b" }),
    ).toBeUndefined();
    expect(executions.claimRequest({ ...scope, admissionId: "a" })).toBe(first);
    expect(() => executions.assertRequestCurrent(first, true)).toThrow();
    executions.removeSession(scope.sessionId);
    const afterReset = executions.claimRequest({ ...scope, admissionId: "b" })!;
    expect(afterReset).toBeDefined();
    expect(() => executions.assertRequestCurrent(afterReset)).not.toThrow();
  });

  it("holds a joined legacy owner until its last caller releases unassociated work", async () => {
    const executions = create();
    const params = { ...scope, legacyInput: "same request" };
    const first = executions.claimRequest(params)!;
    const joined = executions.claimRequest(params)!;
    expect(joined).toBe(first);
    await executions.lookupRequest(first, async () => undefined);
    executions.releaseRequest(first);
    expect(() => executions.assertRequestCurrent(joined)).not.toThrow();
    executions.releaseRequest(joined);
    expect(() => executions.assertRequestCurrent(first)).toThrow();
    expect(executions.claimRequest(params)).not.toBe(first);
    for (let index = 0; index < 32; index++) {
      const request = executions.claimRequest({
        agentId: "main",
        sessionId: `empty-${index}`,
        legacyInput: "empty",
      })!;
      executions.releaseRequest(request);
      expect(() => executions.assertRequestCurrent(request)).toThrow();
    }
  });

  it.each(["remove-session", "dispose"])(
    "cancels pending lookup and drains it on %s",
    async (action) => {
      const executions = create();
      const request = executions.claimRequest({ ...scope, admissionId: "a" })!;
      const pending = deferred<string | undefined>("late-key");
      const started = deferred<void>(undefined);
      const lookup = executions.lookupRequest(request, async () => {
        started.resolve();
        return pending.promise;
      });
      const outcome = lookup.then(
        () => "resolved",
        () => "rejected",
      );
      await started.promise;
      if (action === "remove-session")
        executions.removeSession(scope.sessionId);
      let disposed = false;
      const disposal = executions.dispose().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(request.controller.signal.aborted).toBe(true);
      expect(disposed).toBe(false);
      pending.resolve("late-key");
      expect(await outcome).toBe("rejected");
      await disposal;
      expect(disposed).toBe(true);
      expect(request.resolvedSessionKey).toBeUndefined();
      const run = vi.fn(async () => "late effect");
      expect(() => executions.runRequest(request, association, run)).toThrow();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("does not start queued preparation after its request is superseded", async () => {
    const executions = create();
    const request = executions.claimRequest({ ...scope, admissionId: "a" })!;
    const operation = vi.fn(async () => association);
    const preparation = executions.prepareRequest(request, operation);
    const outcome = preparation.then(
      () => "resolved",
      () => "rejected",
    );
    executions.claimRequest({ ...scope, admissionId: "b" });
    expect(await outcome).toBe("rejected");
    expect(operation).not.toHaveBeenCalled();
    expect(request.association).toBeUndefined();
  });

  it("does not publish an association from preparation completed after supersession", async () => {
    const executions = create();
    const request = executions.claimRequest({ ...scope, admissionId: "a" })!;
    const pending = deferred<typeof association | undefined>(association);
    const started = deferred<void>(undefined);
    const preparation = executions.prepareRequest(request, async () => {
      started.resolve();
      return pending.promise;
    });
    const outcome = preparation.then(
      () => "resolved",
      () => "rejected",
    );
    await started.promise;
    executions.claimRequest({ ...scope, admissionId: "b" });
    pending.resolve(association);
    await outcome;
    expect(request.association).toBeUndefined();
    expect(request.preparation).toBeUndefined();
  });

  it("rejects a noncooperative dynamic result completed after supersession", async () => {
    const executions = create();
    const request = executions.claimRequest({ ...scope, admissionId: "a" })!;
    const pending = deferred("late result");
    const started = deferred<void>(undefined);
    const result = executions.runRequest(request, association, async () => {
      started.resolve();
      return pending.promise;
    });
    const outcome = result.then(
      () => "resolved",
      () => "rejected",
    );
    await started.promise;
    executions.claimRequest({ ...scope, admissionId: "b" });
    pending.resolve("late result");
    expect(await outcome).toBe("rejected");
    expect(request.result).toBeUndefined();
  });
});
