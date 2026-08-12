---
name: deploy
description: Deploy the Géants 300 pace planner to GitHub Pages (https://mleprince.github.io/geants-300/) by committing and pushing to main, then verifying the Pages build succeeded. Use this skill whenever the user wants to publish, deploy, ship, put online, or update the live site — including phrasings like "mets ça en ligne", "déploie", "push la nouvelle version", "c'est bon tu peux publier", or when they finish a change and ask whether it's visible on their phone. Also use it to check whether the live site is up to date or why a deploy didn't show up.
---

# Deploying the Géants 300 planner

The site is plain static files served by GitHub Pages from the `main` branch (root path) of the public repo `mleprince/geants-300`. There is no build step — what's in git is what's served. A deploy is therefore just a push, plus the patience to confirm GitHub actually rebuilt.

Live URL: **https://mleprince.github.io/geants-300/**

## Before pushing: look at what you're about to publish

This repo is edited in WebStorm while Claude works, so the working tree routinely contains changes nobody asked you to ship. A push here is outward-facing and instant — the public site changes within a minute — so treat "what exactly am I publishing?" as the real decision, not a formality.

```bash
git status --short && git diff --stat
```

Compare that against what the user actually asked for:

- **Only the expected changes** → proceed.
- **Unrelated files also modified** (typically `app.js`, `style.css`, `index.html` from the user's editor) → tell the user what else is in the tree and ask whether to include it, rather than sweeping it into the commit. Committing everything with `git add -A` has already caused unreviewed editor work to go live in this repo.
- **Nothing to commit** → the working tree is clean; the last deploy may already cover it. Skip to verification rather than creating an empty commit.

Never commit `geants-2026.gpx` regenerations or `.bak` files without saying so — `.gitignore` covers `.idea/`, `*.bak`, `.DS_Store`, but not everything.

## Push

Stage deliberately (name the files when the tree is mixed), then commit and push:

```bash
git add index.html app.js style.css route.js   # or the specific files at hand
git commit -m "<what changed, in the imperative>"
git push
```

If the push fails on credentials, the remote is HTTPS and the SSH key may not be loaded in this session. `gh` is authenticated as `mleprince` and can supply the credential:

```bash
git -c credential.helper='!gh auth git-credential' push
```

Don't "fix" this by switching the remote to SSH unless the user asks — HTTPS + `gh` is the configuration that works here.

## Verify the deploy actually landed

Pushing is not deploying. GitHub Pages rebuilds asynchronously and takes roughly a minute, and a green push says nothing about the build. Report success only once you've seen it, because the user's next move is usually to open the site on their phone.

Poll the build status, then check the URL responds:

```bash
for i in $(seq 1 8); do
  s=$(gh api repos/mleprince/geants-300/pages --jq .status 2>/dev/null)
  echo "status=$s"
  [ "$s" = "built" ] && break
  sleep 15
done
curl -sS -o /dev/null -w "HTTP %{http_code}\n" https://mleprince.github.io/geants-300/
```

`status` goes `building` → `built`. A `null` status right after enabling Pages is normal; `errored` means the build failed — read the detail with `gh api repos/mleprince/geants-300/pages/builds/latest`.

A 200 on the root URL only proves the page is served, not that your change is in it. When the change is in an asset rather than the HTML, confirm the asset itself updated:

```bash
curl -sS https://mleprince.github.io/geants-300/app.js | grep -c "<a string from your change>"
```

Browser and CDN caching can also hide a good deploy. If the build says `built` and curl shows the new content but the user doesn't see it, that's a client cache — have them hard-reload, rather than pushing again.

## Things that quietly break this site

- **Relative asset paths are load-bearing.** The site lives at `/geants-300/`, not at a domain root. `index.html` references `style.css`, `route.js`, `app.js` relatively, and switching any of them to an absolute `/style.css` resolves to `mleprince.github.io/style.css` and 404s. Same for any new asset.
- **`index.html` must keep its name.** Pages serves it as the directory index; renaming it turns the site root into a 404.
- **Leaflet loads from unpkg with SRI hashes.** The map needs network on first load, which matters because the audience is a cyclist who may be somewhere with no signal. If offline use comes up, the fix is vendoring Leaflet into the repo, not tweaking the deploy.
- **`route.js` is ~200 KB on one line.** It's fine to ship, but don't try to read or rewrite it wholesale while preparing a deploy.

## Reporting back

Give the user the URL, what you published, and the verified state — e.g. "Déployé, build `built`, HTTP 200 : https://mleprince.github.io/geants-300/". If you excluded changes from the commit, say which ones and that they're still sitting uncommitted locally, so nothing gets silently stranded.
