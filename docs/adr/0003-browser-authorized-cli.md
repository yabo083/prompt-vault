# Authenticate the CLI through Vault Hosts

The CLI configures one or more Vault Hosts and uses a browser-approved, revocable credential for each host, following the interaction model of `gh auth login`. The CLI replaces raw HTTP usage for people and agents, while HTTP remains the transport required by remote hosts and the browser application; passwords and long-lived master tokens are not accepted as routine CLI arguments.
