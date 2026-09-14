import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse/pdfjs-dist do their own Node-side file/module resolution
  // (worker files, optional native deps) that webpack's bundler mishandles —
  // run them as plain CommonJS requires in the serverless function instead.
  // @napi-rs/canvas ships a native .node binary and tesseract.js ships its
  // own WASM core — both need to stay untouched by the bundler for the same
  // reason as pdf-parse/pdfjs-dist below.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas", "tesseract.js", "tesseract.js-core"],
  // pdfjs-dist (the pdf-parse fallback in pdfExtract.ts) dynamically imports
  // its worker file at a path it computes relative to its own module
  // location. Next's file tracing can't see that dynamic import statically,
  // so on Vercel the worker file gets left out of the deployed function
  // bundle entirely and the fallback fails at runtime with "Cannot find
  // module .../pdf.worker.mjs" — even though it works fine locally (full
  // node_modules present). This forces the worker file to ship with the
  // function. Confirmed against a real Vercel deploy: without this, any PDF
  // that trips pdf-parse's primary path (e.g. "bad XRef entry" on a
  // malformed-but-common PDF structure) has nowhere to fall back to.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/pdfjs-dist/legacy/build/*.mjs",
      // @napi-rs/canvas (native .node binary + JS compat shim), pinned to
      // 0.1.100 specifically — required for the OCR name-correction pass in
      // ocrNames.ts (see that file for why the version pin matters).
      "./node_modules/@napi-rs/canvas/**/*",
      "./node_modules/@napi-rs/canvas-*/**/*",
      // tesseract.js's worker script + WASM core, plus tesseract.js's own
      // runtime dependencies (its worker-script requires these directly —
      // externalizing the parent package means Next's tracer never follows
      // that require chain, so each one has to be listed explicitly or the
      // deployed function throws "Cannot find module 'bmp-js'" the moment a
      // worker actually spins up, confirmed against a real Vercel deploy).
      "./node_modules/tesseract.js/**/*",
      "./node_modules/tesseract.js-core/**/*",
      "./node_modules/bmp-js/**/*",
      "./node_modules/idb-keyval/**/*",
      "./node_modules/is-electron/**/*",
      "./node_modules/is-url/**/*",
      "./node_modules/node-fetch/**/*",
      "./node_modules/regenerator-runtime/**/*",
      "./node_modules/wasm-feature-detect/**/*",
      "./node_modules/zlibjs/**/*",
    ],
  },
};

export default nextConfig;
