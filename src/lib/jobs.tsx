import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { get, post } from "@/lib/api";
import type { Job } from "@/server/jobs";

export type { Job };

type Jobs = {
  jobs: Job[];
  /** Queue a server job. Never blocks the UI; progress shows in the activity panel. */
  run: (url: string, body: object) => Promise<Job | undefined>;
  /** Bumps every time a job finishes — views put it in effect deps to reload their data. */
  revision: number;
  clear: (id?: number) => void;
  /** True while a job with this exact label is queued or running (to dim just that button). */
  isPending: (label: string) => boolean;
};

const JobsContext = createContext<Jobs | null>(null);
export const useJobs = () => useContext(JobsContext)!;

const active = (j: Job) => j.status === "queued" || j.status === "running";

export function JobsProvider({ children, onFinished }: { children: ReactNode; onFinished: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [revision, setRevision] = useState(0);
  const seen = useRef(new Map<number, Job["status"]>());
  const finishedCb = useRef(onFinished); // the interval outlives renders; always call the latest callback
  finishedCb.current = onFinished;

  const poll = async () => {
    const list = await get<Job[]>("/api/jobs").catch(() => null);
    if (!list) return;
    let finished = false;
    for (const j of list) {
      const before = seen.current.get(j.id);
      if (before && active({ status: before } as Job) && !active(j)) {
        finished = true;
        if (j.status === "done") toast.success(j.label, { id: `job-${j.id}` });
        else toast.error(j.label, { id: `job-${j.id}`, description: j.error, duration: 10_000 }); // the full error stays in Activity
      }
      seen.current.set(j.id, j.status);
    }
    setJobs(list);
    if (finished) {
      setRevision((r) => r + 1);
      finishedCb.current();
    }
  };

  // poll fast while something is queued or running, slowly otherwise
  const busy = jobs.some(active);
  useEffect(() => {
    void poll();
    const t = setInterval(poll, busy ? 800 : 5000);
    return () => clearInterval(t);
  }, [busy]);

  const run = async (url: string, body: object) => {
    try {
      const { job } = await post<{ job: Job }>(url, body);
      seen.current.set(job.id, job.status);
      setJobs((list) => [job, ...list]);
      return job;
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const clear = (id?: number) => void post("/api/jobs", { id }).then(poll);
  const isPending = (label: string) => jobs.some((j) => j.label === label && active(j));

  return <JobsContext.Provider value={{ jobs, run, revision, clear, isPending }}>{children}</JobsContext.Provider>;
}
