# Third-party notices

PE Studio's original source code is licensed under [MIT](LICENSE). Third-party code, packages and brand assets retain their respective licenses and rights.

| Component | Scope in this repository | License / notice |
| --- | --- | --- |
| shadcn/ui | `components/ui/`, `hooks/use-mobile.ts`, `vendor/shadcn-tailwind-4.13.0.css` | MIT; preserve [the bundled shadcn license](vendor/shadcn-tailwind-4.13.0.LICENSE.md). |
| OpenAI Sites Vite plugin | `build/sites-vite-plugin.ts` (locally adapted) | MIT; preserve [the upstream license](build/sites-vite-plugin.LICENSE). |
| npm dependencies | Dependencies declared in `package.json` and `package-lock.json` | Each dependency retains its own license and notices. Dependencies are installed separately, not vendored as `node_modules`. |
| OpenAI, Claude and Gemini brand marks | `public/brands/` | Identification only; see [asset sources and brand guidance](docs/brand-assets.md). These third-party marks are not relicensed under this project's MIT license and do not imply endorsement. |

The local Agent bridges invoke tools already installed by the user. This source repository does not redistribute Codex, Claude Code, pi, Hermes, their model weights, accounts or credentials.
