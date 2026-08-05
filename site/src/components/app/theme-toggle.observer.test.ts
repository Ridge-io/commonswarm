import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");
const appHtml = readFileSync(join(siteRoot, "dist", "app", "index.html"), "utf8");
const bootstrapMatch = appHtml.match(
  /<script\b[^>]*data-theme-bootstrap[^>]*>([\s\S]*?)<\/script>/,
);

assert.ok(bootstrapMatch, "built /app must contain the inline theme bootstrap");
const bootstrap = bootstrapMatch[1];

class StorageFixture {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class RootFixture {
  attributes = new Map<string, string>();

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
}

class ElementFixture {
  textContent = "";
}

class ButtonFixture extends ElementFixture {
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
  title = "";

  querySelector(selector: string) {
    return selector === "[data-theme-toggle-label]" ? this.label : null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
  }

  click() {
    this.listeners.get("click")?.();
  }

  constructor(readonly label: ElementFixture) {
    super();
  }
}

function loadApp(storage: StorageFixture) {
  const root = new RootFixture();
  const label = new ElementFixture();
  const button = new ButtonFixture(label);
  let domReady: (() => void) | undefined;
  const window = {
    localStorage: storage,
    addEventListener(name: string, listener: () => void) {
      if (name === "DOMContentLoaded") domReady = listener;
    },
  };
  const document = {
    documentElement: root,
    querySelector(selector: string) {
      return selector === "[data-theme-toggle]" ? button : null;
    },
  };

  vm.runInNewContext(bootstrap, {
    document,
    window,
    HTMLButtonElement: ButtonFixture,
    HTMLElement: ElementFixture,
  });

  return {
    button,
    label,
    root,
    ready() {
      assert.ok(domReady, "built bootstrap must register its DOM-ready control binding");
      domReady();
    },
  };
}

test("the built theme bootstrap applies each stored state before the control binds", () => {
  for (const [preference, expectedAttribute] of [
    ["system", null],
    ["light", "light"],
    ["dark", "dark"],
  ] as const) {
    const storage = new StorageFixture();
    storage.setItem("commonswarm:theme", preference);
    const app = loadApp(storage);
    assert.equal(app.root.getAttribute("data-theme"), expectedAttribute);
  }
});

test("the control persists each choice, survives reload, and returns to live system mode", () => {
  const storage = new StorageFixture();
  let app = loadApp(storage);
  app.ready();
  assert.equal(app.label.textContent, "System");

  for (const [preference, expectedAttribute] of [
    ["light", "light"],
    ["dark", "dark"],
    ["system", null],
  ] as const) {
    app.button.click();
    assert.equal(storage.getItem("commonswarm:theme"), preference);
    assert.equal(app.root.getAttribute("data-theme"), expectedAttribute);

    app = loadApp(storage);
    assert.equal(
      app.root.getAttribute("data-theme"),
      expectedAttribute,
      `${preference} must be restored before DOMContentLoaded on reload`,
    );
    app.ready();
  }

  assert.equal(storage.getItem("commonswarm:theme"), "system");
  assert.equal(app.root.getAttribute("data-theme"), null);
  assert.match(app.button.attributes.get("aria-label") ?? "", /Theme: System\b/);
});

test("the built inline bootstrap precedes every dashboard stylesheet", () => {
  const bootstrapAt = appHtml.indexOf("data-theme-bootstrap");
  const bootstrapEndAt = appHtml.indexOf("</script>", bootstrapAt);
  const firstStylesheetAt = appHtml.indexOf('<link rel="stylesheet"');

  assert.notEqual(bootstrapAt, -1, "built /app must expose the theme bootstrap anchor");
  assert.notEqual(bootstrapEndAt, -1, "built /app must close the theme bootstrap");
  assert.notEqual(firstStylesheetAt, -1, "built /app must expose a stylesheet ordering control");
  assert.ok(
    bootstrapEndAt < firstStylesheetAt,
    "the stored preference must be applied before the first stylesheet can paint",
  );
});
