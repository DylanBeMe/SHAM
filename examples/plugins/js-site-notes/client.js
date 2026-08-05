window.SHAM.registerPlugin({
  id: 'site-notes',
  name: 'Site Notes',
  dashboardCards: [
    {
      async render(container, context) {
        const summary = await context.api('/api/plugins/site-notes/actions/summary');
        container.innerHTML = '<span>JavaScript plugin</span><strong>' + summary.sites.length + '</strong><small>sites read from SHAM data</small>';
      }
    }
  ],
  pages: [
    {
      id: 'inventory',
      title: 'Site Notes',
      description: 'A plugin-owned page backed by a server-side plugin action.',
      async render(container, context) {
        const summary = await context.api('/api/plugins/site-notes/actions/summary');
        const rows = summary.sites.map((site) => '<tr><td>' + escapeText(site.name) + '</td><td>' + escapeText(site.runtime_type) + '</td><td>' + (summary.showPorts ? site.port : 'Hidden') + '</td><td>' + (site.enabled ? 'Enabled' : 'Disabled') + '</td></tr>').join('');
        container.innerHTML = '<h2>' + escapeText(summary.heading) + '</h2><div class="table-wrap"><table><thead><tr><th>Site</th><th>Runtime</th><th>Port</th><th>State</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      }
    }
  ]
});

function escapeText(value) {
  return String(value ?? '').replace(/[&<>\"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[character]));
}
