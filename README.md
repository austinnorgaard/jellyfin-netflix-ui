# Netflix UI for Jellyfin

Turns the Jellyfin web client into a Netflix-alike — not just a colour swap, but
the interactions that actually make it *feel* like Netflix.

> **Status:** 1.0.0, built and tested against Jellyfin **10.11.x** (`net9.0`).

## What it does

| | |
|---|---|
| **Hover-preview cards** | Hovering a card scales it and expands into a mini-modal with artwork, % match, rating, runtime, genres, and Play / Add / More actions. |
| **Row carousels** | Arrow buttons that page a row a full viewport at a time, auto-hiding at each end. |
| **Top 10 badges** | Large outlined rank numerals on rows whose title mentions Top / Trending / Popular. |
| **Detail overlay** | Items open in a Netflix-style overlay instead of navigating away. |
| **Theme** | `#141414` background, Netflix red accents, squared cards, gradient top nav that goes solid on scroll, white Play button, cinematic backdrop fades. |

Everything is individually toggleable in the plugin settings, with a master
switch to get stock Jellyfin back without uninstalling.

## Requirements

- Jellyfin **10.11.x**
- [**File Transformation**](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) —
  add `https://www.iamparadox.dev/jellyfin/plugins/manifest.json` as a plugin
  repository and install it.

File Transformation is required because Jellyfin has no supported hook for
modifying the served web client. It is the community-standard mechanism and is
what `home-sections` and `plugin-pages` use. Without it this plugin logs a
warning and does nothing — it will not break your server.

## Install

1. Dashboard → Plugins → Repositories → add this repo's `manifest.json` URL.
2. Install **Netflix UI**, restart Jellyfin.
3. **Hard-refresh the browser (Ctrl+Shift+R).** The web client caches
   aggressively and Jellyfin ships a service worker, so a normal reload often
   serves the old bundle.

## About the font

Netflix uses **Netflix Sans**, a proprietary typeface commissioned from Dalton
Maag. It is **not redistributed with this plugin** and is not in this
repository — that would be font piracy, and it is the single most likely thing
to get a project like this taken down.

The theme therefore falls back to **Inter / Helvetica Neue**, which is visually
very close. There is an opt-in setting to fetch Netflix Sans onto your own
server at runtime; whether you use it, and whether your server is publicly
reachable when you do, is your decision to make.

## Design, not copied code

This implements a *similar visual design* from observation. It does not contain
Netflix's stylesheets, scripts, artwork, or logos. Netflix is a trademark of
Netflix, Inc.; this project is unaffiliated with and unendorsed by them.

## Build

```bash
dotnet build src/Jellyfin.Plugin.NetflixUI/Jellyfin.Plugin.NetflixUI.csproj -c Release
```

The output is a single `Jellyfin.Plugin.NetflixUI.dll` — Jellyfin's own
assemblies are compile-time references only (`ExcludeAssets="runtime"`), because
bundling them causes assembly-load conflicts inside the plugin load context.

A repo-local `NuGet.config` is included; some machines enable
`packageSourceMapping` globally with a narrow allowlist, which otherwise makes
the Jellyfin packages fail to restore with `NU1100`.

## Notes / gotchas

- **Assets are served anonymously** (`/NetflixUI/netflix-ui.{js,css}`) because
  the login page is themed too, before any session exists. They return only
  static CSS/JS — no user data passes through those endpoints.
- **All server-supplied metadata is HTML-escaped** before rendering. Genres,
  studios and ratings come from TMDB/TVDB/`.nfo` files and are
  attacker-influenceable, so treating them as trusted markup would be a
  stored-XSS hole.
- **The injection is idempotent.** File Transformation can invoke a callback
  more than once per served document; without a marker the script ends up
  registered multiple times and handlers double-fire.
- Hover preview is disabled under 640px — touch devices have no hover state.

## Licence

GPL-3.0, matching the Jellyfin plugin ecosystem. See [LICENSE](LICENSE).
