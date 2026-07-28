# Use a shared TypeScript application module

Prompt Vault uses Node.js and TypeScript for the browser, server, CLI, and tests. Domain behavior lives in one application module used through the Hono HTTP adapter by both the browser and CLI, preserving one source of truth while keeping transport and storage details outside the domain contract.
