# codecs/

Optional, bench-only. Drop ChirpStack JS payload codecs here to have the provisioner attach them
to device profiles (best-effort). `*.js` files are git-ignored.

The provisioner mounts whatever `CODECS_DIR` points at (default: this directory). To reuse a codec
set from elsewhere — e.g. `../intelligent-farming-hub/codecs/` — set `CODECS_DIR` in `.env` instead
of copying files here. An empty or missing directory just makes the attach step a no-op.
