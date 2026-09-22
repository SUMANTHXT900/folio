<p align="center">
  <img src="public/favicon.svg" alt="Folio" width="64" height="64" />
</p>

<h1 align="center">Folio</h1>

<p align="center">
  <strong>Private, 100% client-side PDF tools.</strong><br />
  Merge, split, rearrange, rotate, and compress — entirely in your browser.<br />
  Your files never leave your device.
</p>

<p align="center">
  <a href="https://dev.folio-pdf.pages.dev/" target="_blank" rel="noopener">
    <img src="https://img.shields.io/badge/Live-dev.folio--pdf.pages.dev-d9902d?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Live dev preview" />
  </a>
  <img src="https://img.shields.io/badge/version-1.6.0-dev-d9902d?style=for-the-badge" alt="Version" />
  <img src="https://img.shields.io/badge/privacy-100%25%20client--side-16a34a?style=for-the-badge" alt="Privacy" />
</p>

> **This is the `dev` branch** — staging preview. Production (`main`) lives at [folio-pdf.pages.dev](https://folio-pdf.pages.dev).

---

## Why Folio?

Most PDF tools upload your documents to a server to process them. **Folio doesn't.**
Every operation runs locally in your browser using [pdf-lib](https://pdf-lib.js.org/) and
[pdf.js](https://mozilla.github.io/pdf.js/). Nothing is uploaded, nothing is stored, nothing
leaves your machine. It's a Progressive Web App, so it also works offline once loaded.

- 🔒 **Private by design** — files are processed in-memory and discarded when you close the tab
- ⚡ **Fast** — no network round-trips, no waiting on a server
- 📴 **Offline-capable** — installable PWA, works without a connection
- 🪶 **Lightweight** — no account, no tracking, no cookies

## Features

| Tool | What it does |
|------|--------------|
| **Merge** | Combine multiple PDFs into one document, in any order |
| **Split** | Open a visual page-picker grid, uncheck the pages you want to drop, and export the rest |
| **Rearrange** | Drag to reorder pages, then click any page to open a full-screen viewer modal |
| **Rotate** | Rotate individual pages or the whole document |
| **Compress** | Rasterize to shrink file size — and honestly tells you when a file is already as compact as it gets (never upscales) |

## Tech stack

- **Vite** + **React** + **TypeScript**
- **Tailwind CSS** for styling, **Framer Motion** for transitions
- **pdf-lib** & **pdf.js** for all PDF operations (client-side)
- **Cloudflare Pages** for hosting (hash routing, no SPA rewrite needed)

## Getting started

```bash
# install dependencies
npm install

# run the dev server
npm run dev

# build for production (outputs to dist/)
npm run build

# preview the production build locally
npm run preview
```

> Requires Node.js 18+.

## Deploy

Folio is a static site. Build and deploy `dist/` to any static host — Cloudflare Pages, Netlify,
GitHub Pages, or your own server.

```bash
npm run build
npx wrangler pages deploy dist --project-name folio-pdf
```

## Privacy

Folio makes **no network requests** for file processing. There is no backend, no analytics
beacon in the processing path, and no account system. The only external request is the optional
Cloudflare Web Analytics tag (visitor counts only, no PII) if you enable it on your deployment.

## License

[MIT](LICENSE) © SUMANTHXT900

---

<p align="center">
  Made with care by <a href="https://github.com/SUMANTHXT900" target="_blank" rel="noopener">Sumanth</a>
  · <a href="https://www.linkedin.com/in/sai-sumanth-giduthuri-0a9956329/" target="_blank" rel="noopener">LinkedIn</a>
</p>
