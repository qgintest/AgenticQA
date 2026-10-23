# Third-party notices

This repository's own code (`automation/`, `agents/`, `.github/`, `docs/`, scripts) is licensed under
the MIT License in [`LICENSE`](LICENSE).

| Component | Source | License |
|---|---|---|
| `aut/` (application under test) | Scaffolded from Medusa's [`dtc-starter`](https://github.com/medusajs/dtc-starter) with [`create-medusa-app`](https://github.com/medusajs/medusa), plus local Docker and configuration changes listed in [`docs/versions.md`](docs/versions.md) | MIT, Copyright (c) 2022 Medusa: see [`aut/LICENSE`](aut/LICENSE) |

Dependencies installed through npm/pnpm and the Docker base images (Node.js, PostgreSQL, Redis)
are distributed under their own licenses and are not vendored in this repository.
