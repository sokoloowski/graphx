# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

GraphX is a small, dependency-light interactive graph explorer for Node-Link JSON and Graphviz DOT files. It renders graphs with [`@memgraph/orb`](https://github.com/memgraph/orb) using a force-directed layout and is built with Vite.

## Tech stack

- Plain JavaScript (ES modules), no framework
- Vite (dev server + build)
- `@memgraph/orb` for graph rendering and physics layout
- [`dotparser`](https://www.npmjs.com/package/dotparser) for parsing Graphviz DOT files

## Commands

```bash
npm install      # install dependencies
npm run dev      # start the Vite dev server (http://localhost:5173)
npm run build    # production build to dist/
npm run preview  # preview the production build
```

There are no tests or linters configured. Verify changes by running the dev server and exercising the UI manually: load both sample datasets (`examples/nodelink.json`, `examples/graphviz.dot`), select nodes/edges, toggle physics, and use "Fit view".

## Project structure

- `index.html` — single-page markup; all static UI text lives here
- `src/main.js` — all application logic: file parsing (Node-Link JSON, DOT), Orb setup, selection/details panel, event wiring
- `src/style.css` — all styling
- `examples/` — sample graph files used by the sidebar buttons

## Conventions

- Keep the app framework-free; do not introduce frameworks, build plugins, or new runtime dependencies without a strong reason.
- All user-facing text must be in English.
- DOT parsing is done with the `dotparser` library (AST in, normalized records out) via `parseDot()` in `src/main.js`. Do not hand-roll parsing logic; extend the AST walker instead.
- Node/edge records are normalized into `{ id, label, type, attributes }` / `{ id, start, end, label, attributes }` before rendering — keep new parsing paths consistent with these shapes.
- Prefer small, focused commits with imperative-mood messages (e.g. "Add physics toggle feature").

## Things to avoid

- Do not rewrite history or amend published commits unless explicitly asked.
- Do not add TypeScript, JSX, or transpilation steps beyond what Vite provides out of the box.
- Do not touch `package-lock.json` manually; run `npm install`.
