# OctaP SDK docs

The developer documentation site for `@octap/sdk` and `@octap/browser-sdk`, built with Astro Starlight. It has its own dependencies and is not part of the root npm workspaces. It lives here for now, and is planned to move to docs.octap.com (OCT-246).

```sh
cd ts-sdks/docs
npm install
npm run dev      # http://localhost:4321, with live reload but no search
npm run build && npm run preview   # the built site, with search
```

Pages are in `src/content/docs`, the sidebar is in `astro.config.mjs`, and the OctaP styling is in `src/styles/octap.css`.

If code blocks lose their styling after a change to `astro.config.mjs`, delete `.astro`, `dist` and `node_modules/.astro`, then build again. The build reuses cached pages that point at the old stylesheet.

When an SDK method or contract changes, update its page under `src/content/docs/reference` in the same pull request.
