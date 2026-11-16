// The click/press guard under happy-dom:  bun test test/guard.test.ts
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { closestControl, guardClick, guardPress, guardReason } from "../extension/src/guard";

function page(html: string): Document {
  const win = new Window({ url: "https://a.example/" });
  win.document.write(`<body>${html}</body>`);
  return win.document as unknown as Document;
}
const $ = (doc: Document, sel: string) => doc.querySelector(sel)!;

describe("what gets stopped", () => {
  test("a button whose name sounds final", () => {
    const doc = page(`<button id="b">Delete account</button>`);
    expect(guardReason($(doc, "#b"))).toContain("“Delete account”");
    expect(() => guardClick($(doc, "#b"), false)).toThrow(/not activated.*confirm: true/);
  });

  test("the name can come from aria-label, not only the text", () => {
    const doc = page(`<button id="b" aria-label="Remove item"><svg></svg></button>`);
    expect(guardReason($(doc, "#b"))).toContain("Remove item");
  });

  test("a click on something inside the button is judged by the button", () => {
    const doc = page(`<button><span id="inner"><b>Pay</b> now</span></button>`);
    expect(closestControl($(doc, "#inner"))?.tagName).toBe("BUTTON");
    expect(guardReason($(doc, "#inner"))).toContain("Pay now");
  });

  test("a real button with no name at all", () => {
    const doc = page(`<button id="b"><svg></svg></button>`);
    expect(guardReason($(doc, "#b"))).toContain("unnamed button");
  });

  test("role=button counts as a real control", () => {
    const doc = page(`<div id="b" role="button">Send</div>`);
    expect(guardReason($(doc, "#b"))).toContain("Send");
  });

  test("weak words stop buttons but not links", () => {
    const doc = page(`<button id="b">Share</button><a id="a" href="/orders">Order history</a>`);
    expect(guardReason($(doc, "#b"))).toContain("Share");
    expect(guardReason($(doc, "#a"))).toBe(null);
  });

  test("a strong word stops a link too", () => {
    const doc = page(`<a id="a" href="/logout">Sign out</a>`);
    expect(guardReason($(doc, "#a"))).toContain("Sign out");
  });

  test("a clickable div is stopped by a strong word only", () => {
    const doc = page(`<div id="d">Delete everything</div><div id="e">Share</div><div id="f"></div>`);
    expect(guardReason($(doc, "#d"))).toContain("Delete everything");
    expect(guardReason($(doc, "#e"))).toBe(null);
    expect(guardReason($(doc, "#f"))).toBe(null); // empty plain content is not "an unnamed button"
  });

  test("a button inside a web component is found through the shadow root", () => {
    const doc = page(`<x-del id="host"></x-del>`);
    const root = $(doc, "#host").attachShadow({ mode: "open" });
    root.innerHTML = `<div><button><span id="deep">Delete everything</span></button></div>`;
    const deep = root.querySelector("#deep")!;
    expect(guardReason(deep)).toContain("Delete everything");
  });

  test("content inside a web component that is itself a control is judged by the host", () => {
    const doc = page(`<a id="host" href="/pay"></a>`);
    const root = $(doc, "#host").attachShadow({ mode: "open" });
    root.innerHTML = `<span id="deep">Checkout</span>`;
    expect(closestControl(root.querySelector("#deep")!)?.id).toBe("host");
  });
});

describe("what goes through", () => {
  test("ordinary buttons, links and fields", () => {
    const doc = page(`<button id="b">Next page</button><a id="a" href="/x">Invoices</a><input id="i" aria-label="Search">`);
    for (const id of ["#b", "#a", "#i"]) expect(() => guardClick($(doc, id), false)).not.toThrow();
  });

  test("anything, once the caller states the user agreed", () => {
    const doc = page(`<button id="b">Delete account</button><button id="n"></button>`);
    expect(() => guardClick($(doc, "#b"), true)).not.toThrow();
    expect(() => guardClick($(doc, "#n"), true)).not.toThrow();
  });

  test("no element at that point", () => {
    expect(() => guardClick(null, false)).not.toThrow();
  });
});

describe("keys", () => {
  test("Enter or Space on a final-sounding control is stopped", () => {
    const doc = page(`<button id="b">Delete account</button>`);
    for (const key of ["Enter", " ", "Space"]) expect(() => guardPress($(doc, "#b"), key, false)).toThrow(/browser_press/);
    expect(() => guardPress($(doc, "#b"), "Enter", true)).not.toThrow();
  });

  test("other keys are never stopped", () => {
    const doc = page(`<button id="b">Delete account</button>`);
    for (const key of ["Tab", "Escape", "ArrowDown", "a"]) expect(() => guardPress($(doc, "#b"), key, false)).not.toThrow();
  });

  test("Enter in a field is judged by the form's submit button", () => {
    const doc = page(`
      <form><input id="msg"><button>Send</button></form>
      <form><input id="q"><button>Search</button></form>
      <form><input id="pay"><input type="submit" value="Pay now"></form>
      <form><input id="nosubmit"><button type="button">Delete</button></form>`);
    expect(() => guardPress($(doc, "#msg"), "Enter", false)).toThrow(/“Send”/);
    expect(() => guardPress($(doc, "#q"), "Enter", false)).not.toThrow();
    expect(() => guardPress($(doc, "#pay"), "Enter", false)).toThrow(/Pay now/);
    expect(() => guardPress($(doc, "#nosubmit"), "Enter", false)).not.toThrow(); // type=button does not submit
  });

  test("Space in a field types a space; a field outside any form is free", () => {
    const doc = page(`<form><input id="msg"><button>Send</button></form><input id="loose">`);
    expect(() => guardPress($(doc, "#msg"), " ", false)).not.toThrow();
    expect(() => guardPress($(doc, "#loose"), "Enter", false)).not.toThrow();
  });
});
