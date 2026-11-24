/**
 * Minimal DOM helpers. Text always goes through createTextNode/textContent so
 * user-entered subject and topic names can never be interpreted as markup.
 */

export function h(tag, props, ...children) {
  const el = document.createElement(tag);

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }

  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/** A labelled form control, used throughout the planner. */
export function field(label, control, hint) {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null,
  );
}

export function select(options, value, onChange, props = {}) {
  const el = h('select', { ...props, onChange: (e) => onChange(e.target.value) },
    ...options.map((opt) => h('option', {
      value: opt.value,
      selected: String(opt.value) === String(value),
    }, opt.label)),
  );
  el.value = value;
  return el;
}

export function button(label, onClick, props = {}) {
  return h('button', { type: 'button', ...props, onClick }, label);
}