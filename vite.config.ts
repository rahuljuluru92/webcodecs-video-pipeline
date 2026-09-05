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
});
