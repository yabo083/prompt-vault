# Model exploration as drafts and revisions

Status: Superseded in part by ADR 0003.

Prompt Vault exposes one editable Draft and an immutable Revision DAG instead of Git terminology and named branch management. Existing persisted history and parent relationships remain readable, but branch pointers, checkout language, and commit language are not part of the public interface because Lineage represents creative divergence directly.
