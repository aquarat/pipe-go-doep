import { escapePointer, atPointer, pointerParts } from './project-state.js';

// Render only expanded branches. Large scores stay cheap to inspect while closed.
export function createJSONTree(root, { onExpanded, onEdit, onError }) {
  root.classList.add('json-tree');
  let project = null, expanded = new Set(), selected = null;
  const collection = value => value !== null && typeof value === 'object';
  const element = (name, className, text) => {
    const el = document.createElement(name); el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  function draw() {
    const scroll = root.scrollTop;
    root.replaceChildren();
    if (!project) return;
    let count = 0;
    function branch(value, key, path, depth) {
      if (++count > 12000) return element('div', 'tree-limit', 'More fields are hidden. Collapse a branch to inspect another.');
      const wrap = element('div', 'tree-branch');
      const row = element('div', 'tree-row');
      row.dataset.path = path;
      row.style.setProperty('--depth', depth);
      if (path === selected) row.classList.add('selected');
      const readOnly = path === '/id' || path === '/_ui' || path.startsWith('/_ui/');
      if (collection(value)) {
        const open = expanded.has(path);
        const toggle = element('button', 'tree-toggle');
        toggle.type = 'button'; toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${key}`);
        toggle.append(element('span', 'tree-arrow', open ? '▾' : '▸'), element('span', 'tree-key', key));
        const length = Object.keys(value).length;
        toggle.append(element('span', 'tree-summary', Array.isArray(value) ? `[ ${length} items ]` : `{ ${length} fields }`));
        toggle.onclick = () => {
          if (!open && expanded.size >= 4096) { onError('Collapse some branches before expanding more.'); return; }
          if (open) expanded.delete(path); else expanded.add(path);
          selected = path;
          onExpanded(Array.from(expanded));
          draw();
          findRow(path)?.querySelector('button')?.focus({ preventScroll: true });
        };
        row.append(toggle); wrap.append(row);
        if (open) {
          for (const [childKey, childValue] of Object.entries(value)) {
            if (count >= 12000) { wrap.append(element('div', 'tree-limit', 'Display limit reached; collapse some branches.')); break; }
            wrap.append(branch(childValue, childKey, path + '/' + escapePointer(childKey), depth + 1));
          }
        }
      } else {
        row.append(element('span', 'tree-leaf-dot', '·'), element('span', 'tree-key', key));
        if (readOnly || value === null) {
          row.append(element('span', 'tree-value readonly', value === null ? 'null' : String(value)));
        } else {
          const input = document.createElement(typeof value === 'boolean' ? 'select' : 'input');
          input.className = 'tree-input';
          if (typeof value === 'boolean') {
            for (const option of ['true', 'false']) { const o = document.createElement('option'); o.value = o.textContent = option; input.append(o); }
          } else { input.type = 'text'; input.spellcheck = false; }
          input.value = String(value);
          input.setAttribute('aria-label', path);
          input.dataset.valueType = typeof value;
          input.onchange = () => {
            try {
              let next = input.value;
              if (typeof value === 'number') { next = Number(next); if (!input.value.trim() || !Number.isFinite(next)) throw Error('Enter a finite number.'); }
              if (typeof value === 'boolean') next = input.value === 'true';
              selected = path;
              onEdit(path, next);
              input.classList.remove('invalid');
            } catch (e) { input.classList.add('invalid'); onError(e.message); }
          };
          input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
          row.append(input);
        }
        row.append(element('span', 'tree-type', typeof value));
        wrap.append(row);
      }
      return wrap;
    }
    root.append(branch(project, 'project', '', 0));
    root.scrollTop = scroll;
  }

  function findRow(path) { return Array.from(root.querySelectorAll('.tree-row')).find(row => row.dataset.path === path); }
  return {
    setProject(value) {
      if (project?.id !== value?.id) selected = null;
      project = value;
      expanded = new Set(Array.isArray(value?._ui?.tree_expanded) ? value._ui.tree_expanded : []);
      draw();
    },
    reveal(path) {
      if (!project || atPointer(project, path) === undefined) return;
      const parts = pointerParts(path); let parent = '';
      const next = new Set(expanded);
      next.add('');
      for (const part of parts) {
        parent += '/' + escapePointer(part);
        if (collection(atPointer(project, parent))) next.add(parent);
      }
      if (next.size > 4096) { onError('Collapse some branches before revealing more fields.'); return; }
      expanded = next;
      selected = path; onExpanded(Array.from(expanded)); draw();
      findRow(path)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    collapseAll() { expanded.clear(); selected = null; onExpanded([]); draw(); },
    destroy() { root.replaceChildren(); project = null; },
  };
}
