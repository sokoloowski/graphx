# GraphX — Graph Explorer

GraphX is a small interactive graph explorer for Node-Link JSON and Graphviz DOT files. It uses the [`@memgraph/orb`](https://github.com/memgraph/orb) rendering library to visualize graphs with optional force-directed physics.

## Inspiration

This project started because I needed a lightweight tool to visualize graphs produced with NetworkX and to inspect node/edge properties in the UI the way Memgraph Lab allows — quick access to attributes, connected relationships, and an interactive force layout for exploration.

## Features

- Load graphs from Node-Link JSON and Graphviz DOT
- Interactive pan & zoom, node/edge selection, and attribute inspection
- Force-directed layout (physics)
- Auto-fit view on load and after simulation ends
- Dark and light themes, with the choice remembered between visits

## Requirements

- Node.js (for running the dev server and building with Vite)

## Quick start

1. Install dependencies (optional, needed for the Vite dev server):
    ```bash
    npm install
    ```
2. Start development server (Vite):
    ```bash
    npm run dev
    ```
3. Open a browser at [`http://localhost:5173`](http://localhost:5173) (or the port shown in the terminal) to view the app.

## Usage

- Drag-and-drop a graph file into the main area or use the "Load file" button.
- Example data is available via sidebar buttons: `examples/nodelink.json` and `examples/graphviz.dot`.
- Controls in the header: `Fit view` button, `Physics` toggle, and the `Light` theme toggle.
- Click a node or edge to see attributes in the details panel.

## File formats

- Node-Link JSON: JSON object with `nodes` (array of node objects with `id`, `label`, optional `type` and attributes) and `links`/`edges` (objects with `source`/`target` or equivalent fields). This format is compatible with NetworkX's `node_link_data` export (see https://networkx.org/documentation/stable/reference/readwrite/generated/networkx.readwrite.json_graph.node_link_data.html).
- Graphviz DOT: lightweight parser supports node/edge declarations and attribute lists in square brackets (e.g. `a -> b [label="..."]`).

## License & credits

This project uses [`@memgraph/orb`](https://github.com/memgraph/orb) for rendering.

I was able to create this project thanks to AI agents, Codex and Copilot, which did a lot in terms of writing code, where I only had to provide guidance and review the results.
