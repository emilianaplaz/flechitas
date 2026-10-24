import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { expandShortUrl } from './api/expand.ts';

// HTTPS (self-signed) so phones on the same Wi-Fi can use camera + GPS during dev.
// The dev middleware mirrors the /api/expand Vercel function.
export default defineConfig({
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
});
