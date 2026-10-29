import { OrbEventType, OrbView } from '@memgraph/orb';
import parseDotSource from 'dotparser';
import './style.css';

const graphElement = document.querySelector('#graph');
const schemaElement = document.querySelector('#schema');
const graphSlot = document.querySelector('#graph-slot');
const schemaSlot = document.querySelector('#schema-slot');
const viewTabs = [...document.querySelectorAll('.view-tab')];
const viewHint = document.querySelector('#view-hint');
const emptyState = document.querySelector('#empty-state');
const dropZone = document.querySelector('#drop-zone');
const fileInput = document.querySelector('#file-input');
const meta = document.querySelector('#graph-meta');
const toast = document.querySelector('#toast');
let orb;
let schemaOrb;
let model = { nodes: [], edges: [], directed: true };
let selected = null;
let schemaSelection = null;
let schemaModel = { nodes: [], edges: [], types: new Map(), relationTypes: new Map() };
let currentView = 'graph';
let hasGraph = false;
const physicsToggle = document.querySelector('#physics-toggle');
let physicsEnabled = physicsToggle ? physicsToggle.checked : true;

const themeToggle = document.querySelector('#theme-toggle');
const themeToggleLabel = document.querySelector('#theme-toggle-label');
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
const THEME_KEY = 'graphx-theme';

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

let theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

// Assign colours by first-seen order of the type instead of hashing — hashing
// collides frequently on small palettes (e.g. "image" vs "detection").
const typeOrder = new Map();
const colourFor = (type) => {
  const key = String(type || 'node');
  if (!typeOrder.has(key)) typeOrder.set(key, typeOrder.size);
  const palette = palettes[theme];
  return palette[typeOrder.get(key) % palette.length];
};
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
  schemaOrb.render(() => {
    renderSchemaMeta();
    if (recenter) {
      try { schemaOrb.recenter(); } catch (error) { /* view may not be ready yet */ }
      try { schemaOrb.events.on(OrbEventType.SIMULATION_END, () => { try { schemaOrb.recenter(); } catch (error) { /* ignore */ } }); } catch (error) { /* ignore */ }
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
  currentView = view === 'schema' ? 'schema' : 'graph';
  viewTabs.forEach(tab => {
    const active = tab.dataset.view === currentView;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  graphSlot.classList.toggle('is-hidden', currentView !== 'graph');
  schemaSlot.classList.toggle('is-hidden', currentView !== 'schema');
  // The welcome overlay is shown until a graph is loaded, in both views.
  emptyState.hidden = hasGraph;
  if (currentView === 'schema' && schemaDirty) renderSchema(true);
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
  orb.render(() => {
    if (recenter) {
      // try immediate recenter
      try { orb.recenter(); } catch (e) { }
      // also recenter once the force simulation ends (if any)
      try {
        orb.events.on(OrbEventType.SIMULATION_END, () => { try { orb.recenter(); } catch (e) { } });
      } catch (e) { }
      // fallback: recenter after a short delay in case simulation events aren't fired
      setTimeout(() => { try { orb.recenter(); } catch (e) { } }, 600);
    }
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

function applyTheme(next, { persist = true } = {}) {
  theme = next === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  if (themeToggle) themeToggle.checked = theme === 'light';
  if (themeToggleLabel) {
    const target = theme === 'light' ? 'dark' : 'light';
    themeToggleLabel.title = `Switch to ${target} theme`;
  }
  themeColorMeta?.setAttribute('content', theme === 'light' ? '#f4f7fa' : '#101d2e');
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (error) { /* ignore unavailable storage */ }
  }
  // Orb draws on a canvas, so its colours must be re-applied by hand.
  styleElements();
  styleSchema();
}

if (themeToggle) {
  themeToggle.checked = theme === 'light';
  themeToggle.addEventListener('change', (event) => applyTheme(event.target.checked ? 'light' : 'dark'));
}
applyTheme(theme, { persist: false });

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
  if (!changed) return;
  showDetails();
  styleElements();
}

function showDetails() {
  const details = document.querySelector('#selection-details'); const empty = document.querySelector('#selection-empty');
  const eyebrow = document.querySelector('#details-eyebrow');
  const current = currentView === 'schema' ? schemaSelection : selected;
  if (eyebrow) eyebrow.textContent = currentView === 'schema' ? 'SCHEMA DETAILS' : 'SELECTION DETAILS';
  if (empty) {
    empty.querySelector('p').textContent = currentView === 'schema'
      ? 'Click a node type or relationship to see its aggregate details.'
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
    showDetails(); renderGraph(true);
    if (currentView === 'schema') renderSchema(true);
    renderSchemaMeta();
    meta.textContent = `${name} · ${model.nodes.length} nodes · ${model.edges.length} edges`;
    message(`Loaded "${name}"`);
  } catch (error) { message(error.message || 'Failed to read the file.', true); }
}

function message(text, isError = false) { toast.textContent = text; toast.classList.toggle('error', isError); toast.classList.add('visible'); clearTimeout(message.timer); message.timer = setTimeout(() => toast.classList.remove('visible'), 3400); }
function handleFile(file) { if (!file) return; file.text().then(text => load(text, file.name)); }

fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
document.querySelector('#browse-button').addEventListener('click', () => fileInput.click());
document.querySelector('#fit-button').addEventListener('click', () => currentView === 'schema' ? schemaOrb?.recenter() : orb?.recenter());
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
