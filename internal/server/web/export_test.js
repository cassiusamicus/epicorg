import { parseMdToNodes, generateRevealHtml } from "./export.js";

function makeNode(overrides = {}) {
  return { id: "n" + Math.random(), title: "", body: "", children: [], tags: [], status: null, priority: null, properties: {}, ...overrides };
}

// --- Minimal test runner (mirrors tree_test.js) ---

let _pass = 0, _fail = 0;
const _failures = [];

function assert(cond, msg = "") {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(a, b, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

function test(name, fn) {
  try {
    fn();
    _pass++;
  } catch (e) {
    _fail++;
    _failures.push({ name, error: e.message });
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}

function report() {
  console.log(`\n${_pass + _fail} tests, ${_pass} passed, ${_fail} failed`);
  const el = document.getElementById("results");
  if (el) {
    let html = `<h2>${_pass + _fail} tests, <span style="color:green">${_pass} passed</span>`;
    if (_fail > 0) html += `, <span style="color:red">${_fail} failed</span>`;
    html += `</h2>`;
    for (const f of _failures) {
      html += `<div style="color:red;margin:4px 0"><b>${f.name}</b>: ${f.error}</div>`;
    }
    if (_fail === 0) html += `<div style="color:green;margin-top:8px">All tests passed.</div>`;
    el.innerHTML += html;
  }
}

// --- parseMdToNodes ---

test("parseMdToNodes: converts heading depths to nested outline levels", () => {
  const md = "# Top\n\n## Sub\n\n### Deep\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes.length, 1);
  assertEqual(nodes[0].title, "Top");
  assertEqual(nodes[0].children[0].title, "Sub");
  assertEqual(nodes[0].children[0].children[0].title, "Deep");
});

test("parseMdToNodes: a heading back at a shallower depth becomes a new root, not a child", () => {
  const md = "# First\n\n## Child\n\n# Second\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes.length, 2);
  assertEqual(nodes[0].children.length, 1);
  assertEqual(nodes[1].children.length, 0);
});

test("parseMdToNodes: converts a markdown link to an org link", () => {
  const md = "# H\n\nSee [the site](https://example.com) for more.\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes[0].body, "See [[https://example.com][the site]] for more.");
});

test("parseMdToNodes: converts bold and italic without corrupting each other", () => {
  const md = "# H\n\nThis is **bold** and this is *italic*.\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes[0].body, "This is *bold* and this is /italic/.");
});

test("parseMdToNodes: converts bold and italic together in the same line", () => {
  const md = "# H\n\n**bold** then *italic* then **bold again**.\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes[0].body, "*bold* then /italic/ then *bold again*.");
});

test("parseMdToNodes: converts strikethrough and inline code", () => {
  const md = "# H\n\n~~gone~~ and `code`.\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes[0].body, "+gone+ and =code=.");
});

test("parseMdToNodes: preserves text before the first heading as preamble", () => {
  const md = "Some intro text.\n\n# H\n\nBody.\n";
  const { nodes, preamble } = parseMdToNodes(md);
  assertEqual(preamble, "Some intro text.");
  assertEqual(nodes[0].title, "H");
});

test("parseMdToNodes: converts a fenced code block to a #+BEGIN_SRC block", () => {
  const md = "# H\n\n```js\nconst x = 1;\n```\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes[0].body, "#+BEGIN_SRC js\nconst x = 1;\n#+END_SRC");
});

// --- generateRevealHtml ---

// Minimal but distinguishable stand-ins for the real (fetched) asset text —
// each has a unique marker string so tests can assert presence/absence
// without needing the actual multi-hundred-KB library contents.
function makeAssets(overrides = {}) {
  return {
    revealCss: ".marker-reveal-css{}", revealJs: "/*marker-reveal-js*/",
    themeCss: ".marker-theme-css{}", layoutCss: ".marker-layout-css{}",
    notesJs: "/*marker-notes-js*/",
    zoomJs: "/*marker-zoom-js*/",
    highlightJs: "/*marker-highlight-js*/", highlightCss: ".marker-highlight-css{}",
    mathJs: "/*marker-math-js*/",
    menuJs: "/*marker-menu-js*/", menuCss: ".marker-menu-css{}",
    ...overrides,
  };
}

test("generateRevealHtml: each top-level node becomes its own top-level <section>", () => {
  const nodes = [makeNode({ title: "First" }), makeNode({ title: "Second" })];
  const html = generateRevealHtml(nodes, "", "test.org", makeAssets(), {});
  const slidesBlock = html.split('<div class="slides">')[1].split("</div>")[0];
  // Both headings present, and neither is nested inside the other's <section>.
  assert(slidesBlock.includes("<h2>First</h2>"), "missing First heading");
  assert(slidesBlock.includes("<h2>Second</h2>"), "missing Second heading");
  const firstSectionEnd = slidesBlock.indexOf("</section>");
  assert(slidesBlock.indexOf("<h2>Second</h2>") > firstSectionEnd, "Second should not be nested inside First's section");
});

test("generateRevealHtml: a leaf child with a short body becomes a fragment bullet, not a slide", () => {
  const child = makeNode({ title: "A bullet point" });
  const parent = makeNode({ title: "Parent", children: [child] });
  const html = generateRevealHtml([parent], "", "test.org", makeAssets(), {});
  assert(html.includes('<li class="fragment">A bullet point</li>'), "leaf child should render as a fragment <li>");
  assert(!html.includes("<h2>A bullet point</h2>"), "leaf child should not get its own heading/slide");
});

test("generateRevealHtml: a child with its own children becomes a nested vertical slide, not a bullet", () => {
  const grandchild = makeNode({ title: "Grandchild bullet" });
  const child = makeNode({ title: "Sub-slide", children: [grandchild] });
  const parent = makeNode({ title: "Parent", children: [child] });
  const html = generateRevealHtml([parent], "", "test.org", makeAssets(), {});
  assert(html.includes("<h2>Sub-slide</h2>"), "non-leaf child should become its own slide heading");
  assert(!html.includes('<li class="fragment">Sub-slide</li>'), "non-leaf child should not be flattened into a bullet");
});

test("generateRevealHtml: a child titled 'Notes' becomes speaker notes, not visible content", () => {
  const notes = makeNode({ title: "Notes", body: "Remember to mention the swerve." });
  const parent = makeNode({ title: "Parent", children: [notes] });
  const html = generateRevealHtml([parent], "", "test.org", makeAssets(), {});
  assert(html.includes('<aside class="notes">Remember to mention the swerve.</aside>'), "Notes child should become an <aside class=\"notes\">");
  assert(!html.includes("<h2>Notes</h2>"), "Notes child should not render as its own slide");
  assert(!html.includes('<li class="fragment">Notes</li>'), "Notes child should not render as a bullet either");
});

test("generateRevealHtml: REVEAL_TRANSITION and REVEAL_BACKGROUND properties become data attributes", () => {
  const node = makeNode({ title: "Styled", properties: { REVEAL_TRANSITION: "zoom", REVEAL_BACKGROUND: "#222222" } });
  const html = generateRevealHtml([node], "", "test.org", makeAssets(), {});
  assert(html.includes('data-transition="zoom"'), "missing data-transition attribute");
  assert(html.includes('data-background="#222222"'), "missing data-background attribute");
});

test("generateRevealHtml: REVEAL_BACKGROUND with an image URL becomes data-background-image", () => {
  const node = makeNode({ title: "Styled", properties: { REVEAL_BACKGROUND: "https://example.com/pic.jpg" } });
  const html = generateRevealHtml([node], "", "test.org", makeAssets(), {});
  assert(html.includes('data-background-image="https://example.com/pic.jpg"'), "image URL should use data-background-image");
});

test("generateRevealHtml: uses #+TITLE: from the preamble as the document title", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "#+TITLE: My Deck", "test.org", makeAssets(), {});
  assert(html.includes("<title>My Deck</title>"), "expected #+TITLE: to become the <title>");
});

test("generateRevealHtml: theme and layout CSS are embedded inline, not linked externally", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), {});
  assert(html.includes(".marker-theme-css{}"), "theme CSS should be inlined");
  assert(html.includes(".marker-layout-css{}"), "layout CSS should be inlined");
  assert(!html.includes("<link"), "nothing should be linked externally — everything is inlined");
});

test("generateRevealHtml: each line of a multi-line body becomes its own paragraph (epicorg collapses blank lines to single newlines, so a single \\n is the real paragraph separator, not \\n\\n)", () => {
  const node = makeNode({ title: "X", body: "First line.\nSecond line." });
  const html = generateRevealHtml([node], "", "test.org", makeAssets(), {});
  assert(html.includes("<p>First line.</p>"), "expected first line as its own <p>");
  assert(html.includes("<p>Second line.</p>"), "expected second line as its own <p>");
  assert(!html.includes("First line. Second line."), "lines should not be smushed onto one line");
});

test("generateRevealHtml: #+begin_quote/#+end_quote becomes a real <blockquote>", () => {
  const node = makeNode({ title: "X", body: "Before.\n#+begin_quote\nA quoted line.\n#+end_quote\nAfter." });
  const html = generateRevealHtml([node], "", "test.org", makeAssets(), {});
  assert(html.includes('<blockquote class="org-quote">A quoted line.</blockquote>'), "expected quote block content wrapped in a <blockquote>");
  assert(html.includes("<p>Before.</p>"), "expected text before the quote as its own paragraph");
  assert(html.includes("<p>After.</p>"), "expected text after the quote as its own paragraph");
  assert(!html.includes("#+begin_quote") && !html.includes("#+end_quote"), "quote marker lines should not leak into the output");
});

test("generateRevealHtml: blockquote gets a left-border-bar override instead of the theme's default centered/shaded box", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), {});
  assert(html.includes("blockquote.org-quote{"), "expected a blockquote.org-quote CSS override rule");
  assert(html.includes("border-left:4px solid var(--r-link-color"), "expected a left-border bar using the theme's link-color accent");
  assert(html.includes("box-shadow:none"), "expected the theme's default box-shadow to be cleared");
});

test("generateRevealHtml: #+begin_verse/#+end_verse preserves line breaks (reveal.js has no native concept of this, so it's carried as an inline style)", () => {
  const node = makeNode({ title: "X", body: "Before.\n#+begin_verse\nLine one of the poem\nLine two of the poem\n#+end_verse\nAfter." });
  const html = generateRevealHtml([node], "", "test.org", makeAssets(), {});
  assert(html.includes('<p class="org-verse" style="white-space:pre-wrap">Line one of the poem\nLine two of the poem</p>'), "expected verse content in a pre-wrap paragraph with line breaks intact");
  assert(html.includes("<p>Before.</p>"), "expected text before the verse as its own paragraph");
  assert(html.includes("<p>After.</p>"), "expected text after the verse as its own paragraph");
  assert(!html.includes("#+begin_verse") && !html.includes("#+end_verse"), "verse marker lines should not leak into the output");
});

test("generateRevealHtml: disabling a feature omits both its script/style and its plugins-array entry", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), {
    notes: false, zoom: false, highlight: false, math: false, menu: false,
  });
  assert(!html.includes("marker-notes-js"), "notes script should be omitted");
  assert(!html.includes("marker-zoom-js"), "zoom script should be omitted");
  assert(!html.includes("marker-highlight-js") && !html.includes("marker-highlight-css"), "highlight assets should be omitted");
  assert(!html.includes("marker-math-js"), "math script should be omitted");
  assert(!html.includes("marker-menu-js") && !html.includes("marker-menu-css"), "menu assets should be omitted");
  assert(!html.includes("RevealNotes") && !html.includes("RevealZoom") && !html.includes("RevealHighlight") && !html.includes("RevealMath") && !html.includes("RevealMenu"), "disabled plugins should not appear in the plugins array");
});

test("generateRevealHtml: enabling every feature includes each script/style and plugins-array entry", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), {
    notes: true, zoom: true, highlight: true, math: true, menu: true,
  });
  for (const marker of ["marker-notes-js", "marker-zoom-js", "marker-highlight-js", "marker-highlight-css", "marker-math-js", "marker-menu-js", "marker-menu-css"]) {
    assert(html.includes(marker), `expected ${marker} to be present`);
  }
  for (const plugin of ["RevealNotes", "RevealZoom", "RevealHighlight", "RevealMath", "RevealMenu"]) {
    assert(html.includes(plugin), `expected ${plugin} in the plugins array`);
  }
});

test("generateRevealHtml: scrollView setting sets view:'scroll' in the Reveal.initialize config", () => {
  const htmlOn = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { scrollView: true });
  const htmlOff = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { scrollView: false });
  assert(htmlOn.includes('"view":"scroll"'), "scrollView:true should set view:'scroll'");
  assert(!htmlOff.includes('"view":"scroll"'), "scrollView:false should not set view:'scroll'");
});

test("generateRevealHtml: overview setting controls the overview config flag", () => {
  const htmlOn = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { overview: true });
  const htmlOff = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { overview: false });
  assert(htmlOn.includes('"overview":true'), "overview:true should appear in config");
  assert(htmlOff.includes('"overview":false'), "overview:false should appear in config");
});

test("generateRevealHtml: verticalSlides:false flattens nested children into independent top-level sections", () => {
  const grandchild = makeNode({ title: "Deep Slide", body: "Long enough body to not be a bullet\nwith a real second line." });
  const child = makeNode({ title: "Sub-slide", children: [grandchild] });
  const parent = makeNode({ title: "Parent", children: [child] });
  const htmlNested = generateRevealHtml([parent], "", "test.org", makeAssets(), { verticalSlides: true });
  const htmlFlat = generateRevealHtml([parent], "", "test.org", makeAssets(), { verticalSlides: false });
  // Nested: Deep Slide's heading appears inside a <section> that is itself inside another <section>.
  const nestedSlidesBlock = htmlNested.split('<div class="slides">')[1].split('<script')[0];
  assert((nestedSlidesBlock.match(/<section>/g) || []).length >= 1, "nested mode should produce at least one wrapping <section> with no attributes");
  // Flat: every node is its own top-level <section ...> or <section> with no extra wrapping level.
  const flatSlidesBlock = htmlFlat.split('<div class="slides">')[1].split('<script')[0];
  const flatSectionOpens = (flatSlidesBlock.match(/<section/g) || []).length;
  assert(flatSectionOpens === 3, `flat mode should produce exactly 3 <section> tags (one per node), got ${flatSectionOpens}`);
});

test("generateRevealHtml: theme is read from assets.themeCss regardless of which theme name was requested (caller resolves the file)", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets({ themeCss: ".dracula-marker{}" }), { theme: "dracula" });
  assert(html.includes(".dracula-marker{}"), "expected the caller-provided theme CSS to be embedded");
});

test("generateRevealHtml: theme:'none' omits the theme CSS entirely, even if the caller supplied one", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets({ themeCss: ".dracula-marker{}" }), { theme: "none" });
  assert(!html.includes(".dracula-marker{}"), "theme CSS should not appear when theme is 'none'");
});

test("generateRevealHtml: theme:'epicorg' also omits the theme CSS (colors come entirely from themeColors)", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets({ themeCss: ".dracula-marker{}" }), { theme: "epicorg" });
  assert(!html.includes(".dracula-marker{}"), "theme CSS should not appear when theme is 'epicorg'");
});

test("generateRevealHtml: themeColors overrides only the specified CSS custom properties, and includes the rules that actually consume them", () => {
  // Bundled theme files are the only thing that normally *reads* these
  // variables (reveal.css core never references them) — with no theme
  // file loaded (theme:'none'/'epicorg'), an override that set only the
  // custom property and not a consuming rule would silently do nothing.
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), {
    theme: "none",
    themeColors: { background: "#123456", link: "#abcdef" },
  });
  assert(html.includes("--r-background-color:#123456"), "expected background override");
  assert(html.includes("--r-link-color:#abcdef"), "expected link override");
  assert(!html.includes("--r-main-color:"), "main color was never overridden, so its property should not appear");
  assert(html.includes(".reveal-viewport{background-color:var(--r-background-color)}"), "expected the background-consuming rule");
  assert(html.includes(".reveal a{color:var(--r-link-color)}"), "expected the link-consuming rule");
});

test("generateRevealHtml: themeColors.font sets font-family directly (reveal.css core has no --r-main-font consumer to override)", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), {
    theme: "epicorg",
    themeColors: { font: '"Inter", sans-serif' },
  });
  assert(html.includes('.reveal{font-family:"Inter", sans-serif}'), "expected the font to be set directly on .reveal");
  assert(html.includes('.reveal h1,.reveal h2,.reveal h3,.reveal h4,.reveal h5,.reveal h6{font-family:"Inter", sans-serif}'), "expected the font to also apply to headings");
});

test("generateRevealHtml: themeColors:null (default) adds no color-override block", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), {});
  assert(!/:root\{--r-/.test(html), "no themeColors set, so no :root override block should be emitted");
});

test("generateRevealHtml: sizer maps to Reveal's margin config (100=no margin, 0=max margin)", () => {
  const htmlFull = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { sizer: 100 });
  assert(htmlFull.includes('"margin":0'), "sizer 100 should produce margin 0");
  const htmlMin = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { sizer: 0 });
  assert(htmlMin.includes('"margin":0.4'), "sizer 0 should produce margin 0.4");
  const htmlDefault = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), {});
  assert(htmlDefault.includes('"margin":0.04'), "default sizer (90) should reproduce reveal.js's own default margin (0.04)");
});

test("generateRevealHtml: breadcrumbs off adds no data-breadcrumb attributes or breadcrumb bar", () => {
  const nodes = [makeNode({ title: "Parent", children: [makeNode({ title: "Child", body: "x".repeat(150) })] })];
  const html = generateRevealHtml(nodes, "", "test.org", makeAssets(), { breadcrumbs: false });
  assert(!html.includes("data-breadcrumb"), "no data-breadcrumb attributes expected when breadcrumbs is off");
  assert(!html.includes("epic-breadcrumb-bar"), "no breadcrumb bar expected when breadcrumbs is off");
});

test("generateRevealHtml: breadcrumbs on adds a data-breadcrumb trail per slide, including nested vertical slides", () => {
  // A body over 140 chars keeps the child from collapsing into a fragment
  // bullet (see isLeafBullet), so it renders as its own nested <section>.
  const child = makeNode({ title: "Child", body: "x".repeat(150) });
  const nodes = [makeNode({ title: "Parent", children: [child] })];
  const html = generateRevealHtml(nodes, "", "test.org", makeAssets(), { breadcrumbs: true });
  assert(html.includes('data-breadcrumb="Parent"'), "top-level slide should have its own title as breadcrumb");
  assert(html.includes('data-breadcrumb="Parent › Child"'), "nested slide should have the full ancestor chain as breadcrumb");
  assert(html.includes('id="epic-breadcrumb-bar"'), "breadcrumb bar element should be present");
  assert(html.includes("Reveal.on(\"slidechanged\""), "breadcrumb sync script should be wired to slidechanged");
});

test("generateRevealHtml: breadcrumbPosition switches between top and left layout CSS", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { breadcrumbs: true, breadcrumbPosition: "left" });
  assert(html.includes("bottom:0;width:200px"), "left position should use the vertical-sidebar CSS");
  const htmlTop = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { breadcrumbs: true, breadcrumbPosition: "top" });
  assert(htmlTop.includes("height:36px"), "top position should use the horizontal-bar CSS");
});

test("generateRevealHtml: fontZoom on (default) adds the −/+ buttons and click handlers", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), {});
  assert(html.includes('id="epic-font-minus"'), "expected the shrink button");
  assert(html.includes('id="epic-font-plus"'), "expected the grow button");
  assert(html.includes('el.style.fontSize'), "expected the click handlers to set .reveal's font-size directly");
});

test("generateRevealHtml: fontZoom:false omits the control entirely", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { fontZoom: false });
  assert(!html.includes("epic-fontzoom"), "no fontZoom control expected when fontZoom is off");
});

test("generateRevealHtml: fontZoom control is nudged below a top breadcrumb bar, not overlapping it", () => {
  const htmlWithTopCrumbs = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { fontZoom: true, breadcrumbs: true, breadcrumbPosition: "top" });
  assert(htmlWithTopCrumbs.includes(".epic-fontzoom{position:fixed;top:44px"), "expected the control to sit below a top breadcrumb bar");
  const htmlNoCrumbs = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { fontZoom: true, breadcrumbs: false });
  assert(htmlNoCrumbs.includes(".epic-fontzoom{position:fixed;top:8px"), "expected the control back at its default position with no breadcrumb bar");
});

test("generateRevealHtml: nav arrows are always forced to the theme's link/accent color, not left to reveal.js's own light/dark auto-detection", () => {
  // reveal.js only adds has-dark-background/has-light-background when it
  // can read a per-slide background color — which falls back to a
  // transparent default with no per-slide background set (the common
  // case), silently never firing either way and leaving reveal.css
  // core's hardcoded color:#000 in effect regardless of theme. This must
  // not depend on cfg.theme/themeColors — it's a fix for every export.
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), {});
  assert(html.includes(".reveal .controls{color:var(--r-link-color,#2a76dd) !important}"), "expected the controls color to be forced to the accent color");
});

test("generateRevealHtml: fontZoom buttons and the menu button use the same accent (link) color as the nav arrows", () => {
  const html = generateRevealHtml([makeNode({ title: "X" })], "", "test.org", makeAssets(), { fontZoom: true, menu: true });
  assert(html.includes(".epic-fontzoom button{") && /\.epic-fontzoom button\{[^}]*color:var\(--r-link-color/.test(html), "expected the zoom buttons to use --r-link-color");
  assert(/fa-bars::before\{[^}]*color:var\(--r-link-color/.test(html), "expected the hamburger icon to use --r-link-color");
});

report();
