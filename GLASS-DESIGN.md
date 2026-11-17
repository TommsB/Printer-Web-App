# Glass design system: an iOS-style look for web apps

This file describes a complete visual style for a web app. Give it to Claude (or a developer) together with an existing app, and ask them to restyle the app with it. It is written as instructions: what the look is, the exact values, ready-made CSS, and the mistakes to avoid.

The look is close to iOS:
- The page sits on a soft colour glow.
- Cards are see-through panes of glass with a bright rim.
- Bars and sheets are frosted (blurred).
- Corners are large and round, buttons are circles or pills, and windows slide up from the bottom.
- The same layout also has a plain ("solid") mode.

Everything is plain CSS with custom properties. It works with any framework (React, Vue, Svelte, plain HTML).

---

## 1. How to apply this to an app

1. **Copy the tokens.** Take sections 3 and 4 into the app's global stylesheet: the base tokens, the themes and the glass layer.
2. **Load the font** (section 2).
3. **Map the app's parts to the components in section 6.** For example, the app's list rows become **cards**, its icon buttons become **round buttons**, and its tab bar becomes a **segmented control**. Rename the classes in this file to the app's own, or add these classes to its markup.
4. **Turn glass on.** Set `data-surface="glass"` on `<html>`, before first paint (section 5). Without it you get the solid version of the same design, which is a good fallback.
5. **Add the motion from section 7.** This includes the opening screen, the sheet slides, the staggered cascades, the chart build-ups and the small feedback animations. The style isn't complete without it.
6. **Check the rules in section 8.** They cover performance, Safari quirks and contrast. Then check the result on a phone and on desktop, in light and dark.

Don't invent new colours, radii or shadows. Every surface takes its values from the tokens below, so themes and the glass/solid switch keep working.

---

## 2. Typography

- **Font:** Geist (variable). With npm, install `@fontsource-variable/geist` and `import '@fontsource-variable/geist'`. You can also load it from Google Fonts.
- **Stack:** `'Geist Variable', 'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif`
- Weights used: 400 for body text, 500 for buttons and tabs, 600 for headings and numbers. Never use 700+ except in tiny badges.
- **Headings are large and tight**, like iOS's large titles:

| Role | Size (desktop / phone) | Weight | Letter-spacing | Line height |
|---|---|---|---|---|
| Page title | 52px / ~40px | 600 | -0.04em | 0.96 |
| Sheet title | 38px / 25px | 600 | -0.035em | 1.08 |
| Window title | 30px / 24px | 600 | -0.03em | 1.1 |
| Card heading | 17–20px | 600 | -0.02em | 1.2 |
| Body | 15px | 400 | normal | 1.4 |
| Secondary text | 13–14px | 400 | normal | — (colour `--muted`) |
| Section label | 11–12.5px | 600 | 0.06em, UPPERCASE | — (colour `--muted`) |

- A two-line page title can have its second line in `--faint`, for example "Printeru" over "statuss" in grey.
- Numbers in tables and counters: `font-variant-numeric: tabular-nums`.
- Global: `-webkit-font-smoothing: antialiased; text-wrap: balance` on headings.

---

## 3. Base tokens and themes (the solid style)

These are the colours the glass layer is built on. The light theme is the default. Every theme redefines the same names, so components never hard-code a colour.

```css
:root {
  /* surfaces and text */
  --bg: #F1F1ED; --card: #fff; --ink: #33332F; --muted: #6B6B64; --faint: #A3A39B;
  --line: #E8E8E3; --line2: #EFEFEA; --line3: #C9C9C2;
  --tile: #F2F2EE;     /* small grey patches on a card: icon circles, quiet buttons */
  --pillbg: #E6E6E0;   /* the trough of a pill switch */
  --hover: #FAFAF8; --sel: #F4F4F0; --track: #EBEBE6;
  /* roles */
  --accent: #F07A22; --accent-line: var(--accent);       /* highlights, focus rings, chart accents */
  --on-ink: #fff; --ink-hover: #4A4A45;
  --primary: var(--ink); --on-primary: var(--on-ink);  /* the main button: dark pill */
  --outline: var(--ink);                                /* selected card outline */
  --badge: var(--accent); --on-badge: #fff;
  --seg-on: #fff;                                       /* chosen option in a switch */
  --nav: var(--ink); --nav-fg: #B8B8B0; --nav-pill: #fff; --nav-pill-fg: var(--ink);  /* phone tab bar */
  /* status */
  --ok: #2E7D4F; --ok-bg: #E7F3EB; --warn-ink: #9A6B08; --warn-bg: #FBF3DC;
  --bad: #C8321E; --bad-bg: #FBE9E6; --info-ink: #3C5A99; --info-bg: #EAEFF8;
  --alert-bg: #FDF0E4; --alert-ink: #9A4208;
  --danger: #E0640F; --on-danger: #fff;
  /* motion: one curve for everything that moves (iOS-like: fast start, long soft landing) */
  --ease: cubic-bezier(.2, .8, .2, 1);

  font-family: 'Geist Variable', 'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--ink);
  color-scheme: light;
}

:root[data-theme="dark"] {
  --bg: #26282C; --card: #303338; --ink: #F2F2EF; --muted: #B4B6BA; --faint: #8C8F94;
  --line: #44484E; --line2: #3B3E44; --line3: #666A70; --tile: #3B3E44; --pillbg: #3A3D43;
  --hover: #363940; --sel: #3A3D43; --track: #44484E;
  --on-ink: #26282C; --ink-hover: #D5D5CF; --seg-on: #54585F;
  --nav: #3A3D43; --nav-fg: #C2C4C8; --nav-pill: #F2F2EF; --nav-pill-fg: #26282C;
  --ok: #7CCB94; --ok-bg: #26432F; --warn-ink: #E8C46A; --warn-bg: #443B1E;
  --bad: #F0705C; --bad-bg: #4A2A25; --info-ink: #9DB7EE; --info-bg: #2B3852;
  --alert-bg: #45331F; --alert-ink: #FFB27A; --danger: #FF9A4D; --on-danger: #26282C;
  color-scheme: dark;
}

/* Pastel themes: same dark ink, tinted page, a pastel main colour with dark text on it. */
:root[data-theme="blue"] {
  --bg: #EEF2F7; --ink: #16233A; --muted: #5A6880; --faint: #8A97AB;
  --line: #DDE4EE; --line2: #E9EEF5; --line3: #BFC9D8; --tile: #EDF2F8; --pillbg: #DFE6F0;
  --hover: #F7F9FC; --sel: #EEF3F9; --track: #E3E9F1; --ink-hover: #2A3A56;
  --primary: #A9C4F2; --on-primary: #16233A; --outline: #8FB0EA;
  --badge: #A9C4F2; --on-badge: #16233A; --accent-line: #6F9BE6; --danger: var(--bad);
}
:root[data-theme="green"] {
  --bg: #EDF1EC; --ink: #1F2D26; --muted: #5C6B62; --faint: #8C9A91;
  --line: #DCE4DB; --line2: #E8EEE7; --line3: #BECABF; --tile: #ECF1EB; --pillbg: #DDE5DC;
  --hover: #F7FAF6; --sel: #EEF3ED; --track: #E2E9E1; --ink-hover: #33443B;
  --primary: #A8D5BC; --on-primary: #1F2D26; --outline: #86C2A2;
  --badge: #A8D5BC; --on-badge: #1F2D26; --accent-line: #5FB088; --danger: var(--bad);
}

/* "Neon": purple-black page, pink main marks, blue outlines. */
:root[data-theme="neon"] {
  --bg: #14121F; --card: #1F1B30; --ink: #F1EEFF; --muted: #A9A3C7; --faint: #7F799E;
  --line: #332D4D; --line2: #2A2540; --line3: #564E78; --tile: #2A2540; --pillbg: #262139;
  --hover: #262139; --sel: #2A2540; --track: #332D4D;
  --on-ink: #14121F; --ink-hover: #D9D4F2; --seg-on: #3A3357;
  --nav: #262139; --nav-fg: #C9C3E6; --nav-pill: #FF7AB8; --nav-pill-fg: #14121F;
  --primary: #FF7AB8; --on-primary: #14121F; --outline: #8C9BFF;
  --badge: #FF7AB8; --on-badge: #14121F; --accent-line: #8C9BFF;
  --bad: #FF6B7A; --danger: var(--bad); --on-danger: #14121F;
  color-scheme: dark;
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }
button { font: inherit; color: inherit; }
```

**Colour principles**
- The page is never pure white or pure black. It is a warm off-white (`#F1F1ED`) or a soft charcoal (`#26282C`). Cards are one step lighter than the page.
- **Primary actions are dark pills** (`--ink` background, white text) in the light theme, not a brand colour. Colour (the accent) is reserved for small highlights: badges, focus rings, the "look here" pulse and chart accents.
- Text has three levels only: `--ink` (main), `--muted` (secondary), `--faint` (hints, disabled, the second line of a title).

---

## 4. The glass layer

This is the core of the look. Put it after the tokens. It only applies when `<html data-surface="glass">` is set, so removing the attribute gives the solid style.

### 4.1 Glass tokens

```css
:root[data-surface="glass"] {
  /* the glow behind the page: two tints and their strength */
  --tint1: #B9B09C; --tint2: #A9B4C4; --glow: 46%;   /* light: warm stone + cool grey, so it is not "orange" */

  /* a pane of glass (light themes): mostly clear, a sheen brightest at the top-left */
  --glass: linear-gradient(135deg, rgba(255,255,255,.64) 0%, rgba(255,255,255,.26) 55%, rgba(255,255,255,.4) 100%);
  --glass-hover: linear-gradient(135deg, rgba(255,255,255,.82) 0%, rgba(255,255,255,.5) 55%, rgba(255,255,255,.6) 100%);
  /* the crisp rim */
  --glass-edge: rgba(255,255,255,.95);
  /* light falling from the top-left: bright top edge, softer left edge, faint bottom edge, then a soft drop shadow */
  --glass-shine: inset 0 1px 0 #fff, inset 1px 0 0 rgba(255,255,255,.6), inset 0 -1px 0 rgba(255,255,255,.25),
                 0 10px 28px rgba(51,51,47,.09), 0 1px 2px rgba(51,51,47,.05);
  /* frosted bars and sheets: the page colour, partly see-through (blurred with backdrop-filter) */
  --frost: color-mix(in srgb, var(--bg) 62%, transparent);
  /* windows and menus that pop up over the page */
  --pop: color-mix(in srgb, var(--bg) 72%, transparent);
  /* switches: a see-through trough, the chosen option a brighter pane */
  --well: color-mix(in srgb, var(--ink) 6%, transparent);
  --seg-glass: rgba(255,255,255,.82);
  /* small parts on a card become see-through too, so they take the card's tint instead of sitting on it as grey patches */
  --tile: rgba(255,255,255,.5); --sel: rgba(255,255,255,.55); --hover: rgba(255,255,255,.45);
  --track: color-mix(in srgb, var(--ink) 14%, transparent);
  --pillbg: color-mix(in srgb, var(--ink) 8%, transparent);
  --line: color-mix(in srgb, var(--ink) 12%, transparent);
  --line2: color-mix(in srgb, var(--ink) 8%, transparent);
  /* small round icon circles: a faint rim, like glass beads */
  --bead: inset 0 0 0 1px rgba(255,255,255,.75), 0 1px 2px rgba(51,51,47,.07);
}

/* Dark themes: glass is a faint white film, not a white sheen. */
:root[data-surface="glass"]:is([data-theme="dark"], [data-theme="neon"]) {
  --glass: rgba(255,255,255,.07); --glass-hover: rgba(255,255,255,.11); --glass-edge: rgba(255,255,255,.14);
  --glass-shine: inset 0 1px 0 rgba(255,255,255,.16), 0 6px 20px rgba(0,0,0,.2);
  --well: rgba(255,255,255,.07); --seg-glass: rgba(255,255,255,.17);
  --tile: rgba(255,255,255,.09); --sel: rgba(255,255,255,.12); --hover: rgba(255,255,255,.08);
  --track: rgba(255,255,255,.17); --pillbg: rgba(255,255,255,.1);
  --line: rgba(255,255,255,.14); --line2: rgba(255,255,255,.09);
  --bead: inset 0 0 0 1px rgba(255,255,255,.12);
}
/* Each theme's glow uses its own colours (neutral greys for light and dark, so glass never looks tinted orange). */
:root[data-surface="glass"][data-theme="dark"]  { --tint1: #9A958A; --tint2: #7C879C; --glow: 24%; }
:root[data-surface="glass"][data-theme="neon"]  { --tint1: #FF4FA3; --tint2: #6C7BFF; --glow: 26%; }
:root[data-surface="glass"][data-theme="blue"]  { --tint1: #6F9BE6; --tint2: #A9C4F2; --glow: 46%; }
:root[data-surface="glass"][data-theme="green"] { --tint1: #5FB088; --tint2: #A8D5BC; --glow: 46%; }
```

### 4.2 The glow behind the page

Glass is invisible over a flat colour, so there has to be something behind it. That is four large, soft radial patches, fixed to the screen so the page scrolls over them.

```css
:root[data-surface="glass"] {
  --glow-bg:
    radial-gradient(45vmax 45vmax at 58% 34%,  color-mix(in srgb, var(--tint2) calc(var(--glow) * .7), transparent), transparent 70%),
    radial-gradient(70vmax 70vmax at -10% 12%, color-mix(in srgb, var(--tint1) var(--glow), transparent), transparent 70%),
    radial-gradient(70vmax 70vmax at 112% 52%, color-mix(in srgb, var(--tint2) var(--glow), transparent), transparent 70%),
    radial-gradient(75vmax 75vmax at 0% 108%,  color-mix(in srgb, var(--tint1) var(--glow), transparent), transparent 70%);
}
:root[data-surface="glass"] body::before {
  content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none; background: var(--glow-bg);
}
/* Phones: the status bar is one flat colour (the page colour), so fade the glow out towards the top edge
   and the page runs into the status bar without a seam. */
@media (max-width: 800px) {
  :root[data-surface="glass"] body::before {
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 26vh);
            mask-image: linear-gradient(to bottom, transparent 0, #000 26vh);
  }
}
```

### 4.3 The three kinds of glass

| Kind | Used for | Recipe |
|---|---|---|
| **Clear glass** (no blur) | Cards, list rows, tiles, round buttons, fields inside windows | `background: var(--glass); border: 1px solid var(--glass-edge); box-shadow: var(--glass-shine);` |
| **Frosted** (blurred) | Bars that content scrolls under (top bar, phone tab bar), bottom sheets | `background: var(--frost); backdrop-filter: saturate(1.8) blur(24–28px);` plus a top rim `inset 0 1px 0 var(--glass-edge)` |
| **Pop-up glass** (blurred, more opaque) | Dialog windows, dropdown/⋮ menus | `background: var(--pop); backdrop-filter: saturate(1.8) blur(28px); border: 1px solid var(--glass-edge); box-shadow: var(--glass-shine), 0 24px 60px rgba(0,0,0,.2);` |

Always write `-webkit-backdrop-filter` next to `backdrop-filter`, because Safari needs it.

**Why cards are not blurred:** the glow behind them is already smooth, so blur adds nothing visible. Blurring every card in a long list also makes scrolling slow on phones. Only bars, sheets, windows and menus are blurred, because they move over busy content.

---

## 5. Turning it on before first paint

Set the theme and surface on `<html>` in an inline script in `<head>`, so the page never flashes the wrong look:

```html
<meta name="theme-color" content="#F1F1ED" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<script>
  try {
    var t = localStorage.getItem('theme');
    var bg = { dark: '#26282C', blue: '#EEF2F7', green: '#EDF1EC', neon: '#14121F' }[t];
    if (bg) { document.documentElement.dataset.theme = t; document.querySelector('meta[name="theme-color"]').content = bg; }
  } catch (e) {}
  var solid = false;
  try { solid = localStorage.getItem('surface') === 'solid'; } catch (e) {}
  document.documentElement.dataset.surface = solid ? 'solid' : 'glass';   /* glass is the default */
</script>
```

When the user changes theme, also update `meta[name="theme-color"]` to that theme's `--bg`. Phones colour their status bar and browser bar from it.

A settings screen offers both choices: theme (Light, Dark, Blue, Green, Neon) and style (Glass / Solid). Mark the defaults (Light + Glass).

---

## 6. Components: shape and glass

Shape rules that make it feel like iOS:
- **Large radii.**
  - Big panes: 32px desktop / 28px phone.
  - Cards and list rows: 22px.
  - Small cards: 16–20px.
  - Menus: 16px; menu items: 10px.
  - Sheets: 28px on the top corners only.
- **Buttons are circles or pills, never rectangles.** Pill radius = half the height.
- **Generous touch sizes.** Round buttons are 48px (56px on phones), regular buttons and fields 44px tall, small ones 36px.
- **Content padding:** 24px in a pane (18px on phone), 12–16px in a row.
- **Gaps:** 8–10px between rows, 20–28px between sections.

### 6.1 Page

```css
.page { max-width: 1360px; margin: 0 auto; padding: 36px 48px 48px; display: flex; flex-direction: column; gap: 28px; min-height: 100vh; }
@media (max-width: 800px) {
  .page { padding: calc(20px + env(safe-area-inset-top)) 16px calc(110px + env(safe-area-inset-bottom)) 16px; gap: 20px; }
}
.page-title { font-size: 52px; font-weight: 600; line-height: .96; letter-spacing: -.04em; margin: 0; }
.page-title span { display: block; color: var(--faint); }   /* optional grey second line */
```

### 6.2 Panes and cards

```css
.pane { background: var(--card); border-radius: 32px; padding: 24px; min-width: 0; }
.card { background: var(--card); border: 1px solid transparent; border-radius: 22px; padding: 12px 16px;
  box-shadow: 0 1px 2px rgba(40,40,36,.08); transition: box-shadow .25s ease, border-color .25s ease; }
.card:hover { background: var(--hover); }
/* selected / expanded: a thin dark outline and a lift */
.card.on { border-color: var(--outline); box-shadow: inset 0 0 0 .5px var(--outline), 0 12px 32px rgba(40,40,36,.13); }
@media (max-width: 800px) { .pane { border-radius: 28px; padding: 18px; } }

/* glass */
:root[data-surface="glass"] :is(.pane, .card) { background: var(--glass); }
:root[data-surface="glass"] :is(.pane, .card:not(.on)) { border: 1px solid var(--glass-edge); box-shadow: var(--glass-shine); }
:root[data-surface="glass"] .card:hover:not(.on) { background: var(--glass-hover); }
```

A list is a column of separate cards with an 8–10px gap. Avoid one big table with dividers. A list row usually has:
- a 44px round icon circle on the left (`--tile` background);
- a title and a muted subtitle;
- a chevron or a status on the right.

### 6.3 Round icon buttons (the iOS circle buttons)

```css
.rb { width: 48px; height: 48px; border-radius: 50%; border: 0; background: var(--card); color: var(--ink);
  display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
.rb:hover:not(:disabled) { background: var(--sel); }
.rb.dk { background: var(--ink); color: var(--on-ink); }          /* the one dark circle: profile, close (×) */
.rb.dk:hover { background: var(--ink-hover); }
.icon-btn { width: 40px; height: 40px; border-radius: 50%; border: 0; background: var(--tile); color: var(--muted);
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.icon-btn:hover { color: var(--ink); }
@media (max-width: 800px) { .rb { width: 56px; height: 56px; } }

:root[data-surface="glass"] .rb:not(.dk) { background: var(--glass); box-shadow: var(--glass-shine); }
:root[data-surface="glass"] .rb:not(.dk):hover:not(:disabled) { background: var(--glass-hover); }
:root[data-surface="glass"] :is(.icon-btn, .ic) { box-shadow: var(--bead); }
```

Icons are line icons, 1.75–2px stroke, 18–22px. A count badge sits on the top-right of a round button:

```css
.badge-n { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 9px; background: var(--badge); color: var(--on-badge); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.rb .badge-n { position: absolute; top: 2px; right: 0; box-shadow: 0 0 0 2px var(--bg); }  /* .rb needs position: relative */
```

### 6.4 Buttons, chips, fields

```css
.btn { min-height: 44px; padding: 0 20px; border-radius: 22px; border: 1px solid var(--line); background: var(--card);
  color: var(--ink); font-weight: 500; cursor: pointer; }
.btn:hover:not(:disabled) { border-color: var(--ink); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
.btn.small { min-height: 36px; padding: 0 14px; border-radius: 18px; font-size: 14px; }
.btn:disabled { opacity: .5; cursor: default; }

.chip { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border-radius: 18px;
  border: 1px solid var(--line); background: var(--card); font-size: 14px; cursor: pointer; }
.chip.on { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }

input, select { font: inherit; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 22px;
  background: var(--bg); color: var(--ink); width: 100%; }
textarea { font: inherit; padding: 10px 14px; border: 1px solid var(--line); border-radius: 16px; background: var(--bg); color: var(--ink); width: 100%; }
/* search: a pill with the icon inside */
.search { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 6px 0 14px; border-radius: 20px; background: var(--tile); color: var(--faint); }
.search:focus-within { box-shadow: 0 0 0 2px var(--ink); }

/* glass: inside windows, fields and plain buttons are panes of the same glass */
:root[data-surface="glass"] .window :is(input:not([type="checkbox"], [type="radio"]), select, textarea, .btn:not(.primary), .chip:not(.on)) { background: var(--glass); }
```

### 6.5 Segmented control (pill switch) and desktop navigation

A trough holding pills; the chosen one is a raised white pane.

```css
.seg { display: flex; gap: 4px; padding: 4px; background: var(--tile); border-radius: 22px; }
.seg button { height: 34px; padding: 0 14px; border: 0; border-radius: 17px; background: none; color: var(--muted);
  font-size: 13.5px; font-weight: 500; cursor: pointer; }
.seg button.on { background: var(--seg-on); color: var(--ink); box-shadow: 0 1px 2px rgba(40,40,36,.08); }

/* top navigation on desktop: the same shape, taller */
.nv { display: flex; gap: 4px; height: 48px; padding: 4px; border-radius: 24px; background: var(--pillbg); }
.nv a { display: flex; align-items: center; padding: 0 18px; border-radius: 20px; font-size: 15px; font-weight: 500; color: var(--muted); text-decoration: none; }
.nv a.on { background: var(--card); color: var(--ink); }

:root[data-surface="glass"] :is(.seg, .nv) { background: var(--well); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--glass-edge) 55%, transparent); }
:root[data-surface="glass"] :is(.seg button.on, .nv a.on) { background: var(--seg-glass); box-shadow: var(--glass-shine); }
```

### 6.6 Toggle switch (iOS style)

```css
.toggle__ui { position: relative; width: 46px; height: 28px; border-radius: 14px; background: var(--line); transition: background .2s; }
.toggle__ui::after { content: ''; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2); transition: transform .2s var(--ease); }
.toggle input:checked + .toggle__ui { background: var(--ink); }
.toggle input:checked + .toggle__ui::after { transform: translateX(18px); }
```

Markup: `<label class="toggle"><input type="checkbox" class="visually-hidden"> <span class="toggle__ui"></span> Label</label>`. Hide the input visually (`position: absolute; opacity: 0; width: 1px; height: 1px`), not with `display: none`, so it stays focusable and in the accessibility tree.

### 6.7 Phone tab bar (floating pill)

On phones, the main navigation is a floating dark pill at the bottom, with a sliding white pill under the active tab.

```css
@media (max-width: 800px) {
  .bnav { display: grid; grid-template-columns: repeat(4, 1fr); position: fixed; left: 16px; right: 16px;
    bottom: calc(16px + env(safe-area-inset-bottom)); height: 64px; padding: 6px; border-radius: 32px; background: var(--nav); z-index: 20; }
  .bnav a { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; border-radius: 26px;
    color: var(--nav-fg); min-height: 44px; transition: color .25s; }
  .bnav a.on { color: var(--nav-pill-fg); }
  /* one pill that slides to the active tab: transform: translateX(index * 100%) */
  .bnav__pill { position: absolute; top: 6px; bottom: 6px; left: 6px; width: calc((100% - 12px) / 4); border-radius: 26px;
    background: var(--nav-pill); transition: transform .32s var(--ease); }
}
:root[data-surface="glass"] .bnav { background: color-mix(in srgb, var(--nav) 58%, transparent);
  -webkit-backdrop-filter: saturate(1.8) blur(24px); backdrop-filter: saturate(1.8) blur(24px);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.22), 0 10px 28px rgba(0,0,0,.18); }
```

### 6.8 Compact top bar (appears after scrolling)

When the big title scrolls away, a slim frosted bar fades in at the top. It shows the page name and the main switch.

```css
.cbar { position: fixed; top: 0; left: 0; right: 0; z-index: 25; padding: calc(10px + env(safe-area-inset-top)) 16px 10px;
  background: color-mix(in srgb, var(--bg) 86%, transparent); -webkit-backdrop-filter: saturate(1.4) blur(16px); backdrop-filter: saturate(1.4) blur(16px);
  border-bottom: 1px solid var(--line); opacity: 0; transform: translateY(-8px); pointer-events: none;
  transition: opacity .2s ease, transform .25s var(--ease); }
.cbar.on { opacity: 1; transform: none; pointer-events: auto; }
:root[data-surface="glass"] .cbar { background: var(--frost); -webkit-backdrop-filter: saturate(1.8) blur(24px); backdrop-filter: saturate(1.8) blur(24px); border-bottom-color: var(--glass-edge); }
```

Toggle `.on` with an IntersectionObserver on the page title.

### 6.9 Bottom sheets: the main way windows open

Big views (settings/profile, notifications, analytics, a basket) slide up from the bottom over a dimmed page, on desktop and phone. They take 85% of the height on desktop and 90–97% on phones. Each has a fixed heading with a dark round × button, a scrolling middle and a fixed button row.

```css
.sheet-shade { position: fixed; inset: 0; z-index: 40; background: rgba(30,30,28,.45); animation: fade-in .32s ease-out both; }
.sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 41; width: min(760px, 100%); height: 85dvh; margin: 0 auto;
  display: flex; flex-direction: column; padding: 0 28px 24px; border-radius: 28px 28px 0 0;
  background: var(--bg); box-shadow: 0 -12px 40px rgba(30,30,28,.22);
  animation: sheet-up .38s var(--ease) both; will-change: transform; }
.sheet__head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 22px 0 12px; }
.sheet__head h2 { margin: 0; font-size: 30px; font-weight: 600; letter-spacing: -.03em; }
.sheet__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; margin: 0 -28px; padding: 2px 28px 12px; }
.sheet__foot { flex: none; display: flex; justify-content: flex-end; gap: 8px; padding: 14px 0 env(safe-area-inset-bottom); border-top: 1px solid var(--line2); }
.sheet__foot:empty { display: none; }
@keyframes sheet-up { from { transform: translateY(100%); } }
@keyframes fade-in { from { opacity: 0; } }
@media (max-width: 800px) {
  .sheet { height: 90dvh; padding: 0 16px 18px; }
  .sheet__body { margin: 0 -16px; padding: 2px 16px 12px; }
  .sheet__head h2 { font-size: 24px; }
}
/* glass: frosted sheet, lighter shade so the page shows through */
:root[data-surface="glass"] .sheet { background: var(--frost); -webkit-backdrop-filter: saturate(1.8) blur(28px); backdrop-filter: saturate(1.8) blur(28px);
  box-shadow: inset 0 1px 0 var(--glass-edge), 0 -12px 40px rgba(30,30,28,.18); }
:root[data-surface="glass"] .sheet-shade { background: rgba(30,30,28,.2); }
```

Sheet behaviour:
- Close on ×, on Escape, and on a tap on the shade.
- While a sheet is open on a phone, lock page scroll: `html { overflow: hidden }`. Don't do this on desktop, where removing the scrollbar shifts the page sideways.
- Only the middle scrolls. The heading and buttons stay put, so nothing scrolls under them and no extra strip is needed.

### 6.10 Dialog windows (small forms and confirmations)

Centred windows for short forms: radius 32px, max-width 520px, padding 24px, buttons at the bottom right. The dark primary button sits on the right and the plain one to its left.

```css
.window-wrap { position: fixed; inset: 0; margin: auto 0; height: fit-content; max-height: 100%; z-index: 41;
  display: flex; align-items: center; justify-content: center; padding: 16px; }
.window { width: 100%; max-width: 520px; max-height: 92dvh; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 12px; padding: 24px; border-radius: 32px; background: var(--card);
  clip-path: inset(0 round 32px); /* keeps the scrollbar inside the round corners */ }
.window__actions { position: sticky; bottom: -24px; margin: 4px -24px -24px; padding: 12px 24px 24px; display: flex; justify-content: flex-end; gap: 8px;
  background: var(--card); border-top: 1px solid var(--line2); }
:root[data-surface="glass"] .window { background: var(--pop); -webkit-backdrop-filter: saturate(1.8) blur(28px); backdrop-filter: saturate(1.8) blur(28px);
  border: 1px solid var(--glass-edge); box-shadow: var(--glass-shine), 0 24px 60px rgba(0,0,0,.2); }
/* the form fades out under the buttons instead of meeting a solid strip */
:root[data-surface="glass"] .window__actions { border-top: 0; background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--bg) 90%, transparent) 42%); }
```

Use the same `.sheet-shade` element behind it, as a separate sibling (see rule 8.3).

Form layout inside windows follows iOS settings lists:
- Small UPPERCASE `--muted` section labels.
- Rows split by 1px `--line2` rules.
- Radio lists instead of dropdowns when there are ≤ 6 options.
- `−  n  +` steppers with 44px round buttons. They grey out at their limits (`opacity: .35`).

### 6.11 Menus (⋮ / dropdowns)

```css
.menu { position: fixed; z-index: 50; min-width: 170px; display: flex; flex-direction: column; padding: 6px;
  background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 12px 32px rgba(40,40,36,.14); }
.menu button { min-height: 42px; padding: 0 12px; border: 0; border-radius: 10px; background: none; text-align: left; font-size: 14.5px; cursor: pointer;
  display: flex; align-items: center; gap: 10px; }        /* an 18px line icon before each label */
.menu button:hover:not(:disabled) { background: var(--tile); }
.menu .menu__title { padding: 8px 12px 4px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
:root[data-surface="glass"] .menu { background: var(--pop); -webkit-backdrop-filter: saturate(1.8) blur(28px); backdrop-filter: saturate(1.8) blur(28px);
  border: 1px solid var(--glass-edge); box-shadow: var(--glass-shine), 0 24px 60px rgba(0,0,0,.2); }
```

In menus where one option is chosen (sort order, view mode), mark it with a ✓ on the right and a small grey "Recommended" note under the default.

### 6.12 Toast ("Undo" bar)

A dark pill at the bottom centre, with a white pill button inside.

```css
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 70; display: flex; align-items: center; gap: 14px;
  max-width: calc(100vw - 32px); padding: 10px 10px 10px 18px; border-radius: 26px; background: var(--ink); color: var(--on-ink);
  font-size: 14px; box-shadow: 0 10px 30px rgba(30,30,28,.28); animation: toast-in .22s var(--ease) both; }
.toast button { height: 34px; padding: 0 16px; border: 0; border-radius: 17px; background: var(--on-ink); color: var(--ink); font-weight: 600; }
@keyframes toast-in { from { opacity: 0; transform: translate(-50%, 8px); } }
:root[data-surface="glass"] .toast { background: color-mix(in srgb, var(--ink) 78%, transparent); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); }
```

### 6.13 Status pills and alerts

These are small rounded labels with a tinted background and dark text of the same hue: `--ok-bg`/`--ok`, `--warn-bg`/`--warn-ink`, `--bad-bg`/`--bad`, `--info-bg`/`--info-ink`, `--alert-bg`/`--alert-ink`. Use them with `padding: 2px 9px; border-radius: 10px; font-size: 12.5px; font-weight: 600`. Always pair the colour with a word or icon, never colour alone.

---

## 7. Motion

Motion is half of what makes this design feel like iOS. Things slide in from where they come from, settle softly, and never bounce or overshoot. Implement every animation in this section. The look without them feels flat and "web".

### 7.1 Principles

- **One curve:** `--ease: cubic-bezier(.2, .8, .2, 1)` for everything that moves. It starts fast and has a long, soft landing. Use plain `ease-out` only for fades, and `linear` only for spinners.
- **Short durations:**

  | Kind of change | Duration |
  |---|---|
  | Hover and colour changes | 0.15–0.25s |
  | Small moves (pills, toggles, chevrons) | 0.2–0.32s |
  | Sheets and panels | 0.35–0.55s |
  | Content appearing (cards, charts) | 0.5–1.2s, staggered |

- **Only cheap properties:** animate `transform` and `opacity`. Use `clip-path`, `stroke-dashoffset` and `box-shadow` only on small things. Never animate `width`, `height`, `top` or `left`.
- **Stagger, don't dump.** When several things appear together (cards, tiles, list items), each starts 35–60ms after the one before. Cap the stagger at about 12 items, so a long list doesn't take seconds.
- **Start content moving while its container is still arriving.** For example, cards in a sheet start rising 0.12s into the sheet's slide. This overlap is what makes it feel fluid instead of step-by-step.
- **Desktop uses the View Transitions API** for layout changes (7.3). **Phones use plain CSS animations**, because on iPhone Safari the view-transition snapshots draw over fixed bars and make them flash.
- **Respect reduced motion** everywhere (7.10).

All keyframes in one place:

```css
@keyframes fade-in   { from { opacity: 0; } }
@keyframes rise-in   { from { opacity: 0; transform: translateY(12px); } }            /* cards, tiles */
@keyframes rise-far  { from { opacity: 0; transform: translateY(36px); } }            /* items in an opening sheet */
@keyframes view-in   { from { opacity: 0; transform: translateY(18px) scale(.98); } } /* a list after switching view */
@keyframes row-in    { from { opacity: 0; transform: translateY(-6px); } }            /* rows in a card that opened */
@keyframes sheet-up  { from { transform: translateY(100%); } }
@keyframes toast-in  { from { opacity: 0; transform: translate(-50%, 8px); } }
@keyframes spin      { to { transform: rotate(360deg); } }
@keyframes pulse     { 50% { opacity: .35; } }
@keyframes draw      { from { stroke-dashoffset: 1; } }                                 /* needs pathLength="1" + stroke-dasharray: 1 */
@keyframes wipe      { from { clip-path: inset(-6px 100% -6px -6px); } to { clip-path: inset(-6px); } }
@keyframes bar-up    { from { transform: scaleY(0); } }
@keyframes bar-grow  { from { transform: scaleX(0); } }
@keyframes pie-in    { from { opacity: 0; transform: scale(.9) rotate(-14deg); } }
@keyframes lift-up   { from { transform: translateY(9px); } }
@keyframes btn-ring  { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent-line) 55%, transparent); } 100% { box-shadow: 0 0 0 12px transparent; } }
@keyframes target    { 0%, 65% { box-shadow: 0 0 0 2.5px var(--accent-line); } }
@keyframes ring      { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent-line) 42%, transparent); }
                       100% { box-shadow: 0 0 0 16px color-mix(in srgb, var(--accent-line) 0%, transparent); } }
@keyframes lift      { 22% { transform: scale(1.012); } }
@keyframes tint      { 0% { opacity: 0; } 18% { opacity: .07; } 100% { opacity: 0; } }
@keyframes search-grow { from { flex-grow: 0; flex-basis: 40px; } }
```

### 7.2 Opening screen (the app's logo lighting up)

While the app loads, a full-screen opening screen shows the app's logo as a **neon sign**. The logo is drawn as line strokes in two of the theme's colours, each with a soft glow. The sign scales in, and its tubes light up along their length: first one colour, then the other 0.17s later. Then it holds steady (no flicker, no pulse) and the whole screen fades out after at least 1 second.

Everything is inline in `index.html`, so it shows before any other file has loaded. It uses the theme set by the head script (section 5).

Replace the SVG paths with the app's own logo, drawn as simple strokes. Put `pathLength="1"` on every path and circle, so the draw animation works whatever the path's real length.

```html
<style>
  #splash { --sp-bg: #F1F1ED; --sp-a: #33332F; --sp-b: #F07A22; --sp-glow: 35%;
    position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(60vmin 60vmin at 50% 50%, color-mix(in srgb, var(--sp-b) 12%, var(--sp-bg)), var(--sp-bg) 70%);
    transition: opacity .4s ease; }
  /* each theme: its page colour, its ink, its accent; dark themes glow stronger */
  [data-theme="dark"]  #splash { --sp-bg: #26282C; --sp-a: #F2F2EF; --sp-b: #FF9A4D; --sp-glow: 60%; }
  [data-theme="blue"]  #splash { --sp-bg: #EEF2F7; --sp-a: #16233A; --sp-b: #6F9BE6; }
  [data-theme="green"] #splash { --sp-bg: #EDF1EC; --sp-a: #1F2D26; --sp-b: #5FB088; }
  [data-theme="neon"]  #splash { --sp-bg: #14121F; --sp-a: #8C9BFF; --sp-b: #FF7AB8; --sp-glow: 90%; }
  #splash.out { opacity: 0; pointer-events: none; }
  #splash svg { width: min(46vmin, 260px); height: auto; overflow: visible; fill: none; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round;
    animation: neon-in .5s cubic-bezier(.2, .8, .2, 1) both; }
  #splash .a { stroke: var(--sp-a); filter: drop-shadow(0 0 3px color-mix(in srgb, var(--sp-a) var(--sp-glow), transparent)) drop-shadow(0 0 12px color-mix(in srgb, var(--sp-a) var(--sp-glow), transparent)); }
  #splash .b { stroke: var(--sp-b); filter: drop-shadow(0 0 3px color-mix(in srgb, var(--sp-b) var(--sp-glow), transparent)) drop-shadow(0 0 12px color-mix(in srgb, var(--sp-b) var(--sp-glow), transparent)); }
  #splash path, #splash circle { stroke-dasharray: 1; animation: neon-draw .6s cubic-bezier(.4, 0, .2, 1) .05s both; }
  #splash .b path, #splash .b circle { animation-delay: .22s; }
  @keyframes neon-in { from { opacity: 0; transform: scale(.86); } }
  @keyframes neon-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) { #splash svg, #splash path, #splash circle { animation: none; } }
</style>
...
<body>
  <div id="splash" aria-hidden="true">
    <svg viewBox="0 0 200 200">
      <!-- example logo (a printer): first colour = the paper, second colour = the body -->
      <g class="a">
        <path pathLength="1" d="M70 78V40h48l14 14v24" /><path pathLength="1" d="M118 40v14h14" />
        <path pathLength="1" d="M70 122v40h60v-40" />
      </g>
      <g class="b">
        <path pathLength="1" d="M70 142H50a12 12 0 0 1-12-12V90a12 12 0 0 1 12-12h100a12 12 0 0 1 12 12v40a12 12 0 0 1-12 12h-20" />
        <circle pathLength="1" cx="138" cy="95" r="4" /><circle pathLength="1" cx="151" cy="95" r="4" />
        <path pathLength="1" d="M56 122h88" /><path pathLength="1" d="M84 137h32" /><path pathLength="1" d="M84 149h32" />
      </g>
    </svg>
  </div>
  <script>
    // Fades out once it has shown for 1 s (0.5 s with reduced motion) AND the app has drawn; never stuck past 8 s.
    (function () {
      var el = document.getElementById('splash'), root, t0 = Date.now();
      var min = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 500 : 1000;
      function done() { el.className = 'out'; setTimeout(function () { el.remove(); }, 450); }
      function check() { root = root || document.getElementById('root');
        if (root && root.firstChild && Date.now() - t0 >= min) done(); else setTimeout(check, 60); }
      check();
      setTimeout(function () { if (el.isConnected && el.className !== 'out') done(); }, 8000);
    })();
  </script>
  <div id="root"></div>
</body>
```

The home-screen app icon is separate. Keep it a plain flat icon, not the neon sign.

### 7.3 Changing sections and layout (View Transitions on desktop)

On desktop, layout changes go through the browser's View Transitions API:
- switching sections;
- opening a card;
- opening the details panel;
- reordering.

Elements that should glide get a unique `view-transition-name`, and everything else cross-fades. Use this small helper with any framework. The update function must change the DOM synchronously; in React, wrap the state change in `flushSync`.

```js
/** Apply a change with a view transition on desktop; instantly on phones, with reduced motion, or without support. */
export function withViewTransition(update, kind = 'state') {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce), (max-width: 800px)').matches) {
    update(); return Promise.resolve();
  }
  const root = document.documentElement;
  root.dataset.vt = kind;                     // lets CSS pick timings per kind ('tab', 'state', 'panel-open', ...)
  const t = document.startViewTransition(update);
  t.finished.finally(() => { if (root.dataset.vt === kind) delete root.dataset.vt; });
  return t.updateCallbackDone.catch(() => {});
}
/* Give an element its own moving layer: style="view-transition-name: card-12; view-transition-class: card" */
```

```css
::view-transition-group(*) { animation-duration: 260ms; animation-timing-function: var(--ease); }
/* a card that grows or shrinks reveals its content from the top instead of being stretched */
::view-transition-old(*), ::view-transition-new(*) { height: 100%; object-fit: none; object-position: top left; }
::view-transition-old(root), ::view-transition-new(root) { height: auto; object-fit: fill; object-position: 50% 50%; }
/* clip each moving snapshot to its animating size, with the element's own corners */
::view-transition-group(*.pane) { overflow: hidden; border-radius: 32px; }
::view-transition-group(*.card) { overflow: hidden; border-radius: 22px; }
/* a card that is opening keeps its outline drawn all the way round while it grows */
::view-transition-group(*.card-open) { overflow: hidden; border-radius: 22px; box-sizing: border-box; border: 1px solid var(--outline); }
::view-transition-image-pair(*.card-open) { inset: -1px; }
/* switching sections is sideways, not deeper: just a quick cross-fade, no slide */
html[data-vt="tab"]::view-transition-group(*) { animation-duration: 180ms; }
```

**Sections:**
- **Desktop:** clicking a tab runs `withViewTransition(() => navigate(url), 'tab')`, a 180ms cross-fade.
- **Phone:** navigate normally. The page fades in (`.page { animation: fade-in .2s ease-out; }`) while the tab bar's pill slides to the new tab (`.bnav__pill { transition: transform .32s var(--ease); }`, set to `translateX(index * 100%)`).
- **Tapping the tab you're already on** scrolls the page smoothly back to the top, as on iOS.

### 7.4 Cards opening, closing and switching view

- **Opening a card on desktop:** a view transition (7.3). The card grows downwards with its outline intact, and the cards below glide down. Give every card `view-transition-name: card-<id>`. Give the open one the class `card-open` and the closed ones `card`.
- **Opening a card on a phone:** its rows fade down into place.

  ```css
  @media (max-width: 800px) { .card.open .card__row { animation: row-in .24s var(--ease) both; } }
  ```

- **Chevron:** rotates 90° when the card opens.

  ```css
  .fold-ic { display: flex; transition: transform .25s var(--ease); } .fold-ic.open { transform: rotate(90deg); }
  ```

- **Open and selected state:** border and lift change with `transition: box-shadow .25s ease, border-color .25s ease`.
- **Switching the list's view or grouping** (for example "by printer" / "by place"):
  - Close all open cards first.
  - Re-mount the list with a new `key`, so its cards rise in one after another.
  - The button that switched it rings once in the accent colour.

  ```css
  .list--in > .card { animation: view-in .5s var(--ease) both; animation-delay: calc(var(--i, 0) * 45ms); } /* style="--i: <index, max 12>" */
  .icon-btn.view-flash { animation: btn-ring 1s ease-out; color: var(--accent-line); }
  ```

  Remove `list--in` and `view-flash` about 1s later. While the alternative view is on, keep its button coloured `--accent-line` so the user can see it isn't the default.
- **Drag to reorder:** the lifted row gets a shadow and an ink border and follows the pointer with no transition. The other rows slide out of its way with `transition: transform .2s var(--ease)`.

### 7.5 Master / detail panel

On desktop, opening an item shows its details in a panel beside the list. The list narrows (snapped, inside a view transition), and the panel slides in from the right while fading in:

```css
.detail-pane { opacity: 0; transform: translateX(48px); pointer-events: none;
  transition: opacity .4s ease .1s, transform .55s var(--ease); }
.stage.open .detail-pane { opacity: 1; transform: none; pointer-events: auto; }
html[data-vt^="panel"]::view-transition-group(*) { animation-duration: 450ms; }   /* the list's move matches the panel's pace */
@media (max-width: 800px) {
  /* phones: the details are a full screen that slides in from the right, like an iOS push */
  .detail-pane { position: fixed; inset: 0; z-index: 30; opacity: 1; transform: translateX(105%); transition: transform .5s var(--ease); }
  .stage.open .detail-pane { transform: none; }
}
```

### 7.6 Sheets, windows, menus, toasts

- **Bottom sheet:** slides up with `sheet-up .38s var(--ease) both`, and the shade behind it fades in with `fade-in .32s ease-out both` at the same moment (see 6.9 and rule 8.3).
- **Contents of an opening sheet rise in a cascade,** starting before the sheet has finished arriving:

  ```css
  .sheet .rise { animation: rise-far .5s var(--ease) both; }  /* style="animation-delay: <0.12 + i * 0.035>s" */
  ```

  A "featured" item at the top gets the first delay (0.12s), section labels and items follow in order (+35ms each).
- **Windows (dialogs):** the same shade fade. Centred windows appear with the shade; bottom-sheet windows slide up.
- **Menus:** appear instantly (no animation) right next to the button. They close on scroll, on Escape and on an outside click.
- **Toast:** rises 8px while fading in, `toast-in .22s var(--ease) both`.
- **Tooltips and explanation pop-ups:** `fade-in .15s ease-out`.
- **Compact top bar:** fades and slides down 8px, `transition: opacity .2s ease, transform .25s var(--ease)` (6.8).

### 7.7 Charts and dashboards

Every chart builds itself when it appears. Order: the cards rise, then bars grow and lines draw, then end labels fade in last.

```css
/* dashboard tiles and chart cards rise in, each a beat after the one before */
.tile, .chart-card { animation: rise-in .5s var(--ease) both; }
.tile:nth-child(2) { animation-delay: .05s; } .tile:nth-child(3) { animation-delay: .1s; } .tile:nth-child(4) { animation-delay: .15s; }
.chart-card { animation-delay: .2s; } .chart-card + .chart-card { animation-delay: .26s; }

/* a small trend line (sparkline) in a tile's corner wipes in left to right, after its tile */
.tile__spark { animation: wipe .9s cubic-bezier(.3, .7, .2, 1) .45s both; }
.tile:nth-child(2) .tile__spark { animation-delay: .55s; } .tile:nth-child(3) .tile__spark { animation-delay: .65s; } .tile:nth-child(4) .tile__spark { animation-delay: .75s; }

/* line charts: each line draws along its length (<path pathLength="1" class="chart-line">) */
.chart-line { fill: none; stroke-width: 2.4; stroke-linejoin: round; stroke-linecap: round;
  stroke-dasharray: 1; animation: draw 1.2s cubic-bezier(.3, .7, .2, 1) .35s both; }
.chart-line__end { animation: fade-in .4s ease 1.4s both; }        /* the dot at the line's end */
.chart-line__label { animation: fade-in .4s ease 1.5s both; }      /* the value pill at the end */

/* bar charts: bars grow up from the baseline, left to right */
.bar { transform-origin: bottom; animation: bar-up .5s var(--ease) both; }   /* style="animation-delay: <0.25 + i * 0.6 / n>s" */
/* ranking bars: grow from the left, top to bottom */
.rank-bar { transform-origin: left; animation: bar-grow .7s var(--ease) both; } /* style="animation-delay: <0.3 + i * 0.04>s" */

/* pie: turns in slightly while growing; the highlighted slice lifts up when it changes */
.pie { animation: pie-in .7s var(--ease) .45s both; }
.pie__raised { animation: lift-up .22s var(--ease); }
```

For bar charts, spread the stagger over a fixed 0.6s whatever the bar count (`i * 0.6 / n`), so 7 bars and 90 bars take the same time.

Chart interaction:
- On hover, a dashed vertical cursor line appears, with value pills beside it.
- The hovered day shows as a dark pill in the date row, while the other dates fade to 25% (`transition: opacity .15s ease`).
- Legend dots scale slightly on hover (`transition: transform .2s var(--ease)`).
- Charts get `user-select: none`.

### 7.8 Feedback and small interactions

- **Loading or refreshing:** the button's icon spins.

  ```css
  .spin svg { animation: spin .8s linear infinite; }
  @media (prefers-reduced-motion: reduce) { .spin svg { animation: pulse 1.2s ease-in-out infinite; } }
  ```

  The button stays at full opacity while disabled and spinning.
- **Search on phones:** the search starts as a 40px round button. Tapping it widens it into a field: `.search.open { flex: 1; animation: search-grow .28s var(--ease); }`.
- **Checkbox tick:** the tick mark scales in from 0 to 1 (`transition: transform .15s var(--ease)`), drawn with two borders rotated -45°.
- **Toggle:** the knob slides in `.2s var(--ease)`, and the track colour changes in `.2s` (6.6).
- **"Here it is" outline** marks the item a link or notification points to. It is scrolled into view and outlined in the accent colour for a moment, then the outline fades:

  ```css
  .card.target { animation: target 2.6s ease-out; }   /* remove the class after ~2.6 s */
  ```

- **"Look here" beacon** draws attention to a panel the user was sent to (for example, a cart button pointing at the basket). The ring spreads 16px from the edge and fades, the panel lifts 1%, and its face warms with a 7% accent tint, all in one 1.8s pass. Pressing again restarts it.

  ```css
  .beacon { position: relative; animation: lift 1.8s var(--ease); }
  .beacon::after  { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; animation: ring 1.8s cubic-bezier(.2, .6, .3, 1); }
  .beacon::before { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: var(--accent-line); opacity: 0; animation: tint 1.8s ease-out; }
  ```

  ```js
  // restart while it is still running (re-adding the class alone wouldn't)
  function beacon(el) {
    if (el.classList.contains('beacon')) el.getAnimations({ subtree: true }).forEach(a => { a.cancel(); a.play(); });
    el.classList.add('beacon');
    clearTimeout(el._beacon); el._beacon = setTimeout(() => el.classList.remove('beacon'), 2000);
  }
  ```

  The panel's container must not clip overflow (`overflow: hidden`/`clip`) on desktop, or the ring is cut off at the sides.
- **Hover:** cards brighten (`--hover` / `--glass-hover`), plain buttons get an ink border, and featured cards rise 2px with a deeper shadow (`transition: transform .2s var(--ease), box-shadow .2s ease`). Only add hover effects inside `@media (hover: hover)`, so phones don't keep a stuck hover after a tap.

### 7.9 Timing cheat sheet

| Element | Animation | Duration / delay |
|---|---|---|
| Opening screen | scale .86→1 + fade, then strokes draw | .5s; draw .6s at .05s / .22s; min 1s on screen; fade out .4s |
| Section switch (desktop) | view-transition cross-fade | 180ms |
| Section switch (phone) | page fade + tab-bar pill slide | .2s / .32s |
| Card open/close (desktop) | view-transition glide | 260ms |
| Rows in an opened card (phone) | down 6px + fade | .24s |
| Chevron | rotate 90° | .25s |
| View switch | cards rise 18px + scale .98, stagger 45ms; button ring | .5s; 1s |
| Details panel | slide 48px + fade | .55s (fade .4s at .1s) |
| Phone details screen | slide from right | .5s |
| Bottom sheet | slide up from 100% | .38s |
| Shade behind sheets and windows | opacity fade | .32s |
| Items in an opening sheet | rise 36px + fade | .5s, from .12s, +35ms each |
| Toast | rise 8px + fade | .22s |
| Compact top bar | fade + 8px down | .2s / .25s |
| Dashboard tiles | rise 12px + fade | .5s, +50ms each |
| Sparklines | wipe left→right | .9s from .45s, +100ms each |
| Line charts | draw along length | 1.2s at .35s; end labels at 1.4–1.5s |
| Bars | grow from baseline | .5s, spread over .6s from .25s |
| Pie | turn -14° + scale .9 + fade | .7s at .45s |
| "Here it is" outline | accent ring holds, then fades | 2.6s |
| "Look here" beacon | ring 0→16px, 1% lift, 7% tint | 1.8s, once |
| Spinner | rotate | .8s linear, loop |

### 7.10 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
  .spin svg { animation: pulse 1.2s ease-in-out infinite !important; }   /* loading still needs a sign of life */
}
```

The view-transition helper (7.3) also skips the transition. The opening screen shows for 0.5s without drawing.

---

## 8. Rules and pitfalls (read before shipping)

1. **Something must sit behind glass.** Without the glow (4.2), glass panes look like flat washed-out grey. If a full-screen view covers the page on phones, paint the glow behind it too: `background: linear-gradient(to bottom, var(--bg), transparent 26vh), var(--glow-bg), var(--bg)`.
2. **Blur only what moves over content.** Use blur on bars, sheets, windows and menus. Use clear glass with no blur on cards, list rows and buttons. Blurring many list items makes scrolling slow on phones.
3. **Dimming behind sheets and windows:**
   - Make the dim shade its own full-screen element: a direct child of `<body>` (portal it), or a direct sibling of the window.
   - Fade its **opacity**. Don't animate its background-color from transparent.
   - The window's own wrapper must not be a transparent full-screen box. Make it only as tall as the window.

   Reason: Safari (iOS 26) colours the strip above the page from the colour of what covers the top of the screen. If the dim starts transparent, or is nested inside a small container, that strip stays the plain page colour and doesn't dim. If the dim appears instantly instead of fading, it reads as a flicker.
4. **No sticky strips with their own background on glass.** A sticky header inside a sheet needs a backing, and on glass that shows as a band. Either let the heading scroll away, or use a three-part layout (fixed head / scrolling middle / fixed foot) where nothing scrolls under the head.
5. **Small grey bits go see-through on glass.** Icon circles, bar tracks, dividers and quiet buttons use the glass versions of `--tile`, `--track`, `--line` (4.1). Otherwise they look like opaque grey stickers on the pane.
6. **Keep text solid.** Never put body text on a transparent background without the glass gradient behind it. Tooltips and small explanation pop-ups stay **solid** (`--card`), because they sit over other text.
7. **Contrast:** dark text on pastel primaries (blue/green themes), white on dark ink. Check muted text against glass over the brightest glow spot.
8. **Glass in dark themes is a faint white film** (`rgba(255,255,255,.07)`) with a weak rim, not a white sheen. Use a neutral glow for light and dark, not the accent colour, so the page doesn't get an orange cast.
9. **Phones:**
   - Respect `env(safe-area-inset-*)` on the page, tab bar, sheets and the top bar.
   - Use `dvh` units for sheet heights, so Safari's toolbars are accounted for.
   - Lock page scroll only on phones while a sheet is open.
   - Prevent sideways scrolling: `html, body { overflow-x: clip; }`, plus `overflow-x: clip` on sheets and window bodies.
10. **Focus:** controls show a 2px `--ink` outline with 2px offset on `:focus-visible`. Search fields show a 2px ring with `:focus-within`. The window box itself takes focus without an outline.
11. **Don't select text on charts and controls:** add `user-select: none` to chart SVGs and drag areas.
12. **One shade value per kind.**
    - Solid style: `rgba(30,30,28,.45)` for all shades.
    - Glass style: `.26` behind windows, `.2` behind sheets.

---

## 9. Checklist

- [ ] Tokens, themes and the glass layer are in the global stylesheet; components use only tokens.
- [ ] `data-theme` and `data-surface` are set before first paint; `theme-color` follows the theme.
- [ ] The glow is visible behind the page, and fades out at the top on phones.
- [ ] Cards and rows: 22px radius, clear glass, white rim, glass shine. Panes: 32px.
- [ ] Round 48/56px icon buttons; one dark circle for profile / ×.
- [ ] Primary buttons are dark pills; colour only for badges, focus and highlights.
- [ ] Segmented controls and nav: trough + raised glass pill.
- [ ] Phone: floating frosted tab bar with a sliding pill; compact frosted top bar after scrolling.
- [ ] Big views open as bottom sheets (85% / 90%) with a fading shade, × in a dark circle, fixed heading and footer.
- [ ] Windows and menus are frosted pop-up glass; fields inside them are glass.
- [ ] Opening screen: the logo lights up as a neon sign in the theme's colours, at least 1 s, then fades.
- [ ] Desktop section switches and card opening use view transitions; phones use the CSS fallbacks.
- [ ] Things that appear together rise in a stagger; sheet contents start rising while the sheet is still sliding.
- [ ] Charts build in: tiles rise, sparklines wipe, lines draw, bars grow, end labels fade in last.
- [ ] Feedback: spinning refresh, the button ring on a view switch, the "here it is" outline, the "look here" beacon.
- [ ] Motion uses `--ease`, short durations, and respects reduced motion.
- [ ] Tested in light, dark and one pastel theme, in glass and solid, at 1440px and phone width (iPhone Safari if possible).
