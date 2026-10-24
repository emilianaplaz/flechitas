import { networkInterfaces } from 'node:os';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { expandShortUrl } from './api/expand.ts';

/** This laptop's address on the local network, so a pairing QR shown at localhost points somewhere a phone can reach. */
function lanHost(): string {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
  // Home/office Wi-Fi ranges first; skip virtual adapters' 172.x where possible.
  return ips.find((ip) => ip.startsWith('192.168.')) ?? ips.find((ip) => ip.startsWith('10.')) ?? ips[0] ?? '';
}

// HTTPS (self-signed) so phones on the same Wi-Fi can use camera + GPS during dev.
// The dev middleware mirrors the /api/expand Vercel function.
export default defineConfig(({ command }) => ({
  // Only needed in dev; the published site is reached by its own https URL.
  define: { __LAN_HOST__: JSON.stringify(command === 'serve' ? lanHost() : '') },
  plugins: [
    basicSsl(),
    {
      name: 'dev-api-expand',
      configureServer(server) {
        server.middlewares.use('/api/expand', async (req, res) => {
          const target = new URL(req.url ?? '', 'http://x').searchParams.get('url') ?? '';
          const result = await expandShortUrl(target);
          res.statusCode = result.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(result.body));
        });
      },
    },
  ],
}));
