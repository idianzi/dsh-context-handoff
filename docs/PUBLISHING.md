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

The market (`dshmarket` and the various storefronts) reads [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) — one YAML file per plugin under `data/plugins/`, published to `https://awesome-dsh-plugin.com/plugins.json`. Do **not** PR the market app repository, and do not edit the generated READMEs.

Everything except the PR itself is already true for this repository:

| Requirement | Status |
|---|---|
| `dsh.bundle` in `package.json` | yes, via `dsh.bundle.patch` → `cordis.patch.yml` |
| `cordis.patch.yml` at the repo root | yes |
| repo public and not archived | yes |
| `dsh-plugin` topic | yes |
| repo at least 1 day old (CI-enforced) | yes, created 2026-10-27 |
| real code with tests | yes, `npm test` runs 50 tests |

Open the PR — no CLI needed:

1. Go to <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> and click **Add file → Create new file**. GitHub forks the repository for you on the first commit.
2. Name it `data/plugins/idianzi__dsh-context-handoff.yml`.
3. Paste [`examples/awesome-dsh-plugin.yml`](../examples/awesome-dsh-plugin.yml). The catalog's `scripts/lib/entries.mjs` requires the filename to equal the URL slug (`owner__repo`), `name` to be `owner/repo`, `category` to come from its fixed set, and only the keys `url` / `name` / `category` / `description` / `icon` / `tarball`.
4. Commit on a new branch and open the PR. One file is the whole submission; up to three entries per PR.

With `gh` installed it collapses to a fork, a file, and one `gh pr create`.

CI checks, in order: entry count ≤ 3, the `dsh.bundle` manifest, repo age ≥ 1 day, then `awesome-lint` and the site build. A failure names exactly what to change, and the fix goes on the same branch.

Notes:

- **The package name is already taken on the list.** `hunyu-feng/dsh-context-handoff` has been listed since 2026-10-23 under `session`, and it also hands a session over near a percentage threshold. Duplicate repo names are common there (470 of ~8100 entries share a basename) and the entry file here is `idianzi__dsh-context-handoff.yml`, so nothing collides mechanically. An overlapping entry survives on "whichever is better", so the description has to carry the difference: the cost model with break-even turns, condensing through the official `/compact` backend *before* switching, and the new-session switch. If a reviewer calls it a duplicate, the fallback is to rename the package (`dsh-handoff-advisor` is free on both npm and the list) and resubmit.
- Descriptions are read as claims about the code. Keep command names and numbers exact — overstating is the one thing that gets an otherwise fine plugin bounced.
- After merge the site rebuilds itself and CI refreshes `plugins.json` daily, so the market shows it within a day.

## 6b. The install command users will see

Source install works today and needs no registry:

```sh
dsh plugin --profile web add github:idianzi/dsh-context-handoff
```

The npm path (`dsh plugin --profile web add dsh-context-handoff`) only works after step 4. Skip npm if you prefer; the catalog note says listing is unaffected either way, and a GitHub Release tarball is the prebuilt alternative.

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
