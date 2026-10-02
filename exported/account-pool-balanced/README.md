# Balanced Account Pooler

This fork adds configurable least-usage routing to BB's Account Pooler. New conversations select the eligible account with the lowest utilization. A five-percentage-point margin avoids moving the preferred account for small usage differences. Each conversation keeps its assigned account across idle periods and restarts.

Install the Git-managed package:

```sh
bb plugin disable account-pool
bb plugin install git:https://github.com/stephendolan/bb.git@feat/account-pool-least-usage --subdirectory exported/account-pool-balanced
bb pool config set selectionMode least-usage
bb pool config set balanceThreshold 0.05
```

Disable the bundled Account Pooler before enabling this plugin: both provide `bb pool` and provider routing. Existing installations require migration of plugin KV configuration, account metadata, the quota and affinity database, and protected account and host-token files. Preserve account IDs and provider conversation IDs. Perform migration while provider turns are idle; provider sessions adopt the new endpoint on their next turn. Do not uninstall the bundled plugin or delete its credentials during migration.

Source is maintained in `plugins/account-pool`. From the repository root, regenerate the standalone package with `node scripts/export-balanced-account-pool.mjs <deployed-sdk-version>`, install its dependencies, and run `bb plugin build exported/account-pool-balanced` using the deployed BB SDK. Commit the standalone source and `dist` artifacts together. The component registry supplies the vendored UI dependencies.

Update installed releases with `bb plugin update account-pool-balanced`. BB application updates preserve the managed Git installation and its data. An incompatible SDK update can require rebuilding and publishing compatible artifacts.
