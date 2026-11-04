import { OrbEventType, OrbView } from '@memgraph/orb';
import 'bootstrap-icons/font/bootstrap-icons.css';
import parseDotSource from 'dotparser';
import './style.css';

const graphElement = document.querySelector('#graph');
const schemaElement = document.querySelector('#schema');
const graphSlot = document.querySelector('#graph-slot');
const schemaSlot = document.querySelector('#schema-slot');
const editorSlot = document.querySelector('#editor-slot');
const canvasStack = document.querySelector('.canvas-stack');
const previewElement = document.querySelector('#preview');
const sourceEditor = document.querySelector('#graph-source');
const editorFormat = document.querySelector('#editor-format');
const editorStatus = document.querySelector('#editor-status');
const editorOpen = document.querySelector('#editor-open');
const viewTabs = [...document.querySelectorAll('.view-tab')];
const viewHint = document.querySelector('#view-hint');
const emptyState = document.querySelector('#empty-state');
const dropZone = document.querySelector('#drop-zone');
const fileInput = document.querySelector('#file-input');
const meta = document.querySelector('#graph-meta');
const toast = document.querySelector('#toast');
let orb;
let schemaOrb;
let previewOrb;
let model = { nodes: [], edges: [], directed: true };
let selected = null;
let schemaSelection = null;
let previewSelection = null;
let previewModel = { nodes: [], edges: [], directed: true };
let schemaModel = { nodes: [], edges: [], types: new Map(), relationTypes: new Map() };
let currentView = 'graph';
let hasGraph = false;
let hasEditorSeed = false;
const physicsToggle = document.querySelector('#physics-toggle');
let physicsEnabled = physicsToggle ? physicsToggle.checked : true;

const themeToggle = document.querySelector('#theme-toggle');
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
const THEME_KEY = 'graphx-theme';
const THEME_MODES = ['auto', 'light', 'dark'];
const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// One palette per theme; the light variant is darkened so nodes keep contrast
// against a light canvas.
const palettes = {
  dark: ['#52d5bc', '#6fa8ff', '#ffad75', '#b792ff', '#f5d66f', '#f285aa'],
  light: ['#0f9e83', '#2f6fe0', '#c96a12', '#7b4fd8', '#a38000', '#d33f77']
};

// Canvas colours (labels, edges, borders) Orb cannot inherit from CSS.
const canvasColors = {
  dark: { nodeLabel: '#dce8f5', nodeBorder: '#d9ecff', nodeActive: '#f7fbff', nodeMuted: '#25364b', activeBorder: '#6ea7ff', edgeLabel: '#aebfd2', edge: '#839bb5', edgeMuted: '#24364c', edgeActive: '#65cdb9' },
  light: { nodeLabel: '#1d2b3a', nodeBorder: '#2a3a4a', nodeActive: '#e3edfd', nodeMuted: '#c9d6e3', activeBorder: '#2f6fe0', edgeLabel: '#4c5f72', edge: '#7c8e9e', edgeMuted: '#d2dce6', edgeActive: '#0f9e83' }
};

// Theme mode is what the user picked (auto | light | dark); the resolved theme
// is what actually gets painted and is what the canvas palettes key on.
const readThemeMode = () => {
  const mode = document.documentElement.dataset.themeMode;
  return THEME_MODES.includes(mode) ? mode : 'auto';
};

let themeMode = readThemeMode();
let theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

// Assign colours by first-seen order of the type instead of hashing — hashing
// collides frequently on small palettes (e.g. "image" vs "detection").
// Each view keeps its own order map so the editor preview cannot reshuffle the
// colours of the explorer graph.
const makeColourFor = (order) => (type) => {
  const key = String(type || 'node');
  if (!order.has(key)) order.set(key, order.size);
  const palette = palettes[theme];
  return palette[order.get(key) % palette.length];
};
const typeOrder = new Map();
const previewTypeOrder = new Map();
const colourFor = makeColourFor(typeOrder);
const previewColourFor = makeColourFor(previewTypeOrder);
const display = (value) => typeof value === 'object' ? JSON.stringify(value) : String(value);

function normalizeNode(node, index) {
  const attributes = { ...node };
  const id = node.id ?? node.name ?? `node-${index + 1}`;
  delete attributes.id;
  const type = attributes.type || attributes.group || 'node';
  return { id: String(id), label: String(node.label ?? node.name ?? id), type: String(type), attributes };
}

function normalizeEdge(edge, index, nodes) {
  const attributes = { ...edge };
  const start = edge.start ?? edge.source ?? edge.from;
  const end = edge.end ?? edge.target ?? edge.to;
  if (start === undefined || end === undefined) throw new Error(`Edge ${index + 1} is missing source/target fields.`);
  delete attributes.id; delete attributes.start; delete attributes.end; delete attributes.source; delete attributes.target; delete attributes.from; delete attributes.to;
  const source = typeof start === 'object' ? start.id : start;
  const target = typeof end === 'object' ? end.id : end;
  return { id: String(edge.id ?? `edge-${index + 1}-${source}-${target}`), start: String(source), end: String(target), label: edge.label ?? edge.type ?? '', attributes };
}

function parseNodeLink(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.nodes)) throw new Error('The JSON file does not contain a "nodes" array.');
  const nodes = data.nodes.map(normalizeNode);
  const edges = (data.links ?? data.edges ?? []).map((edge, index) => normalizeEdge(edge, index, nodes));
  return { nodes, edges, directed: data.directed !== false };
}

function parseDot(text) {
  const directed = /^\s*(strict\s+)?digraph\b/im.test(text);
  const nodes = new Map();
  const edges = [];
  const getNode = (id, attrs = {}) => {
    const key = String(id ?? '').trim().replace(/^"|"$/g, '');
    if (key === '') return { id: '', label: '', type: attrs.type || 'node', attributes: {} };
    const existing = nodes.get(key) || { id: key, label: key, type: attrs.type || 'node', attributes: {} };
    existing.attributes = { ...existing.attributes, ...attrs };
    existing.label = String(attrs.label && attrs.label !== '\\N' ? attrs.label : existing.label);
    existing.type = String(attrs.type || existing.type);
    nodes.set(key, existing);
    return existing;
  };

  // dotparser returns an AST; walk it and map onto normalized node/edge records.
  const coerce = (value) => {
    if (typeof value !== 'string') return value;
    return /^(true|false)$/i.test(value) ? value.toLowerCase() === 'true'
      : (!Number.isNaN(Number(value)) && value.trim() !== '' ? Number(value) : value);
  };
  const toAttrs = (attrList = []) => {
    const result = {};
    for (const entry of attrList.flat()) {
      if (entry?.type === 'attr') {
        // skip Graphviz's "\N" placeholder — it means "use the node id as label"
        // and is not a meaningful attribute value
        if (entry.id === 'label' && entry.eq === '\\N') continue;
        result[entry.id] = coerce(entry.eq);
      }
    }
    return result;
  };

  let defaultNodeAttrs = {};
  let defaultEdgeAttrs = {};

  const endpointId = (endpoint) => {
    if (!endpoint) return '';
    if (endpoint.type === 'node_id') return String(endpoint.id ?? '');
    if (endpoint.type === 'subgraph') {
      for (const child of endpoint.children ?? []) {
        const id = endpointId(child.type === 'node_stmt' ? child.node_id : child);
        if (id) return id;
      }
      return '';
    }
    return '';
  };

  function walk(children) {
    for (const stmt of children ?? []) {
      switch (stmt.type) {
        case 'node_stmt': {
          getNode(stmt.node_id?.id, { ...defaultNodeAttrs, ...toAttrs(stmt.attr_list) });
          break;
        }
        case 'edge_stmt': {
          const list = stmt.edge_list ?? [];
          const attrs = { ...defaultEdgeAttrs, ...toAttrs(stmt.attr_list) };
          for (let i = 0; i + 1 < list.length; i++) {
            const startNode = getNode(endpointId(list[i]));
            const endNode = getNode(endpointId(list[i + 1]));
            edges.push({ id: `edge-${edges.length + 1}-${startNode.id}-${endNode.id}`, start: startNode.id, end: endNode.id, label: String(attrs.label ?? attrs.type ?? ''), attributes: attrs });
          }
          break;
        }
        case 'attr_stmt':
          if (/^node$/i.test(stmt.target ?? '')) defaultNodeAttrs = { ...defaultNodeAttrs, ...toAttrs(stmt.attr_list) };
          else if (/^edge$/i.test(stmt.target ?? '')) defaultEdgeAttrs = { ...defaultEdgeAttrs, ...toAttrs(stmt.attr_list) };
          break;
        case 'subgraph':
          walk(stmt.children);
          break;
        default:
          break;
      }
    }
  }

  const ast = parseDotSource(text.replace(/\r/g, ''));
  for (const graph of ast) walk(graph.children);

  if (!nodes.size && edges.length === 0) throw new Error('No nodes or edges found in the DOT file.');
  return { nodes: [...nodes.values()], edges, directed };
}

function getSelectionContext() {
  if (!selected) return { nodes: new Set(), edges: new Set() };
  if (selected.kind === 'node') {
    const neighbours = new Set([selected.id]); const edges = new Set();
    model.edges.forEach(edge => { if (edge.start === selected.id || edge.end === selected.id) { edges.add(edge.id); neighbours.add(edge.start); neighbours.add(edge.end); } });
    return { nodes: neighbours, edges };
  }
  return { nodes: new Set([selected.item.start, selected.item.end]), edges: new Set([selected.id]) };
}

// ---------------------------------------------------------------------------
// Schema view
//
// Memgraph Lab style: one node per node type, one edge per relationship type
// between two node types. Aggregating the loaded graph into a type-level model
// keeps the diagram readable no matter how many instances there are.
// ---------------------------------------------------------------------------
function buildSchema() {
  const types = new Map();
  const typeOfNode = new Map();
  model.nodes.forEach(node => {
    const type = node.type || 'node';
    typeOfNode.set(node.id, type);
    const entry = types.get(type) ?? { id: type, type, count: 0, attributes: new Set() };
    entry.count += 1;
    Object.keys(node.attributes ?? {}).forEach(key => entry.attributes.add(key));
    types.set(type, entry);
  });

  const relations = new Map();
  // Distinct (start, type, end) triples, counted separately from the drawn
  // edges because self-loops collapse into a single circle.
  const relationTypes = new Map();
  model.edges.forEach(edge => {
    let start = typeOfNode.get(edge.start) ?? 'unknown';
    let end = typeOfNode.get(edge.end) ?? 'unknown';
    // Undirected graphs list the same relationship twice — fold it into one.
    if (!model.directed && start > end) [start, end] = [end, start];
    // A missing label means "no relationship type given" — do not invent one.
    const relation = String(edge.label ?? edge.attributes?.type ?? edge.attributes?.label ?? '').trim();
    const hasRelation = relation !== '';
    relationTypes.set(`${start}|${relation}|${end}`, { start, end, type: relation });
    // Orb draws one nested loop per edge between the same pair, so several
    // self-relationship types would turn into a spiral. Keep a single loop per
    // type and list the relationship types it stands for.
    const isSelf = start === end;
    const key = isSelf ? `${start}|self` : `${start}|${relation}|${end}`;
    let existing = relations.get(key);
    if (!existing) {
      existing = { id: `schema-${relations.size + 1}-${key}`, start, end, labels: new Set(), count: 0, attributes: new Set(), isSelf, hasUnlabeled: false };
      relations.set(key, existing);
    }
    if (hasRelation) existing.labels.add(relation);
    else existing.hasUnlabeled = true;
    existing.count += 1;
    Object.keys(edge.attributes ?? {}).forEach(attr => existing.attributes.add(attr));
  });

  return { nodes: [...types.values()], edges: [...relations.values()], types, relationTypes };
}

// A schema edge may stand for several relationship types (all self-loops of one
// type collapse into a single loop); keep the diagram label short and show the
// full list in the details panel instead. Unlabelled edges get no label.
function schemaEdgeLabel(entry) {
  const labels = [...entry.labels];
  if (labels.length === 0) return undefined;
  return labels.length === 1 ? labels[0] : `${labels.length} types`;
}

let schemaDirty = false;

function renderSchema(recenter = false) {
  if (schemaOrb) { schemaOrb.destroy?.(); schemaElement.replaceChildren(); schemaOrb = undefined; }
  if (!schemaModel.nodes.length) { renderSchemaMeta(); return; }
  const nodes = schemaModel.nodes.map(entry => ({ id: entry.id, label: entry.id, count: entry.count }));
  const edges = schemaModel.edges.map(entry => ({ id: entry.id, start: entry.start, end: entry.end, label: schemaEdgeLabel(entry), count: entry.count }));
  schemaOrb = new OrbView(schemaElement, {
    layout: {
      type: 'force',
      options: {
        isPhysicsEnabled: Boolean(physicsEnabled),
        useGPU: false,
        // Types need more room than individual nodes so labels stay readable.
        links: { distance: 170, strength: 0.7, iterations: 1 },
        manyBody: { strength: -900, theta: 0.9, distanceMin: 1, distanceMax: 5000 },
        collision: { radius: 60, strength: 1, iterations: 1 }
      }
    },
    render: {
      node: { size: 26 },
      // A schema is usually a handful of types; without a zoom cap "fit view"
      // blows a two-type schema up to a giant circle.
      maxZoom: 1.15,
      fitZoomMargin: 0.45
    }
  });
  schemaOrb.data.setup({ nodes, edges });
  styleSchema();
  schemaOrb.events.on(OrbEventType.NODE_CLICK, ({ node }) => selectSchemaKind('type', node.getData().id));
  schemaOrb.events.on(OrbEventType.EDGE_CLICK, ({ edge }) => selectSchemaKind('relationship', edge.getData().id));
  schemaOrb.events.on(OrbEventType.MOUSE_CLICK, ({ subject }) => { if (!subject) clearSelection(); });
  keepPhysicsRunning(schemaOrb);
  schemaOrb.render(() => {
    renderSchemaMeta();
    if (recenter) {
      try { schemaOrb.recenter(); } catch (error) { /* view may not be ready yet */ }
      // `once`: a permanent listener would re-fit the view every time the
      // simulation settles (including after every node drag).
      try { schemaOrb.events.once(OrbEventType.SIMULATION_END, () => { try { schemaOrb.recenter(); } catch (error) { /* ignore */ } }); } catch (error) { /* ignore */ }
      setTimeout(() => { try { schemaOrb.recenter(); } catch (error) { /* ignore */ } }, 700);
    }
  });
  schemaDirty = false;
}

function styleSchema() {
  if (!schemaOrb) return;
  const colors = canvasColors[theme];
  const context = getSchemaSelectionContext();
  schemaOrb.data.getNodes().forEach(node => {
    const data = node.getData();
    const isActive = schemaSelection?.kind === 'type' && schemaSelection.id === String(data.id);
    const dimmed = Boolean(schemaSelection) && !context.types.has(String(data.id));
    node.setStyle({
      label: String(data.label ?? data.id),
      shape: 'circle',
      size: isActive ? 19 : 16,
      color: dimmed ? colors.nodeMuted : colourFor(data.id),
      borderColor: isActive ? colors.activeBorder : colors.nodeBorder,
      borderWidth: isActive ? 4 : 1.5,
      fontColor: dimmed ? colors.nodeMuted : colors.nodeLabel,
      fontSize: 12
    });
  });
  schemaOrb.data.getEdges().forEach(edge => {
    const data = edge.getData();
    const isActive = schemaSelection?.kind === 'relationship' && schemaSelection.id === String(data.id);
    const dimmed = Boolean(schemaSelection) && !context.edges.has(String(data.id));
    edge.setStyle({
      label: data.label || undefined,
      color: dimmed ? colors.edgeMuted : (isActive ? colors.edgeActive : colors.edge),
      width: isActive ? 2.4 : 1.4,
      fontColor: colors.edgeLabel,
      fontSize: 10,
      arrowSize: model.directed ? 4 : 0
    });
  });
}

function getSchemaSelectionContext() {
  const types = new Set();
  const edges = new Set();
  if (!schemaSelection) return { types, edges };
  if (schemaSelection.kind === 'type') {
    types.add(schemaSelection.id);
    schemaModel.edges.forEach(relation => {
      if (relation.start !== schemaSelection.id && relation.end !== schemaSelection.id) return;
      edges.add(relation.id); types.add(relation.start); types.add(relation.end);
    });
  } else {
    const relation = schemaModel.edges.find(entry => entry.id === schemaSelection.id);
    if (relation) { edges.add(relation.id); types.add(relation.start); types.add(relation.end); }
  }
  return { types, edges };
}

function selectSchemaKind(kind, id) {
  const source = kind === 'type' ? schemaModel.nodes : schemaModel.edges;
  const item = source.find(entry => String(entry.id) === String(id));
  if (!item) return;
  schemaSelection = { kind, id: String(item.id), item };
  styleSchema();
  showDetails();
}

function renderSchemaMeta() {
  if (!viewHint) return;
  if (currentView !== 'schema') { viewHint.textContent = ''; return; }
  if (!schemaModel.nodes.length) { viewHint.textContent = 'No graph loaded'; return; }
  const types = schemaModel.nodes.length;
  // Count relationship types, not drawn edges: self-loops collapse into one.
  const relations = schemaModel.relationTypes.size;
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  viewHint.textContent = `${plural(types, 'node type')} · ${plural(relations, 'relationship type')}`;
}

function setView(view) {
  currentView = ['schema', 'editor'].includes(view) ? view : 'graph';
  viewTabs.forEach(tab => {
    const active = tab.dataset.view === currentView;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  graphSlot.classList.toggle('is-hidden', currentView !== 'graph');
  schemaSlot.classList.toggle('is-hidden', currentView !== 'schema');
  editorSlot.classList.toggle('is-hidden', currentView !== 'editor');
  canvasStack?.classList.toggle('is-editor', currentView === 'editor');
  // The welcome overlay is shown until a graph is loaded, and never covers the
  // editor: an empty source there is a normal starting point, not an empty app.
  emptyState.hidden = hasGraph || currentView === 'editor';
  if (currentView === 'schema' && schemaDirty) renderSchema(true);
  if (currentView === 'editor') {
    ensurePreview();
    // A hidden slot measures 0×0, and the layout is still collapsed right after
    // setup — fitting then would frame a cloud of coincident nodes. Fit once the
    // tab is visible and the force simulation has settled.
    if (previewNeedsFit && previewModel.nodes.length) requestPreviewFit();
  }
  renderSchemaMeta();
  // The details panel mirrors the active view's own selection state.
  showDetails();
}

viewTabs.forEach(tab => tab.addEventListener('click', () => setView(tab.dataset.view)));

function renderGraph(recenter = false) {
  if (orb) { orb.destroy?.(); graphElement.replaceChildren(); }
  const nodes = model.nodes.map(node => ({ id: node.id, label: node.label, type: node.type, ...node.attributes }));
  const edges = model.edges.map(edge => ({ id: edge.id, start: edge.start, end: edge.end, label: edge.label, ...edge.attributes }));
  const orbOptions = {
    layout: {
      type: 'force',
      // Use API-correct force layout options
      options: {
        isPhysicsEnabled: Boolean(physicsEnabled),
        useGPU: false,
        // tweak forces and link distances for readability
        links: { distance: 70, strength: 0.8, iterations: 1 },
        manyBody: { strength: -120, theta: 0.9, distanceMin: 1, distanceMax: 5000 },
        collision: { radius: 12, strength: 1, iterations: 1 }
      }
    },
    render: {
      node: { size: 10 }
    }
  };

  orb = new OrbView(graphElement, orbOptions);
  orb.data.setup({ nodes, edges });
  styleElements();
  orb.events.on(OrbEventType.NODE_CLICK, ({ node }) => select('node', node.getData().id));
  orb.events.on(OrbEventType.EDGE_CLICK, ({ edge }) => select('edge', edge.getData().id));
  orb.events.on(OrbEventType.MOUSE_CLICK, ({ subject }) => { if (!subject) clearSelection(); });
  keepPhysicsRunning(orb);
  orb.render(() => {
    if (recenter) {
      // try immediate recenter
      try { orb.recenter(); } catch (e) { }
      // also recenter once the force simulation ends (if any) — `once`, because
      // a permanent listener re-fits the view every time the layout settles,
      // e.g. right after a node drag, which looks like an unwanted zoom jump.
      try {
        orb.events.once(OrbEventType.SIMULATION_END, () => { try { orb.recenter(); } catch (e) { } });
      } catch (e) { }
      // fallback: recenter after a short delay in case simulation events aren't fired
      setTimeout(() => { try { orb.recenter(); } catch (e) { } }, 600);
    }
  });
}

// Orb stops its d3 simulation as soon as alpha decays below alphaMin. Dragging a
// node restarts it, but the restart only happens once, at drag start — so a slow
// drag, or simply pausing before releasing the node, lets alpha run out while
// the pointer is still down. From that point on the engine has no running
// simulation: releasing the node only unpins it and the whole layout freezes,
// which reads as "physics stopped working after dropping a node". Re-arm the
// simulation whenever a drag ends and nothing is running any more.
function keepPhysicsRunning(view) {
  let running = false;
  view.events.on(OrbEventType.SIMULATION_START, () => { running = true; });
  view.events.on(OrbEventType.SIMULATION_END, () => { running = false; });
  view.events.on(OrbEventType.NODE_DRAG_END, () => {
    if (running || !physicsEnabled) return;
    // releaseNodes() clears the per-node pin and restarts the simulation
    // (isSimulatingOnUnstick is on by default), so the layout moves again.
    try { view.releaseNodes(); } catch (error) { /* view may have been replaced */ }
  });
}

function styleElements() {
  if (!orb) return;
  const context = getSelectionContext();
  const colors = canvasColors[theme];
  orb.data.getNodes().forEach(node => {
    const data = node.getData();
    const isActive = selected?.kind === 'node' && selected.id === String(data.id);
    node.setStyle({
      label: String(data.label ?? data.id),
      color: selected && !context.nodes.has(String(data.id)) ? colors.nodeMuted : (isActive ? colors.nodeActive : colourFor(data.type)),
      size: isActive ? 13 : 9,
      borderColor: isActive ? colors.activeBorder : colors.nodeBorder,
      borderWidth: isActive ? 3 : 1,
      fontColor: colors.nodeLabel,
      fontSize: 11
    });
  });
  orb.data.getEdges().forEach(edge => {
    const data = edge.getData();
    const isActive = context.edges.has(String(data.id));
    edge.setStyle({
      label: data.label || undefined,
      color: selected && !isActive ? colors.edgeMuted : (isActive ? colors.edgeActive : colors.edge),
      width: 1.2,
      fontColor: colors.edgeLabel,
      fontSize: 9,
      arrowSize: model.directed ? 3 : 0
    });
  });
}

// Paint the effective theme (dark or light). Called on mode changes, on system
// preference changes while in auto mode, and once at start-up.
function applyTheme(nextTheme, { persist = true } = {}) {
  theme = nextTheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  themeColorMeta?.setAttribute('content', theme === 'light' ? '#f4f7fa' : '#101d2e');
  if (persist) {
    try { localStorage.setItem(THEME_KEY, themeMode); } catch (error) { /* ignore unavailable storage */ }
  }
  // Orb draws on a canvas, so its colours must be re-applied by hand.
  styleElements();
  styleSchema();
  stylePreview();
}

const resolveTheme = (mode) => (mode === 'auto' ? (systemDarkQuery.matches ? 'dark' : 'light') : mode);

const updateThemeLabel = () => {
  if (!themeToggle) return;
  const next = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
  const describe = { auto: 'auto (follows system)', light: 'light', dark: 'dark' };
  const label = `Theme: ${describe[themeMode]} — switch to ${describe[next]}`;
  themeToggle.title = label;
  themeToggle.setAttribute('aria-label', label);
};

function applyThemeMode(mode, { persist = true } = {}) {
  themeMode = THEME_MODES.includes(mode) ? mode : 'auto';
  document.documentElement.dataset.themeMode = themeMode;
  updateThemeLabel();
  applyTheme(resolveTheme(themeMode), { persist });
}

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const next = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
    applyThemeMode(next);
  });
}
// Keep auto mode live when the OS switches between light and dark.
systemDarkQuery.addEventListener('change', () => {
  if (themeMode === 'auto') applyTheme(resolveTheme('auto'), { persist: false });
});
applyThemeMode(themeMode, { persist: false });

// Listen to toggle changes and update settings live
if (physicsToggle) {
  physicsToggle.addEventListener('change', (e) => {
    physicsEnabled = e.target.checked;
    if (orb) {
      orb.setSettings({ layout: { type: 'force', options: { isPhysicsEnabled: Boolean(physicsEnabled) } } });
    }
    if (schemaOrb) {
      schemaOrb.setSettings({ layout: { type: 'force', options: { isPhysicsEnabled: Boolean(physicsEnabled) } } });
    }
    if (previewOrb) {
      previewOrb.setSettings({ layout: { type: 'force', options: { isPhysicsEnabled: Boolean(physicsEnabled) } } });
    }
  });
}

function select(kind, id) {
  if (currentView === 'schema') { selectSchemaKind(kind === 'node' ? 'type' : 'relationship', id); return; }
  const item = (kind === 'node' ? model.nodes : model.edges).find(entry => entry.id === String(id));
  if (!item) return;
  selected = { kind, id: item.id, item };
  showDetails();
  styleElements();
}

function clearSelection() {
  let changed = false;
  if (selected) { selected = null; changed = true; }
  if (schemaSelection) { schemaSelection = null; changed = true; styleSchema(); }
  if (previewSelection) { previewSelection = null; changed = true; stylePreview(); renderPreviewStatus(); }
  if (!changed) return;
  showDetails();
  styleElements();
}

function showDetails() {
  const details = document.querySelector('#selection-details'); const empty = document.querySelector('#selection-empty');
  const eyebrow = document.querySelector('#details-eyebrow');
  const current = currentView === 'schema' ? schemaSelection : currentView === 'editor' ? previewSelection : selected;
  if (eyebrow) eyebrow.textContent = currentView === 'schema' ? 'SCHEMA DETAILS' : currentView === 'editor' ? 'PREVIEW DETAILS' : 'SELECTION DETAILS';
  if (empty) {
    empty.querySelector('p').textContent = currentView === 'schema'
      ? 'Click a node type or relationship to see its aggregate details.'
      : currentView === 'editor'
        ? 'Click a node or edge in the preview to see its details.'
        : 'Click a node or edge to see its attributes and relationships.';
  }
  details.hidden = !current; empty.hidden = Boolean(current);
  if (!current) return;
  const kindBadge = document.querySelector('#selection-kind');
  const title = document.querySelector('#selection-title');
  const rows = {};
  let related = 0;
  let relatedLabel = '';

  if (current === schemaSelection) {
    // Schema entries are aggregated: show the counts instead of raw attributes.
    if (current.kind === 'type') {
      kindBadge.textContent = 'NODE TYPE';
      title.textContent = current.item.id;
      // Count relationship types (not drawn edges): several types can collapse
      // into one edge, and unlabelled edges still count as one unnamed type.
      related = [...schemaModel.relationTypes.values()]
        .filter(relation => relation.start === current.item.id || relation.end === current.item.id).length;
      relatedLabel = 'relationship types';
      rows.type = current.item.id;
      rows.nodes = current.item.count;
      if (current.item.attributes.size) rows['attribute keys'] = [...current.item.attributes].join(', ');
    } else {
      kindBadge.textContent = current.item.isSelf ? 'SELF RELATIONSHIP' : 'RELATIONSHIP';
      title.textContent = current.item.isSelf ? `${current.item.start} ⟲` : `${current.item.start} → ${current.item.end}`;
      related = current.item.isSelf ? 1 : 2;
      relatedLabel = 'node types';
      // No label on the underlying edges means there is no type name to show.
      if (current.item.labels.size) rows.type = [...current.item.labels].join(', ');
      rows.start = current.item.start;
      rows.end = current.item.end;
      rows.edges = current.item.count;
      if (current.item.attributes.size) rows['attribute keys'] = [...current.item.attributes].join(', ');
    }
  } else if (current === previewSelection) {
    // The preview has no separate details state — read straight from the model
    // that the last successful parse produced.
    const { kind, id } = previewSelection;
    const item = (kind === 'node' ? previewModel.nodes : previewModel.edges).find(entry => entry.id === id);
    if (!item) return;
    related = kind === 'node' ? previewModel.edges.filter(edge => edge.start === id || edge.end === id).length : 2;
    kindBadge.textContent = kind === 'node' ? 'NODE' : 'EDGE';
    title.textContent = kind === 'node' ? item.label : `${item.start} → ${item.end}`;
    relatedLabel = kind === 'node' ? 'connected edges' : 'connected nodes';
    Object.assign(rows, kind === 'node' ? { id: item.id, type: item.type, ...item.attributes } : { id: item.id, source: item.start, target: item.end, ...item.attributes });
  } else {
    const { kind, item } = selected;
    related = kind === 'node' ? model.edges.filter(e => e.start === item.id || e.end === item.id).length : 2;
    kindBadge.textContent = kind === 'node' ? 'NODE' : 'EDGE';
    title.textContent = kind === 'node' ? item.label : `${item.start} → ${item.end}`;
    relatedLabel = kind === 'node' ? 'connected edges' : 'connected nodes';
    Object.assign(rows, kind === 'node' ? { id: item.id, type: item.type, ...item.attributes } : { id: item.id, source: item.start, target: item.end, ...item.attributes });
  }

  document.querySelector('#relationship-count').textContent = related;
  document.querySelector('#relationship-label').textContent = relatedLabel;
  document.querySelector('#attributes').replaceChildren(...Object.entries(rows).map(([key, value]) => {
    const dt = document.createElement('dt'); dt.textContent = key;
    const dd = document.createElement('dd'); dd.textContent = display(value);
    const row = Object.assign(document.createElement('div'), { className: 'attribute-row' });
    row.append(dt, dd); return row;
  }));
}

function load(text, name) {
  try {
    model = /^\s*(strict\s+)?(di)?graph\b/i.test(text) ? parseDot(text) : parseNodeLink(text);
    selected = null; schemaSelection = null;
    const previousTypes = [...typeOrder.keys()].sort().join('|');
    typeOrder.clear();
    // Keep type colours stable across reloads when the same types are present.
    const stableTypes = previousTypes.split('|').filter(Boolean);
    stableTypes.forEach(type => { if (model.nodes.some(node => node.type === type)) colourFor(type); });
    schemaModel = buildSchema();
    schemaDirty = true;
    hasGraph = true;
    if (schemaOrb) { schemaOrb.destroy?.(); schemaElement.replaceChildren(); schemaOrb = undefined; }
    emptyState.hidden = true;
    // Keep the editor in sync with whatever was just loaded so the source can be
    // tweaked and previewed immediately.
    if (sourceEditor) {
      sourceEditor.value = text;
      // The editor now holds real content — do not replace it with the starter
      // example if the user later clears it.
      hasEditorSeed = true;
      previewSignature = '';
      previewPositions.clear();
      previewModel = { nodes: [], edges: [], directed: true };
      previewSelection = null;
      previewNeedsFit = true;
      if (previewOrb) updatePreview({ force: true });
    }
    showDetails(); renderGraph(true);
    if (currentView === 'schema') renderSchema(true);
    renderSchemaMeta();
    meta.textContent = `${name} · ${model.nodes.length} nodes · ${model.edges.length} edges`;
    message(`Loaded "${name}"`);
  } catch (error) { message(error.message || 'Failed to read the file.', true); }
}

function message(text, isError = false) { toast.textContent = text; toast.classList.toggle('error', isError); toast.classList.add('visible'); clearTimeout(message.timer); message.timer = setTimeout(() => toast.classList.remove('visible'), 3400); }
function handleFile(file) { if (!file) return; file.text().then(text => load(text, file.name)); }

// ---------------------------------------------------------------------------
// Editor view
//
// A source editor on the left and a live Orb preview on the right. The preview
// keeps its node positions between keystrokes (`getPosition` + a snapshot map)
// so the layout does not jump around while typing, and a failed parse leaves
// the last good preview on screen with the error reported in the status bar.
// ---------------------------------------------------------------------------
const looksLikeDot = (text) => /^\s*(strict\s+)?(di)?graph\b/i.test(text);
const parseSource = (text) => (looksLikeDot(text) ? parseDot(text) : parseNodeLink(text));

// Small example that shows both node attributes and labelled edges, so the
// first thing in the editor is something worth poking at.
const STARTER_SOURCE = `digraph {
  client [type="service"]
  api    [type="service"]
  db     [type="store"]

  client -> api [label="http", weight="0.9"]
  api    -> db  [label="query", weight="0.4"]
  api    -> api [label="retry"]
}
`;

const previewPositions = new Map();
let previewSignature = '';
let previewTimer;
let previewNeedsFit = true;

function previewGetPosition(node) {
  const saved = previewPositions.get(String(node.getData().id));
  return saved ? { x: saved.x, y: saved.y } : undefined;
}

function snapshotPreviewPositions() {
  if (!previewOrb) return;
  previewOrb.data.getNodePositions().forEach(position => {
    if (typeof position.x === 'number' && typeof position.y === 'number') {
      previewPositions.set(String(position.id), { x: position.x, y: position.y });
    }
  });
}

// Fit the preview once, after the layout settles. Both paths are one-shot: a
// permanent listener would re-fit the view after every node drag.
function requestPreviewFit() {
  if (!previewOrb || !previewNeedsFit) return;
  previewNeedsFit = false;
  const fit = () => { try { previewOrb?.recenter(); } catch (error) { /* view may be gone */ } };
  try { previewOrb.events.once(OrbEventType.SIMULATION_END, fit); } catch (error) { /* ignore */ }
  setTimeout(fit, 700);
}

function ensurePreview() {
  if (previewOrb) return;
  // An empty editor is a dead end — start with a tiny graph to edit.
  if (!hasEditorSeed && sourceEditor && sourceEditor.value.trim() === '') {
    sourceEditor.value = STARTER_SOURCE;
    hasEditorSeed = true;
    previewNeedsFit = true;
  }
  previewOrb = new OrbView(previewElement, {
    getPosition: previewGetPosition,
    layout: {
      type: 'force',
      options: {
        isPhysicsEnabled: Boolean(physicsEnabled),
        useGPU: false,
        links: { distance: 70, strength: 0.8, iterations: 1 },
        manyBody: { strength: -120, theta: 0.9, distanceMin: 1, distanceMax: 5000 },
        collision: { radius: 12, strength: 1, iterations: 1 }
      }
    },
    render: {
      node: { size: 10 },
      // A hand-written graph is usually tiny. The fit happens after the layout
      // settles, so allowing a generous zoom-in is what makes those graphs
      // readable; the cap only stops a two-node graph from filling the pane.
      maxZoom: 3.2,
      fitZoomMargin: 0.35
    }
  });
  previewOrb.events.on(OrbEventType.NODE_CLICK, ({ node }) => selectPreview('node', node.getData().id));
  previewOrb.events.on(OrbEventType.EDGE_CLICK, ({ edge }) => selectPreview('edge', edge.getData().id));
  previewOrb.events.on(OrbEventType.MOUSE_CLICK, ({ subject }) => { if (!subject) selectPreview(null); });
  keepPhysicsRunning(previewOrb);
  updatePreview({ force: true });
}

function setEditorStatus(text, state = '') {
  if (!editorStatus) return;
  editorStatus.textContent = text;
  editorStatus.classList.toggle('is-error', state === 'error');
  editorStatus.classList.toggle('is-idle', state === 'idle');
}

function selectPreview(kind, id) {
  if (!kind) {
    if (!previewSelection) return;
    previewSelection = null;
    stylePreview();
    renderPreviewStatus();
    showDetails();
    return;
  }
  const item = (kind === 'node' ? previewModel.nodes : previewModel.edges).find(entry => entry.id === String(id));
  if (!item) return;
  previewSelection = { kind, id: item.id };
  stylePreview();
  renderPreviewStatus();
  showDetails();
}

function stylePreview() {
  if (!previewOrb) return;
  const colors = canvasColors[theme];
  const activeNodes = new Set();
  const activeEdges = new Set();
  if (previewSelection?.kind === 'node') {
    activeNodes.add(previewSelection.id);
    previewModel.edges.forEach(edge => {
      if (edge.start !== previewSelection.id && edge.end !== previewSelection.id) return;
      activeEdges.add(edge.id); activeNodes.add(edge.start); activeNodes.add(edge.end);
    });
  } else if (previewSelection?.kind === 'edge') {
    const edge = previewModel.edges.find(entry => entry.id === previewSelection.id);
    if (edge) { activeEdges.add(edge.id); activeNodes.add(edge.start); activeNodes.add(edge.end); }
  }
  const hasSelection = Boolean(previewSelection);

  previewOrb.data.getNodes().forEach(node => {
    const data = node.getData();
    const id = String(data.id);
    const isActive = hasSelection && activeNodes.has(id);
    const dimmed = hasSelection && !isActive;
    node.setStyle({
      label: String(data.label ?? id),
      color: dimmed ? colors.nodeMuted : (isActive ? colors.nodeActive : previewColourFor(data.type)),
      size: isActive ? 13 : 9,
      borderColor: isActive ? colors.activeBorder : colors.nodeBorder,
      borderWidth: isActive ? 3 : 1,
      fontColor: colors.nodeLabel,
      fontSize: 11
    });
  });
  previewOrb.data.getEdges().forEach(edge => {
    const data = edge.getData();
    const isActive = activeEdges.has(String(data.id));
    edge.setStyle({
      label: data.label || undefined,
      color: hasSelection && !isActive ? colors.edgeMuted : (isActive ? colors.edgeActive : colors.edge),
      width: 1.2,
      fontColor: colors.edgeLabel,
      fontSize: 9,
      arrowSize: previewModel.directed ? 3 : 0
    });
  });
}

function renderPreviewStatus(error) {
  if (error) { setEditorStatus(error, 'error'); return; }
  if (!previewModel.nodes.length && !previewModel.edges.length) {
    setEditorStatus('Nothing to preview — type a graph definition.', 'idle');
    return;
  }
  const summary = `${previewModel.nodes.length} nodes · ${previewModel.edges.length} edges`;
  if (!previewSelection) { setEditorStatus(summary); return; }
  if (previewSelection.kind === 'node') {
    const node = previewModel.nodes.find(entry => entry.id === previewSelection.id);
    if (!node) { setEditorStatus(summary); return; }
    const degree = previewModel.edges.filter(edge => edge.start === node.id || edge.end === node.id).length;
    const extras = Object.keys(node.attributes ?? {}).filter(key => !['label', 'type', 'group'].includes(key));
    setEditorStatus(`NODE ${node.id} · ${node.type} · ${degree} edge${degree === 1 ? '' : 's'}${extras.length ? ` · ${extras.join(', ')}` : ''}`);
    return;
  }
  const edge = previewModel.edges.find(entry => entry.id === previewSelection.id);
  if (!edge) { setEditorStatus(summary); return; }
  const extras = Object.keys(edge.attributes ?? {}).filter(key => key !== 'label' && key !== 'weight');
  setEditorStatus(`EDGE ${edge.start} → ${edge.end}${edge.label ? ` · ${edge.label}` : ''}${extras.length ? ` · ${extras.join(', ')}` : ''}`);
}

function updatePreview({ force = false } = {}) {
  if (!sourceEditor) return;
  const text = sourceEditor.value;
  if (editorFormat) {
    const format = text.trim() === '' ? '' : (looksLikeDot(text) ? 'DOT' : 'JSON');
    editorFormat.textContent = format;
    editorFormat.hidden = format === '';
  }
  ensurePreview();

  if (text.trim() === '') {
    snapshotPreviewPositions();
    previewPositions.clear();
    previewModel = { nodes: [], edges: [], directed: true };
    previewSelection = null;
    previewSignature = '';
    // Nothing on screen, so the next real graph should be framed again.
    previewNeedsFit = true;
    previewOrb.data.setup({ nodes: [], edges: [] });
    previewOrb.render();
    renderPreviewStatus();
    return;
  }

  let next;
  try {
    next = parseSource(text);
  } catch (error) {
    // Keep the previous preview visible; a half-typed line is not a reason to
    // blank the canvas.
    renderPreviewStatus(error.message || 'Could not parse the source.');
    return;
  }

  // Only re-run the layout when the topology or labels actually changed — plain
  // whitespace/comment edits should not restart the simulation.
  const signature = next.nodes.map(node => `${node.id}\u0000${node.label}\u0000${node.type}`).join('\u0001')
    + '\u0002' + next.edges.map(edge => `${edge.id}\u0000${edge.start}\u0000${edge.end}\u0000${edge.label}`).join('\u0001');
  const changed = force || signature !== previewSignature;
  previewSignature = signature;
  previewModel = next;
  previewTypeOrder.clear();
  next.nodes.forEach(node => previewColourFor(node.type));
  if (previewSelection && !(previewSelection.kind === 'node' ? next.nodes : next.edges).some(entry => entry.id === previewSelection.id)) {
    previewSelection = null;
  }

  if (changed) {
    // Nodes that have no saved position are brand new — the view was framed for
    // a different graph, so it has to be fitted again. Edits that only relabel
    // or rewire existing nodes keep the current view.
    const hasNewNodes = force || next.nodes.some(node => !previewPositions.has(String(node.id)));
    snapshotPreviewPositions();
    // Drop positions of nodes that disappeared so a re-added node starts fresh.
    const liveIds = new Set(next.nodes.map(node => node.id));
    [...previewPositions.keys()].forEach(id => { if (!liveIds.has(id)) previewPositions.delete(id); });
    const nodes = next.nodes.map(node => ({ id: node.id, label: node.label, type: node.type, ...node.attributes }));
    const edges = next.edges.map(edge => ({ id: edge.id, start: edge.start, end: edge.end, label: edge.label, ...edge.attributes }));
    previewOrb.data.setup({ nodes, edges });
    previewOrb.render();
    if (hasNewNodes && currentView === 'editor') {
      previewNeedsFit = true;
      requestPreviewFit();
    }
  }
  stylePreview();
  renderPreviewStatus();
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 220);
}

if (sourceEditor) {
  sourceEditor.addEventListener('input', schedulePreview);
  // Tab indents inside the editor instead of moving focus out of it.
  sourceEditor.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    sourceEditor.setRangeText('  ', sourceEditor.selectionStart, sourceEditor.selectionEnd, 'end');
    schedulePreview();
  });
}

if (editorOpen) {
  editorOpen.addEventListener('click', () => {
    const text = sourceEditor.value;
    if (text.trim() === '') { message('The editor is empty.', true); return; }
    try { parseSource(text); } catch (error) { message(error.message || 'Could not parse the source.', true); return; }
    load(text, 'editor');
    setView('graph');
  });
}

fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
document.querySelector('#browse-button').addEventListener('click', () => fileInput.click());
document.querySelector('#fit-button').addEventListener('click', () => {
  if (currentView === 'schema') schemaOrb?.recenter();
  else if (currentView === 'editor') previewOrb?.recenter();
  else orb?.recenter();
});
document.querySelector('#clear-selection').addEventListener('click', clearSelection);
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') fileInput.click(); });
['dragenter', 'dragover'].forEach(event => document.addEventListener(event, e => { e.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(event => document.addEventListener(event, e => { e.preventDefault(); dropZone.classList.remove('dragging'); }));
document.addEventListener('drop', event => handleFile(event.dataTransfer.files[0]));
document.querySelectorAll('.sample-button').forEach(button => button.addEventListener('click', async () => {
  const isJson = button.dataset.sample === 'json'; const path = isJson ? '/examples/nodelink.json' : '/examples/graphviz.dot';
  const response = await fetch(path); load(await response.text(), isJson ? 'nodelink.json' : 'graphviz.dot');
}));

