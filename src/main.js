import { OrbEventType, OrbView } from '@memgraph/orb';
import parseDotSource from 'dotparser';
import './style.css';

const graphElement = document.querySelector('#graph');
const emptyState = document.querySelector('#empty-state');
const dropZone = document.querySelector('#drop-zone');
const fileInput = document.querySelector('#file-input');
const meta = document.querySelector('#graph-meta');
const toast = document.querySelector('#toast');
let orb;
let model = { nodes: [], edges: [], directed: true };
let selected = null;
const physicsToggle = document.querySelector('#physics-toggle');
let physicsEnabled = physicsToggle ? physicsToggle.checked : true;

const palette = ['#52d5bc', '#6fa8ff', '#ffad75', '#b792ff', '#f5d66f', '#f285aa'];
const hash = (value) => [...String(value)].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
const colourFor = (type) => palette[Math.abs(hash(type || 'node')) % palette.length];
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

function renderGraph(recenter = false) {
  if (orb) { orb.destroy?.(); graphElement.replaceChildren(); }
  const context = getSelectionContext();
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
  orb.data.getNodes().forEach(node => {
    const data = node.getData(); const isActive = selected?.kind === 'node' && selected.id === String(data.id);
    node.setStyle({ label: String(data.label ?? data.id), color: selected && !context.nodes.has(String(data.id)) ? '#25364b' : (isActive ? '#f7fbff' : colourFor(data.type)), size: isActive ? 13 : 9, borderColor: isActive ? '#6ea7ff' : '#d9ecff', borderWidth: isActive ? 3 : 1, fontColor: '#dce8f5', fontSize: 11 });
  });
  orb.data.getEdges().forEach(edge => {
    const data = edge.getData(); const isActive = context.edges.has(String(data.id));
    edge.setStyle({ label: data.label || undefined, color: selected && !isActive ? '#24364c' : (isActive ? '#65cdb9' : '#839bb5'), width: isActive ? 3 : 1.2, fontColor: '#aebfd2', fontSize: 9, arrowSize: model.directed ? 7 : 0 });
  });
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

function updateStyles() {
  if (!orb) return;
  const context = getSelectionContext();
  orb.data.getNodes().forEach(node => {
    const data = node.getData();
    const isActive = selected?.kind === 'node' && selected.id === String(data.id);
    node.setStyle({
      label: String(data.label ?? data.id),
      color: selected && !context.nodes.has(String(data.id)) ? '#25364b' : (isActive ? '#f7fbff' : colourFor(data.type)),
      size: isActive ? 13 : 9,
      borderColor: isActive ? '#6ea7ff' : '#d9ecff',
      borderWidth: isActive ? 3 : 1,
      fontColor: '#dce8f5',
      fontSize: 11
    });
  });
  orb.data.getEdges().forEach(edge => {
    const data = edge.getData();
    const isActive = context.edges.has(String(data.id));
    edge.setStyle({
      label: data.label || undefined,
      color: selected && !isActive ? '#24364c' : (isActive ? '#65cdb9' : '#839bb5'),
      width: isActive ? 3 : 1.2,
      fontColor: '#aebfd2',
      fontSize: 9,
      arrowSize: model.directed ? 7 : 0
    });
  });
}

// Listen to toggle changes and update settings live
if (physicsToggle) {
  physicsToggle.addEventListener('change', (e) => {
    physicsEnabled = e.target.checked;
    if (orb) {
      orb.setSettings({ layout: { type: 'force', options: { isPhysicsEnabled: Boolean(physicsEnabled) } } });
    }
  });
}

function select(kind, id) {
  const item = (kind === 'node' ? model.nodes : model.edges).find(entry => entry.id === String(id));
  if (!item) return;
  selected = { kind, id: item.id, item };
  showDetails();
  updateStyles();
}

function clearSelection() { if (!selected) return; selected = null; showDetails(); updateStyles(); }

function showDetails() {
  const details = document.querySelector('#selection-details'); const empty = document.querySelector('#selection-empty');
  details.hidden = !selected; empty.hidden = Boolean(selected);
  if (!selected) return;
  const { kind, item } = selected;
  const related = kind === 'node' ? model.edges.filter(e => e.start === item.id || e.end === item.id).length : 2;
  document.querySelector('#selection-kind').textContent = kind === 'node' ? 'NODE' : 'EDGE';
  document.querySelector('#selection-title').textContent = kind === 'node' ? item.label : `${item.start} → ${item.end}`;
  document.querySelector('#relationship-count').textContent = related;
  document.querySelector('#relationship-label').textContent = kind === 'node' ? 'connected edges' : 'connected nodes';
  const rows = kind === 'node' ? { id: item.id, type: item.type, ...item.attributes } : { id: item.id, source: item.start, target: item.end, ...item.attributes };
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
    selected = null; emptyState.hidden = true; showDetails(); renderGraph(true);
    meta.textContent = `${name} · ${model.nodes.length} nodes · ${model.edges.length} edges`;
    message(`Loaded "${name}"`);
  } catch (error) { message(error.message || 'Failed to read the file.', true); }
}

function message(text, isError = false) { toast.textContent = text; toast.classList.toggle('error', isError); toast.classList.add('visible'); clearTimeout(message.timer); message.timer = setTimeout(() => toast.classList.remove('visible'), 3400); }
function handleFile(file) { if (!file) return; file.text().then(text => load(text, file.name)); }

fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
document.querySelector('#browse-button').addEventListener('click', () => fileInput.click());
document.querySelector('#fit-button').addEventListener('click', () => orb?.recenter());
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
