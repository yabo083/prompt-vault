# Node save semantics

## Decision

The workspace editor presents saved history as nodes rather than source-control objects.

- Save atomically replaces the content and assets of the node displayed in the editor while preserving its ID, parents, children, and marks.
- Save As creates a new child node from the edited content and leaves the displayed node unchanged.
- Cancel closes without writing editor changes.
- The context menu exposes only implemented node operations: Edit, Featured, Compare, Share Card, and Delete. Copy, Paste, node-level Favorite, and unimplemented shortcut hints stay hidden.

If Save replaces the Draft's clean Base Revision, the Draft is updated in the same transaction so the canvas does not gain a false unsaved node. Replacing another node does not disturb the current Draft.
