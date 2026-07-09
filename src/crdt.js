// Bundled to public/vendor/nova-crdt.js via `npm run build`.
// Exposes a tiny Yjs surface on window.NovaY for the collaboration layer.
import * as Y from 'yjs';

window.NovaY = {
  Doc: () => new Y.Doc(),
  applyUpdate: (doc, update) => Y.applyUpdate(doc, update),
  encodeStateAsUpdate: (doc) => Y.encodeStateAsUpdate(doc),
  Y,
};
