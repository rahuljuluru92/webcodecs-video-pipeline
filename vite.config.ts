import { defineConfig } from "vite";

// Cross-origin isolation is required for SharedArrayBuffer to exist at all.
// The app never loads cross-origin subresources (video files come from a
// local <input type="file">, not a network fetch), so these headers have no
// practical downside here — see DECISIONS.md for the feature this unlocks.
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  // Vite bundles Worker entry chunks as IIFE by default at build time,
  // independent of the `{ type: "module" }` passed to `new Worker()` at
  // runtime — IIFE can't express top-level await, which the generated WASM
  // loader glue (build/blur.release.js) uses to compile the module before
  // its exports are available. Confirmed the hard way: `npm run build`
  // failed with "Top-level await is currently not supported with the
  // 'iife' output format" until this was set.
  worker: { format: "es" },
});
