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

report();
