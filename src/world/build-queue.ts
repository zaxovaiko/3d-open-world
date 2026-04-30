// Serial idle-time queue. Ensures only one heavy tile build runs at a time
// and yields to the browser between tasks so physics/render don't starve.

type Task = () => void;

const queue: Task[] = [];
let running = false;

const idle = (cb: () => void): number => {
  const ric = (window as unknown as { requestIdleCallback?: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number })
    .requestIdleCallback;
  if (typeof ric === "function") {
    return ric(() => cb(), { timeout: 250 });
  }
  return window.setTimeout(cb, 16);
};

const cancel = (id: number) => {
  const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  if (typeof cic === "function") cic(id);
  else window.clearTimeout(id);
};

function pump() {
  if (running) return;
  const task = queue.shift();
  if (!task) return;
  running = true;
  idle(() => {
    try {
      task();
    } finally {
      running = false;
      if (queue.length) pump();
    }
  });
}

export function scheduleIdle(task: Task): () => void {
  let cancelled = false;
  const wrapped: Task = () => {
    if (!cancelled) task();
  };
  queue.push(wrapped);
  pump();
  return () => {
    cancelled = true;
  };
}

export { idle as runWhenIdle, cancel as cancelIdle };
