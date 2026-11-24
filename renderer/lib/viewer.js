import { h, mount, button } from './dom.js';
import { store } from '../app.js';

/**
 * In-app viewer for attached study material.
 *
 * Images render natively. PDFs are rasterised page by page with PDF.js into a
 * canvas, which keeps rendering identical on every machine instead of relying
 * on the system PDF plugin.
 */

let pdfjs = null;

async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  const lib = await import('/vendor/pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  pdfjs = lib;
  return pdfjs;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1048576) * 10) / 10} MB`;
}

function iconFor(material) {
  if (material.view === 'pdf') return 'PDF';
  if (material.view === 'image') return 'IMG';
  return (material.ext || 'FILE').replace('.', '').toUpperCase().slice(0, 4) || 'FILE';
}

/** Modal overlay; returns a close() so callers can dismiss it programmatically. */
export function openViewer(material, url) {
  const body = h('div', { class: 'viewer-body' });
  const title = h('div', { class: 'viewer-title' },
    h('span', null, material.name),
    h('span', { class: 'viewer-meta' },
      `${formatBytes(material.sizeBytes)}${material.topicName ? ` · ${material.topicName}` : ''}`),
  );

  const overlay = h('div', {
    class: 'viewer-overlay',
    onClick: (e) => { if (e.target === overlay) close(); },
  },
  h('div', { class: 'viewer-panel' },
    h('header', { class: 'viewer-head' },
      title,
      h('div', { class: 'viewer-actions' },
        material.view === null
          ? button('Open in default app', () => {
            window.api.materials.openExternal(store.token, material.id);
          }, { class: 'btn btn-ghost btn-small' })
          : null,
        h('button', {
          class: 'viewer-close', type: 'button', title: 'Close (Esc)', onClick: () => close(),
        }, '×'),
      ),
    ),
    body,
  ));

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (document.body.style.overflow) document.body.style.overflow = '';
  }

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  if (material.view === 'image') renderImage(body, material, url);
  else if (material.view === 'pdf') renderPdf(body, url);
  else renderUnsupported(body, material);

  return { close, overlay };
}

function renderImage(container, material, url) {
  const img = h('img', {
    class: 'viewer-image',
    src: url,
    alt: material.name,
    onError: () => renderUnsupported(container, material),
  });
  mount(container, img);
}

function renderUnsupported(container, material) {
  mount(container, h('div', { class: 'viewer-empty' },
    h('p', null, `StudyFlow cannot preview ${material.ext || 'this file type'} inside the app.`),
    button('Open in default app', async () => {
      await window.api.materials.openExternal(store.token, material.id);
    }, { class: 'btn btn-primary' }),
  ));
}

async function renderPdf(container, url) {
  const status = h('p', { class: 'viewer-status' }, 'Loading PDF...');
  const canvas = h('canvas', { class: 'viewer-canvas' });
  const prev = button('‹ Previous', () => go(-1), { class: 'btn btn-ghost btn-small', disabled: true });
  const next = button('Next ›', () => go(1), { class: 'btn btn-ghost btn-small', disabled: true });
  const pageLabel = h('span', { class: 'viewer-page' }, '—');

  mount(container,
    h('div', { class: 'viewer-pdf' },
      status,
      h('div', { class: 'viewer-canvas-wrap' }, canvas),
      h('div', { class: 'viewer-pdf-bar' }, prev, pageLabel, next),
    ),
  );

  let doc = null;
  let page = 1;

  async function go(delta) {
    const target = page + delta;
    if (!doc || target < 1 || target > doc.numPages) return;
    page = target;
    await draw();
  }

  async function draw() {
    status.textContent = 'Rendering...';
    status.hidden = false;
    try {
      const pdfPage = await doc.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });

      // Fit the width of the panel, then cap the height so one page is visible
      // at a time without the window needing to grow.
      const wrapWidth = canvas.parentElement.clientWidth - 32;
      const scale = Math.min(3, Math.max(0.4, wrapWidth / base.width));
      const viewport = pdfPage.getViewport({ scale });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width)}px`;

      const context = canvas.getContext('2d');
      await pdfPage.render({ canvasContext: context, viewport }).promise;

      status.hidden = true;
      pageLabel.textContent = `Page ${page} of ${doc.numPages}`;
      prev.disabled = page <= 1;
      next.disabled = page >= doc.numPages;
    } catch (err) {
      status.hidden = false;
      status.textContent = `Could not render this page: ${err.message}`;
    }
  }

  try {
    const lib = await loadPdfjs();

    // Fetch the bytes ourselves and hand pdf.js an ArrayBuffer. Letting pdf.js
    // fetch the URL itself makes it attempt HTTP range requests, which the
    // material:// protocol handler does not implement, and the load stalls.
    const response = await fetch(url);
    if (!response.ok) throw new Error(`file could not be read (${response.status})`);
    const buffer = await response.arrayBuffer();

    const task = lib.getDocument({ data: new Uint8Array(buffer) });
    doc = await task.promise;
    await draw();
  } catch (err) {
    status.textContent = `Could not open this PDF: ${err.message}`;
  }
}

/** Small pill used in the material list. */
export function typeBadge(material) {
  return h('span', { class: `filetype filetype-${material.view || 'other'}` }, iconFor(material));
}