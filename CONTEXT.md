# Prompt Vault

Prompt Vault preserves prompt exploration as editable drafts and saved node lineage while keeping the files understandable outside the application.

## Language

**Theme**:
A named prompt exploration containing shared metadata, one draft, and zero or more revisions.
_Avoid_: Repository, project

**Draft**:
The only editable creative state of a theme. A draft may be based on a revision and may contain unsaved changes.
_Avoid_: Working tree, working node

**Revision**:
A saved node snapshot of a theme's creative state and assets. Save replaces the displayed node in place; Save As creates a child node.
_Avoid_: Commit, version node

**Lineage**:
The parent relationships among revisions that explain how prompt explorations diverged or combined.
_Avoid_: Branch tree, commit graph

**Base Revision**:
The revision from which the current draft was restored or continued. A theme without saved revisions has no base revision.
_Avoid_: Working base, HEAD

**Continue**:
Create or replace the draft from a selected revision so a new direction can be explored without changing that revision.
_Avoid_: Checkout, switch branch

**Save Revision**:
Preserve the current draft as a new child revision in its lineage.
_Avoid_: Commit, publish

**Asset**:
An image attached to a draft or revision as either a prompt reference or generated result.

**Vault Host**:
A configured Prompt Vault installation that the CLI can authenticate to and operate against.
_Avoid_: Remote, origin

**CLI Authorization**:
A user-approved credential that grants the CLI access to one Vault Host and can be revoked independently.
_Avoid_: Login session, password
