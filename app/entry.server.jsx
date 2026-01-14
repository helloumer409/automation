import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { startAutoSync } from "./services/auto-sync.server";

// Start automated sync when server starts
// Runs automatically by default (every 6 hours) unless AUTO_SYNC_DISABLED=true
// This runs once when the module loads, not on every request
if (typeof process !== "undefined" && process.env.AUTO_SYNC_DISABLED !== "true") {
  // Only start once, check if already started to prevent multiple starts
  if (!global.autoSyncStarted) {
    startAutoSync();
    global.autoSyncStarted = true;
    console.log("✅ Auto-sync enabled by default (runs every 6 hours). Set AUTO_SYNC_DISABLED=true to disable.");
  }
}

export const streamTimeout = 5_000;

export default function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  routerContext,
  loadContext,
  // If you have middleware enabled:
  // loadContext: RouterContextProvider
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    let userAgent = request.headers.get("user-agent");

    // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
    // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
    let readyOption =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode
        ? "onAllReady"
        : "onShellReady";

    // Abort the rendering stream after the `streamTimeout` so it has time to
    // flush down the rejected boundaries
    let timeoutId = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              // Clear the timeout to prevent retaining the closure and memory leak
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          pipe(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          // Note: We cannot change the response status code here because the
          // Response has already been created and sent to the client. Errors
          // that occur during streaming are logged but the response continues
          // with the original status code.
          if (shellRendered) {
            console.error("Streaming error (response already sent):", error);
          }
        },
      },
    );
  });
}
