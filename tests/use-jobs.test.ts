import { describe, expect, it, vi } from "vitest";
import { jobOutcome, withTableCheck, type TablePrompt } from "../app/components/use-jobs";
import { ApiError, type Job } from "../app/lib/remote";

const job = (fields: Partial<Job>): Job => ({ id: "j", connectionId: "c", status: "done", done: 3, failed: [], ...fields }) as Job;

describe("job outcomes", () => {
  it("say how a job went, in one line", () => {
    expect(jobOutcome(job({}), "Copied")).toBe("Copied 3 objects");
    expect(jobOutcome(job({ done: 1 }), "Deleted")).toBe("Deleted 1 object");
    expect(jobOutcome(job({ failed: ["a", "b"] }), "Moved")).toBe("Moved 3 objects — 2 couldn't be moved");
    expect(jobOutcome(job({ status: "cancelled", done: 1_200 }))).toBe("Cancelled after 1,200 objects");
    expect(jobOutcome(job({ status: "failed", error: "Bucket is full" }))).toBe("Bucket is full");
  });
});

describe("work that may touch a data-lake table", () => {
  const tableError = () => new ApiError("inside a table", 409, { code: "lake-table", tables: [{ key: "t/", relation: "into", message: "inside" }] });

  it("asks first, and goes on only when told, acknowledged", async () => {
    const start = vi.fn(async (acknowledged: boolean) => {
      if (!acknowledged) throw tableError();
    });
    let prompt: TablePrompt | null = null;
    await withTableCheck(start, "Delete", (asked) => (prompt = asked), () => {});
    expect(start).toHaveBeenCalledTimes(1);
    expect(prompt!.verb).toBe("Delete");
    expect(prompt!.changes).toHaveLength(1);
    prompt!.proceed();
    await vi.waitFor(() => expect(start).toHaveBeenLastCalledWith(true));
  });

  it("throws any other failure for the dialog to show", async () => {
    await expect(withTableCheck(async () => Promise.reject(new Error("name taken")), "Move", () => {}, () => {})).rejects.toThrow("name taken");
  });
});
