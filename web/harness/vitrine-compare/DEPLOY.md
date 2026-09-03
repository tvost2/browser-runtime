# Deploy the side-by-side viewer → 3dviewer.mytheria.com.br

Fully static. No node process on the VM.

## 1. Build the bundle (on this machine)

```
npm run build
node web/harness/vitrine-compare/build-static.mjs
```

Produces `web/harness/vitrine-compare/dist/` (~96 MB: engine + Babylon
bundle + rewritten page + 6 sample GLBs).

## 2. Upload

```
rsync -avz --delete "web/harness/vitrine-compare/dist/" \
  mytheria@192.168.100.127:/opt/sitefactory/deploy/3dviewer/
```

## 3. Caddy

Append `dist/Caddyfile.snippet` to the VM Caddyfile:

```
3dviewer.mytheria.com.br {
	root * /opt/sitefactory/deploy/3dviewer
	file_server
	encode zstd gzip
	header /*.wasm Content-Type application/wasm
	header Cache-Control "public, max-age=3600"
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
}
```

then on the VM: `caddy reload --config /path/to/Caddyfile`

## 4. DNS

Cloudflare needs `3dviewer.mytheria.com.br` → VM public IP (A record,
proxied is fine — same as `3dcompressor`). If a `*.mytheria.com.br`
wildcard already exists, nothing to do.

## Notes

- WebGPU (left pane) needs a real GPU. Works on modern phones: Chrome
  121+ / Safari 18+. Fails on the 2014 bench desktop — that's hardware.
- Base-color textures are not yet applied in the runtime's harness path
  (left pane shows untextured geometry); Babylon side is full-material.
- To change which GLBs ship, edit `PICK` in `build-static.mjs`. Drop
  `gaia.glb` (34 MB) to cut the bundle to ~62 MB.
