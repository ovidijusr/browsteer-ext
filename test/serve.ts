// Tiny static server for the test fixture so the content script injects over http.
const file = Bun.file(new URL("./fixture.html", import.meta.url).pathname);
Bun.serve({
  port: 8080,
  async fetch() {
    return new Response(await file.arrayBuffer(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
console.log("fixture on http://127.0.0.1:8080");
