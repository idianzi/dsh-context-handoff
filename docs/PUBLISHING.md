# Publishing `dsh-context-handoff`

This is the release checklist for maintainers. It assumes the npm package name `dsh-context-handoff` is still available (it was unclaimed when the package was created; re-check before publishing).

## 0. Prerequisites

- An npm account with publish rights to `dsh-context-handoff`.
- A public GitHub repository. The market requires the repo to be at least one day old and to carry the `dsh-plugin` topic.
- DSH 0.2.1-rc.3 or a compatible 0.2.x runtime for verification.

## 1. Fill repository metadata

These values are already set for `idianzi/dsh-context-handoff`; update them if the repository moves:

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/idianzi/dsh-context-handoff.git"
  },
  "homepage": "https://github.com/idianzi/dsh-context-handoff#readme",
  "bugs": {
    "url": "https://github.com/idianzi/dsh-context-handoff/issues"
  }
}
```

Also update the `author` field if you want your name/handle published.

## 2. Verify the package

```sh
cd dsh-context-handoff
npm test
npm run check
npm run pack:check
```

`npm pack --dry-run` must list only:

```text
lib/
docs/
examples/
cordis.patch.yml
README.md
README.zh.md
CHANGELOG.md
LICENSE
package.json
```

No `node_modules`, tests, local scratch files, or `.DS_Store`. The `files` whitelist in `package.json` enforces this.

Check the client bundle is present and the browser manifest resolves:

```sh
node --check lib/client.js
node -e "const p=require('./package.json'); console.log(p.dsh.client, p.exports['./client'])"
```

The Web sidebar tab is served from `lib/client.js`; a package missing it still boots the host half but has no panel.

Check the name is still free:

```sh
npm view dsh-context-handoff version
# 404 / E404 means free; a version means taken
```

## 3. Verify it loads in a disposable profile

Do this before publishing, and again against the published tarball. It proves the bundle patch, schema, and peer resolution work outside the development copy.

```sh
# Create a disposable profile from the web template, then add the local package.
dsh --profile handoff-check --from-default-profile web --help >/dev/null 2>&1 || true
dsh plugin --profile handoff-check add link:/absolute/path/to/dsh-context-handoff

# Dump the composed config and schema. The schema dump imports the plugin,
# so a bad module or config schema fails here.
dsh --profile handoff-check --dump-config-schema > /tmp/handoff-schema.json
grep -n "context-handoff\|targetDigestTokens\|recommendAtRatio" /tmp/handoff-schema.json
```

Expected: the `context-handoff` entry appears in the composed tree, and the schema contains the config fields. If the profile uses the CLI web template, `dsh --profile handoff-check` should also start without a load error; stop it after confirming.

Then open the Web UI, add the **上下文交接** tab from the right sidebar's add menu, and check that the switch, current tokens, and recommendation point render. Toggle it once and confirm `.dsh/handoff/auto.json` appears in the workspace.

To check the actual command, start that profile, open the Web UI, and run `/handoff help`, `/handoff plan`, then `/handoff`. A disposable profile keeps the experiment out of your daily profile.

Clean up:

```sh
rm -rf "$HOME/.dsh/profiles/handoff-check"
```

## 4. Publish to npm

```sh
npm login
npm publish --access public
```

The package is unscoped, so `--access public` is redundant but harmless. If your account enforces 2FA, complete the prompt. Optionally publish with provenance from CI instead of a local shell.

Verify:

```sh
npm view dsh-context-handoff version dist.tarball
```

## 5. Install from the registry

```sh
dsh plugin --profile web add dsh-context-handoff@0.2.4
```

For Desktop, use **Plugins → Discover** (or the plugin manager) rather than editing the reserved Desktop profile while the app is running. Confirm `/handoff help` after the reload.

## 6. List it in the market

The market reads the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) catalog. Do **not** PR the market app repository.

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`.
2. Add one file at `data/plugins/idianzi__dsh-context-handoff.yml` using the format below. The repository name and the npm package name do not have to match, but a `dsh.bundle` manifest in `package.json` is mandatory and is checked automatically.
3. Open a PR. The README and the format-1 market index are regenerated after merge; do not edit the generated README by hand.

`data/plugins/idianzi__dsh-context-handoff.yml`:

```yaml
url: https://github.com/idianzi/dsh-context-handoff
name: idianzi/dsh-context-handoff
category: session
description:
  en: Token-aware context handoff for DSH: summarize a long session into a Markdown file, compare continue-versus-switch token costs, and resume in a fresh session.
  zh: 面向 DSH 的 token 感知上下文交接：把长会话总结成 Markdown 文件，比较继续与开新会话的 token 成本，并在新会话中续接。
```

`examples/awesome-dsh-plugin.yml` is a copy of this entry with placeholders.

Requirements from the catalog:

- the repo declares `dsh.bundle` (this package does, via `dsh.bundle.patch`);
- the repo is at least one day old;
- the repo carries the `dsh-plugin` GitHub topic;
- the entry is in the right category. `session` fits "Sessions & Messages"; `memory` or `tools` are plausible alternatives if the catalog maintainers prefer them.

Once merged, users can add the index source in **Plugins → Discover → Index sources**:

```text
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

and install from the Discover tab or with `plugin_market` / `plugin_manager` in DSH.

## 7. Release checklist

- [ ] `npm test` passes.
- [ ] `npm pack --dry-run` contains only intended files.
- [ ] `engines.dsh` matches the tested runtime range.
- [ ] `dsh.compatibility.dshReleases` includes the exact tested version.
- [ ] README install commands use the published name.
- [ ] `repository`, `homepage`, `bugs` are real.
- [ ] Git tag `v0.2.4` pushed.
- [ ] `CHANGELOG.md` has the release entry.
- [ ] Published tarball installs in a disposable profile.
- [ ] Market PR opened.

## Versioning and compatibility

- Patch (`0.1.x`): bug fixes, docs, no config/API changes.
- Minor (`0.x.0`): new config fields or commands; keep old defaults working.
- Major (`1.0.0`): breaking config or output-format changes. The handoff file has `dsh_handoff: 1`; bump the format version if the frontmatter or section contract becomes incompatible.

Before claiming a new DSH release:

1. Run the disposable-profile check against that exact runtime.
2. Add the version to `dsh.compatibility.dshReleases` with a short note about what was verified.
3. Widen `engines.dsh` only after the check passes.

DSH's plugin manager checks `engines.dsh` and the declared DSH peer ranges before installing; an incompatible package is rejected unless the user records an exact-version exemption. Do not widen ranges speculatively.

## Rollback

npm does not allow republishing the same version. If a release is broken:

1. Publish a fixed patch version immediately.
2. If the breakage is severe, `npm deprecate dsh-context-handoff@<bad-version> "reason"`.
3. Do not unpublish unless you understand npm's 72-hour rules and the effect on lockfiles; a deprecation plus a fixed release is the safer path.
