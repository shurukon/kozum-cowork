# Preview visual evidence

## Local Chromium proof

The local preview server was started for `artifacts/preview-demo/index.html` and opened at:

`http://127.0.0.1:35385/__kozum_preview/mUyH1ax810H9CW7KwqO2cfDH/index.html`

The Chromium screenshot was saved by the browser session at `/home/ubuntu/screenshots/127_0_0_1_2026-08-22_14-12-52_3863.webp`.

Visible evidence: the landing page rendered its dark visual layout, relative stylesheet, Kozum mark, compass, spark, layers, bolt, and check SVG assets. The browser extracted the expected title and page content; no missing-icon placeholders appeared.

A real click on `#heroAction` changed the live status from `Ready for interaction` to `Interaction confirmed · local script is running`, proving that the local JavaScript executed inside the preview frame. The post-click screenshot was saved at `/home/ubuntu/screenshots/127_0_0_1_2026-08-22_14-12-59_2271.webp`.

Security evidence: the server test also confirmed a loopback-only origin, a restrictive CSP containing `default-src 'self'` and `connect-src 'none'`, and HTTP 403 for a path traversal request outside the selected HTML directory. The fallback path remains the sanitized static artifact canvas when the live service is unavailable.
