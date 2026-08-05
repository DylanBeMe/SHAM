exports.activate = ({ data, settings, log }) => {
  log('Site Notes activated');
  return {
    api: {
      async summary() {
        const rows = await data.all('SELECT id, name, runtime_type, port, enabled FROM sites ORDER BY name COLLATE NOCASE');
        return {
          heading: settings.get('heading', 'Site inventory'),
          showPorts: settings.get('showPorts', true),
          sites: rows.map((site) => ({ ...site, enabled: Boolean(site.enabled) }))
        };
      }
    },
    onSettingsChanged(values) {
      log(`Settings changed: ${Object.keys(values).join(', ')}`);
    },
    deactivate() {
      log('Site Notes deactivated');
    }
  };
};
