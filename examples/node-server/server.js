const express = require('express');
const app = express();
app.get('/', (_req, res) => res.type('html').send('<h1>Hello from a SHAM Node.js site</h1><p>This process is proxied and monitored by SHAM.</p>'));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(Number(process.env.PORT), process.env.HOST || '127.0.0.1', () => {
  console.log(`Example Node server listening on ${process.env.HOST}:${process.env.PORT}`);
});
