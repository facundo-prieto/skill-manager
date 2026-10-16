/**
 * One-at-a-time job queue. Requests return immediately with a job id; the browser polls /api/jobs for progress.
 * Serial on purpose: npx skills, plugin toggles and SATL all rewrite shared state (the lock file, settings),
 * so two of them running at once can corrupt it.
 */
export type Job = {
  id: number;
  label: string;
  status: "queued" | "running" | "done" | "failed";
  done: number;
  total: number;
  step?: string; // what it's doing right now
  log: string[];
  error?: string;
  result?: unknown;
  createdAt: number;
  finishedAt?: number;
};

export type Progress = { step: (message: string) => void; setTotal: (n: number) => void; log: (line: string) => void };

const jobs: Job[] = [];
const work = new Map<number, (p: Progress) => Promise<unknown>>();
let nextId = 1;
let running = false;

export function enqueue(label: string, total: number, fn: (p: Progress) => Promise<unknown>) {
  const job: Job = { id: nextId++, label, status: "queued", done: 0, total, log: [], createdAt: Date.now() };
  jobs.push(job);
  work.set(job.id, fn);
  void drain();
  return job;
}

async function drain() {
  if (running) return;
  running = true;
  for (let job = jobs.find((j) => j.status === "queued"); job; job = jobs.find((j) => j.status === "queued")) {
    job.status = "running";
    const progress: Progress = {
      step: (message) => {
        if (job!.step) job!.done = Math.min(job!.done + 1, job!.total);
        job!.step = message;
      },
      setTotal: (n) => (job!.total = n),
      log: (line) => job!.log.push(line),
    };
    try {
      job.result = await work.get(job.id)!(progress);
      job.status = "done";
      job.done = job.total;
    } catch (e) {
      job.status = "failed";
      job.error = (e as Error).message;
    }
    job.step = undefined;
    job.finishedAt = Date.now();
    work.delete(job.id);
  }
  running = false;
  // keep the last 30 finished jobs for the activity panel
  const finished = jobs.filter((j) => j.finishedAt).sort((a, b) => b.finishedAt! - a.finishedAt!);
  for (const old of finished.slice(30)) jobs.splice(jobs.indexOf(old), 1);
}

export const listJobs = () => [...jobs].sort((a, b) => b.id - a.id);

/** Drops finished jobs — all of them, or just one when `id` is given. */
export function clearFinished(id?: number) {
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i]!.finishedAt && (id === undefined || jobs[i]!.id === id)) jobs.splice(i, 1);
}

if (import.meta.main) {
  const order: number[] = [];
  const a = enqueue("a", 2, async (p) => (p.step("one"), await Bun.sleep(20), p.step("two"), order.push(1)));
  enqueue("b", 1, async () => order.push(2));
  enqueue("c", 1, async () => {
    throw new Error("boom");
  });
  await Bun.sleep(100);
  console.assert(order.join() === "1,2", "jobs must run serially in order");
  console.assert(a.status === "done" && a.done === 2, "progress should reach total");
  console.assert(listJobs()[0]!.status === "failed" && listJobs()[0]!.error === "boom", "failures are captured");
  console.log("jobs ok", listJobs().map((j) => `${j.label}:${j.status}`));
}
