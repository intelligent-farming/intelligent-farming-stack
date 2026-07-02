# codecs/

Optional, bench-only. Drop ChirpStack JS payload codecs here to have the provisioner attach them
to device profiles (best-effort). `*.js` files are git-ignored.

In the normal workspace layout the provisioner instead reads the Hub's codec set from
`../intelligent-farming-hub/codecs/` (mounted into the provisioner container). Use this directory
only if you want to supply codecs from within this repo.
