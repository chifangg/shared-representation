/**
 * Guard a single await inside a streaming loop with an inactivity
 * timeout. A backend that accepts the request and then hangs never
 * rejects the pending read, so without this the fetch state sits at
 * "loading" forever; with the chat gated on diagramBusy that means a
 * permanently locked input. Rejecting instead routes the caller into
 * its normal error path, where Retry works.
 */
/** Longest silence tolerated from the diagram backend before a stream
 *  is declared stalled. Healthy generations emit an event every few
 *  seconds; 90s of nothing means a hung backend. */
export const STREAM_IDLE_MS = 90_000;

export function withIdleTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${what} stalled: no data for ${Math.round(ms / 1000)}s`));
    }, ms);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}
