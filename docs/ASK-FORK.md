# This fork: installing it and keeping it current

This checkout is `SongOnRoc/pi-web`, a fork of `agegr/pi-web` that adds one
feature: the native `ask_user_question` card
([requirements](requirements/ask-user-question-card.md),
[ADR 0008](adr/0008-native-view-for-extension-questions.md)).

It is **not** published to npm. `package.json` names `@agegr/pi-web`, and that
package's Trusted Publisher is `agegr/pi-web`; npm would refuse a publish from
here. Packages are built by GitHub Actions and installed from a `.tgz`, which
needs no registry account.

## Branches

```
upstream/main        agegr/pi-web — read-only, never commit here
origin/main          this fork's copy of upstream, kept in sync
origin/main-with-ask this fork's work: 2 commits on top of upstream/main
```

`main` stays a plain mirror so `git rebase upstream/main` has something honest to
rebase onto. The work is `main-with-ask`.

## Installing a build

Every push to `main-with-ask` runs
[`ask-fork.yml`](../.github/workflows/ask-fork.yml) and uploads
`pi-web-ask.tgz` as a workflow artifact (kept 90 days). A tag `ask-v*`
attaches the same file to a GitHub Release, which is permanent.

```sh
# Newest build for a branch: Actions → ask-fork → the run → Artifacts
npm install -g ./pi-web-ask.tgz
# npm 11+ blocks install scripts by default; node-pty needs its own:
#   npm install -g ./pi-web-ask.tgz \
#     --allow-scripts=@agegr/pi-web,node-pty,@google/genai,protobufjs

pi-web
```

The `.tgz` carries a built `.next` (685 files, about 22 MB). Without it
`bin/pi-web.js` exits with "Build artifacts not found", which is why the workflow
runs `npm run build` before `npm pack`.

## Turning the ask tool off

`ask_user_question` is one of Pi Web's built-in extensions, so **Settings ›
Plugins** lists it under *Built-in tools* beside the packages and switches it
with `-builtin:ask-question` in the `extensions` list of
`settings.json` (global) or `.pi/settings.json` (a trusted project, which
overrides the global switch there).

Off means the extension's factory never runs, so the tool is never registered
and the model does not see it: it cannot call it, and the system prompt carries
no instructions for it. That is a different thing from a tool that is listed and
refuses every call. Sessions already running keep the tool list they started
with; a new session in that folder picks the switch up.

The same switch works by hand in the settings file: add `"-builtin:ask-question"`
to its `extensions` list.

## Cutting a version worth keeping

```sh
git checkout main-with-ask
git tag -a ask-v0.17.0-1 -m "card, on upstream 0.17.0"
git push origin main-with-ask --tags
```

The `ask-` prefix matters: upstream tags are `v0.17.0`, and
`publish.yml` (upstream's, left untouched) checks that a `v*` tag matches
`package.json`'s version. An `ask-v*` tag never reaches that workflow.

## Two kinds of update

### Iterating on the card (you changed something)

```sh
./scripts/ask-install.sh
```

It rebuilds only when a file that reaches the build is newer than
`.next/BUILD_ID`, runs the card's tests, packs, and installs globally. With no
source change it skips the 3.5-minute build and just repacks (5 seconds).

The loop is: edit → `./scripts/ask-install.sh` → restart `pi-web`. Use
`npm run dev` instead while actually developing: it reloads on save and needs no
build at all, and the card's own page is at `http://127.0.0.1:30141`.

`--force` rebuilds regardless; `--no-build` installs the existing `.next`.

### Taking an upstream release

Nothing to build by hand: push the rebased branch and CI produces the package.

```sh
git fetch upstream
git rebase upstream/main
node --experimental-strip-types --test lib/ask-question.test.mjs \
  lib/ask-question-runtime.test.mjs components/AskQuestionPanel.test.mjs \
  lib/i18n/registry.test.mjs
npx tsc --noEmit
git push --force-with-lease origin main-with-ask   # CI builds an artifact
git tag -a ask-v0.18.0-1 -m "card, on upstream 0.18.0"
git push origin ask-v0.18.0-1                      # CI writes the Release
```

Then install that Release's `.tgz` (below). The distinction that matters: a
branch push gives an artifact that expires in 90 days; a tag gives a Release that
stays, and a URL that does not move.

## Maintaining the rebase

### Rebasing, not merging

Rebase, not merge: the fork stays 2 commits, so the history stays readable and a
pull request to upstream would be exactly those 2 commits.

Rebase rewrites commit hashes. Never rebase a branch that has been pushed and
that anyone else may have based work on — here that is only `main-with-ask`, and
only this machine pushes to it, so `git push --force-with-lease` is the normal
end of a rebase.

### Where it conflicts

Eleven of the seventeen changed files are new, so upstream can never touch them.
Six are edits to upstream files, 122 lines in total:

| File | Lines | Why it can conflict |
| --- | --- | --- |
| `lib/i18n/messages/{en,zh-CN,zh-TW}.ts` | 10 each | upstream adds keys at the same place; keep both sides |
| `lib/rpc-manager.ts` | 33 | registers the tool in `extensionFactories`, adds 2 commands |
| `hooks/useAgentSession.ts` | 37 | holds the open questions and the answer callback |
| `components/ChatWindow.tsx` | 21 | renders the card above `{chatInputElement}` |

The i18n conflict is the likeliest one and the simplest: both sides append
messages before `"chat.cancel"`, so the resolution is always both blocks.

### After every rebase

```sh
node --experimental-strip-types --test \
  lib/ask-question.test.mjs lib/ask-question-runtime.test.mjs \
  components/AskQuestionPanel.test.mjs lib/i18n/registry.test.mjs
npx tsc --noEmit
```

A rebase that compiles and passes those has not broken the card. A rebase that
silently changed the tool's behaviour — pi changing `registerTool`, say — is what
these catch, and it is why they run in CI before a package is built.

## Upgrading an installed copy

`npm install -g` over an existing install replaces it — no uninstall, no stale
files. So an upgrade is the same command with a different tag:

```sh
npm install -g https://github.com/SongOnRoc/pi-web/releases/download/ask-v0.18.0-1/pi-web-ask.tgz
```

`npm update` does not touch a globally installed tarball; reinstall to upgrade.

Rolling back is the same command with the previous tag. Old `.tgz` files stay on
the Releases page.

## Undoing a bad build

Rebase changes hashes; tags do not. Before a rebase you may want:

```sh
git tag ask-before-rebase
# afterwards, if the new state is wrong:
git reset --hard ask-before-rebase
```

Or just install the previous Release from the GitHub Releases page — old `.tgz`
files stay there.

## Sending the change upstream

Possible but unlikely to be merged, so not worth optimizing for. The mechanism,
if wanted:

```sh
git fetch upstream
git checkout -b ask-question-card upstream/main
git cherry-pick <the 2 commits from main-with-ask>
git push origin ask-question-card
```

Then open an issue first — `CONTRIBUTING.md` asks for one before a feature pull
request — using [the requirements doc](requirements/ask-user-question-card.md) as
its body.
