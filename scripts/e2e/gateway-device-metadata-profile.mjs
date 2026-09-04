import WebSocket from "ws";

// Diagnostic-only Node inspector client. It observes the built process unchanged.
export async function profileProcess(readOutput, until) {
  const output = await until(
    readOutput,
    (text) => /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)/.test(text),
    "diagnostic inspector endpoint",
  );
  const endpoint = output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)/)[1];
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let sequence = 0;
  const requests = new Map();
  socket.on("message", (bytes) => {
    const message = JSON.parse(String(bytes));
    requests.get(message.id)?.(message);
  });
  const call = (method) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error(`Diagnostic inspector timed out: ${method}`));
      }, 15_000);
      requests.set(id, (message) => {
        clearTimeout(timer);
        requests.delete(id);
        if (message.error) {
          reject(new Error(JSON.stringify(message.error)));
        } else {
          resolve(message.result);
        }
      });
      socket.send(JSON.stringify({ id, method }));
    });
  await call("Profiler.enable");
  await call("Profiler.start");
  return {
    async stop(sanitize) {
      try {
        const { profile } = await call("Profiler.stop");
        const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
        const parents = new Map();
        for (const node of profile.nodes) {
          for (const child of node.children ?? []) {
            parents.set(child, node.id);
          }
        }
        const timings = new Map();
        for (let index = 0; index < profile.samples.length; index++) {
          const id = profile.samples[index];
          timings.set(id, (timings.get(id) ?? 0) + profile.timeDeltas[index]);
        }
        // Retain every sampled stack and its measured time, without object values,
        // process arguments, credentials, or unrelated inspector runtime state.
        return [...timings]
          .toSorted((left, right) => right[1] - left[1])
          .map(([id, microseconds]) => {
            const stack = [];
            for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor)) {
              const frame = nodes.get(cursor).callFrame;
              stack.push({
                function: frame.functionName,
                source: sanitize(frame.url.startsWith("file:") ? decodeURI(frame.url) : frame.url),
                line: frame.lineNumber + 1,
              });
            }
            return { milliseconds: microseconds / 1000, stack };
          });
      } finally {
        socket.close();
      }
    },
  };
}
